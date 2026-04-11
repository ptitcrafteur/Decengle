// dht.js — Kademlia-inspired DHT running on WebRTC data channels
// Uses bootstrap WebSocket for initial peer discovery, then operates
// entirely over the WebRTC mesh.
// TODO(networking): Implement iterative lookups — recursively query closer peers instead of only K nearest
// TODO(networking): Add alpha parameter (parallel lookups) for faster convergence per Kademlia spec
// TODO(networking): Add value republishing — periodically re-store values so they survive beyond 60s TTL
// TODO(security): Verify that peer IDs match the SHA-256 hash of the claimed public key

window.Decengle = window.Decengle || {};

const K = 8; // Max bucket size (Kademlia k-parameter)
const ID_BITS = 160; // 20 bytes = 160 bits

class DHTNode {
  constructor(peerId, webrtcManager) {
    this.peerId = peerId;
    this.webrtc = webrtcManager;
    // Routing table: array of K-buckets (one per bit)
    this.buckets = Array.from({ length: ID_BITS }, () => []);
    // DHT storage: key -> { value, timestamp }
    this.store = new Map();
    // Known peers metadata: peerId -> { publicKey, lastSeen }
    this.peerInfo = new Map();

    // Listen for DHT messages from connected peers
    this.webrtc.onPeerMessage = (fromId, msg) => {
      if (msg && msg._dht) {
        this._handleDHTMessage(fromId, msg);
      }
      // Non-DHT messages are forwarded via the external handler
      if (this.onAppMessage) this.onAppMessage(fromId, msg);
    };

    this.webrtc.onPeerConnected = (peerId) => {
      this._addToRoutingTable(peerId);
      if (this.onPeerConnected) this.onPeerConnected(peerId);
    };

    this.webrtc.onPeerDisconnected = (peerId) => {
      this._removeFromRoutingTable(peerId);
      if (this.onPeerDisconnected) this.onPeerDisconnected(peerId);
    };

    // External handlers
    this.onAppMessage = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onStore = null; // called on every put() — allows syncing to bootstrap
  }

  // Determine which bucket a peer belongs to based on XOR distance
  _bucketIndex(peerId) {
    const dist = Decengle.xorDistance(this.peerId, peerId);
    // Find the index of the first set bit
    for (let i = 0; i < dist.length; i += 2) {
      const byte = parseInt(dist.substring(i, i + 2), 16);
      if (byte === 0) continue;
      const bitPos = (i / 2) * 8 + Math.clz32(byte) - 24;
      return ID_BITS - 1 - bitPos;
    }
    return 0; // Same ID (should not happen)
  }

  _addToRoutingTable(peerId) {
    if (peerId === this.peerId) return;
    const idx = this._bucketIndex(peerId);
    const bucket = this.buckets[idx];

    // If already in bucket, move to end (most recently seen)
    const existing = bucket.indexOf(peerId);
    if (existing !== -1) {
      bucket.splice(existing, 1);
      bucket.push(peerId);
      return;
    }

    if (bucket.length < K) {
      bucket.push(peerId);
    } else {
      // Bucket full — evict oldest if it's unresponsive
      // TODO(networking): Ping the oldest peer before evicting — only evict if unresponsive (proper Kademlia)
      // For simplicity, just replace the oldest
      bucket.shift();
      bucket.push(peerId);
    }
  }

  _removeFromRoutingTable(peerId) {
    const idx = this._bucketIndex(peerId);
    const bucket = this.buckets[idx];
    const pos = bucket.indexOf(peerId);
    if (pos !== -1) bucket.splice(pos, 1);
  }

  // Find the K closest peers to a target ID from our routing table
  findClosest(targetId, count = K) {
    const allPeers = [];
    for (const bucket of this.buckets) {
      for (const id of bucket) {
        allPeers.push(id);
      }
    }
    allPeers.sort((a, b) => {
      const dA = Decengle.xorDistance(a, targetId);
      const dB = Decengle.xorDistance(b, targetId);
      return Decengle.compareDistance(dA, dB);
    });
    return allPeers.slice(0, count);
  }

  // Store a value in the DHT
  put(key, value) {
    // TODO(security): Validate key format (must be valid 40-char hex)
    // TODO(security): Enforce max value size to prevent peers from storing huge payloads
    const timestamp = Date.now();
    this.store.set(key, { value, timestamp });

    // Notify external listener (e.g. sync to bootstrap)
    if (this.onStore) this.onStore(key, value, timestamp);

    // Replicate to closest peers
    const closest = this.findClosest(key);
    for (const peerId of closest) {
      this.webrtc.send(peerId, {
        _dht: true,
        action: "store",
        key,
        value,
        timestamp: Date.now(),
      });
    }
  }

  // Look up a value in the DHT
  async get(key, timeout = 5000) {
    // Check local store first
    const local = this.store.get(key);
    if (local) return local.value;

    // TODO(networking): Implement iterative lookup — when a peer returns find_node_reply,
    //   query the returned closer peers until convergence (standard Kademlia FIND_VALUE)
    // Ask closest peers
    return new Promise((resolve) => {
      const closest = this.findClosest(key);
      if (closest.length === 0) {
        resolve(null);
        return;
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, timeout);

      const reqId = Math.random().toString(36).substring(2);
      this._pendingGets = this._pendingGets || new Map();
      this._pendingGets.set(reqId, (value) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(value);
        }
      });

      for (const peerId of closest) {
        this.webrtc.send(peerId, {
          _dht: true,
          action: "find_value",
          key,
          reqId,
        });
      }
    });
  }

  // Announce this peer's presence in the DHT (store our info under our ID)
  announce(peerData) {
    this.put(this.peerId, {
      ...peerData,
      peerId: this.peerId,
      lastSeen: Date.now(),
    });
  }

  // Find peers that are searching for a match
  async findSearchingPeers() {
    // TODO(networking): Also query remote peers (find_value) instead of only searching local store
    //   This would let matching work even if the local DHT is sparse
    const searchers = [];
    // Check local store for peers with state "search"
    for (const [key, entry] of this.store) {
      if (
        entry.value &&
        entry.value.state === "search" &&
        entry.value.peerId !== this.peerId &&
        Date.now() - entry.value.lastSeen < 30000
      ) {
        searchers.push(entry.value);
      }
    }
    return searchers;
  }

  _handleDHTMessage(fromId, msg) {
    switch (msg.action) {
      case "store": {
        this.store.set(msg.key, {
          value: msg.value,
          timestamp: msg.timestamp,
        });
        break;
      }

      case "find_value": {
        const entry = this.store.get(msg.key);
        if (entry) {
          this.webrtc.send(fromId, {
            _dht: true,
            action: "found_value",
            reqId: msg.reqId,
            key: msg.key,
            value: entry.value,
          });
        } else {
          // Return closest peers we know of
          const closest = this.findClosest(msg.key);
          this.webrtc.send(fromId, {
            _dht: true,
            action: "find_node_reply",
            reqId: msg.reqId,
            peers: closest,
          });
        }
        break;
      }

      case "found_value": {
        if (this._pendingGets && this._pendingGets.has(msg.reqId)) {
          this._pendingGets.get(msg.reqId)(msg.value);
          this._pendingGets.delete(msg.reqId);
        }
        break;
      }

      case "find_node": {
        const closest = this.findClosest(msg.targetId);
        this.webrtc.send(fromId, {
          _dht: true,
          action: "find_node_reply",
          reqId: msg.reqId,
          peers: closest,
        });
        break;
      }

      case "find_node_reply": {
        // Could be used to iteratively discover more peers
        // For now, add them to our routing table
        if (msg.peers) {
          for (const id of msg.peers) {
            this._addToRoutingTable(id);
          }
        }
        break;
      }

      // Relay signaling for peers not directly connected
      case "relay_signal": {
        const target = msg.targetPeerId;
        if (this.webrtc.connections.has(target)) {
          this.webrtc.send(target, {
            _dht: true,
            action: "relayed_signal",
            fromPeerId: msg.fromPeerId,
            signalData: msg.signalData,
          });
        }
        break;
      }

      case "relayed_signal": {
        if (this.onRelayedSignal) {
          this.onRelayedSignal(msg.fromPeerId, msg.signalData);
        }
        break;
      }
    }
  }

  // Get count of connected peers
  getPeerCount() {
    return this.webrtc.getConnectedPeers().length;
  }

  // Send a message to a specific peer (app-level, not DHT)
  sendTo(peerId, data) {
    this.webrtc.send(peerId, data);
  }

  // Broadcast to all connected peers (app-level)
  broadcastApp(data) {
    this.webrtc.broadcast(data);
  }

  // Relay WebRTC signaling data to a peer we may not be directly connected to.
  // Finds the closest connected peer to the target and asks them to forward it.
  relaySignal(targetPeerId, signalData) {
    const connected = this.webrtc.getConnectedPeers();
    if (connected.length === 0) return;

    // Pick the connected peer with smallest XOR distance to target
    const relay = connected.reduce((best, id) => {
      if (!best) return id;
      const dBest = Decengle.xorDistance(best, targetPeerId);
      const dCur  = Decengle.xorDistance(id,   targetPeerId);
      return Decengle.compareDistance(dCur, dBest) < 0 ? id : best;
    }, null);

    if (relay) {
      this.webrtc.send(relay, {
        _dht: true,
        action: "relay_signal",
        targetPeerId,
        fromPeerId: this.peerId,
        signalData,
      });
    }
  }
}

Decengle.DHTNode = DHTNode;
