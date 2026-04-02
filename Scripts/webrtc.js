// webrtc.js — WebRTC connection manager
// Manages peer connections (data channels + media streams)

window.Decengle = window.Decengle || {};

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

class PeerConnection {
  constructor(remotePeerId, isInitiator, onSignal) {
    this.remotePeerId = remotePeerId;
    this.isInitiator = isInitiator;
    this.onSignal = onSignal; // callback to send signaling data
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.dataChannel = null;
    this.onMessage = null; // callback for incoming data channel messages
    this.onClose = null;
    this.onStream = null; // callback for incoming media stream
    this.localStream = null;
    this._closed = false;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.onSignal({
          type: "ice",
          candidate: e.candidate,
        });
      }
    };

    this.pc.ontrack = (e) => {
      if (this.onStream) this.onStream(e.streams[0]);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.close();
      }
    };

    if (isInitiator) {
      this.dataChannel = this.pc.createDataChannel("decengle", {
        ordered: true,
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  _setupDataChannel(dc) {
    dc.onopen = () => {
      // Data channel ready
    };
    dc.onmessage = (e) => {
      if (this.onMessage) {
        try {
          this.onMessage(JSON.parse(e.data));
        } catch {
          this.onMessage(e.data);
        }
      }
    };
    dc.onclose = () => {
      this.close();
    };
  }

  async createOffer() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.onSignal({ type: "offer", sdp: offer });
    } catch (e) {
      console.warn("[WebRTC] createOffer failed:", e.message);
    }
  }

  async handleOffer(offer) {
    const state = this.pc.signalingState;
    if (state === "have-local-offer") {
      // Glare: both sides sent offers. The "polite" peer (non-initiator)
      // rolls back and accepts the incoming offer. The "impolite" peer
      // (initiator) ignores the incoming offer.
      if (this.isInitiator) {
        // We are impolite — ignore the incoming offer
        return;
      }
      // We are polite — rollback our offer and accept theirs
      await this.pc.setLocalDescription({ type: "rollback" });
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.onSignal({ type: "answer", sdp: answer });
  }

  async handleAnswer(answer) {
    if (this.pc.signalingState !== "have-local-offer") {
      // Not expecting an answer — ignore
      return;
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleIce(candidate) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // ICE candidate error — ignore
    }
  }

  async handleSignal(data) {
    try {
      switch (data.type) {
        case "offer":
          await this.handleOffer(data.sdp);
          break;
        case "answer":
          await this.handleAnswer(data.sdp);
          break;
        case "ice":
          await this.handleIce(data.candidate);
          break;
      }
    } catch (e) {
      console.warn("[WebRTC] handleSignal error:", e.message);
    }
  }

  addStream(stream) {
    this.localStream = stream;
    const existingTracks = new Set(this.pc.getSenders().map(s => s.track));
    for (const track of stream.getTracks()) {
      if (!existingTracks.has(track)) {
        this.pc.addTrack(track, stream);
      }
    }
  }

  send(data) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(
        typeof data === "string" ? data : JSON.stringify(data)
      );
    }
  }

  isOpen() {
    return (
      this.dataChannel &&
      this.dataChannel.readyState === "open" &&
      !this._closed
    );
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch {}
    }
    try { this.pc.close(); } catch {}
    if (this.onClose) this.onClose(this.remotePeerId);
  }
}

class WebRTCManager {
  constructor() {
    this.connections = new Map(); // peerId -> PeerConnection
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onPeerMessage = null;
    this.onPeerStream = null;
  }

  // signalFn: (remotePeerId, signalData) => void — how to send signal data
  createConnection(remotePeerId, isInitiator, signalFn) {
    if (this.connections.has(remotePeerId)) {
      return this.connections.get(remotePeerId);
    }

    const conn = new PeerConnection(remotePeerId, isInitiator, (data) => {
      signalFn(remotePeerId, data);
    });

    conn.onMessage = (msg) => {
      if (this.onPeerMessage) this.onPeerMessage(remotePeerId, msg);
    };

    conn.onClose = (id) => {
      this.connections.delete(id);
      if (this.onPeerDisconnected) this.onPeerDisconnected(id);
    };

    conn.onStream = (stream) => {
      if (this.onPeerStream) this.onPeerStream(remotePeerId, stream);
    };

    this.connections.set(remotePeerId, conn);
    return conn;
  }

  async handleSignal(fromPeerId, data, signalFn) {
    let conn = this.connections.get(fromPeerId);
    if (!conn) {
      // Incoming connection — we are not the initiator
      conn = this.createConnection(fromPeerId, false, signalFn);
    }
    await conn.handleSignal(data);

    // If data channel becomes open, notify
    if (conn.isOpen() && this.onPeerConnected) {
      this.onPeerConnected(fromPeerId);
    }
  }

  send(peerId, data) {
    const conn = this.connections.get(peerId);
    if (conn) conn.send(data);
  }

  broadcast(data, excludeId = null) {
    for (const [id, conn] of this.connections) {
      if (id !== excludeId && conn.isOpen()) {
        conn.send(data);
      }
    }
  }

  addStreamToConnection(peerId, stream) {
    const conn = this.connections.get(peerId);
    if (conn) conn.addStream(stream);
  }

  closeConnection(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) conn.close();
  }

  getConnectedPeers() {
    const result = [];
    for (const [id, conn] of this.connections) {
      if (conn.isOpen()) result.push(id);
    }
    return result;
  }

  closeAll() {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

Decengle.WebRTCManager = WebRTCManager;
Decengle.PeerConnection = PeerConnection;
