// app.js — Main entry point, wires everything together
// TODO(robustness): Add global error handler (window.onerror / unhandledrejection) to show user-friendly errors
// TODO(ux): Add a "text-only mode" option for users who don't want to share video

document.addEventListener("DOMContentLoaded", function () {

// ── Configuration ──────────────────────────────────────────────
const DEFAULT_BOOTSTRAPS = [
  "ws://localhost:9000",
];

// ── Bootstrap list management (localStorage) ──────────────────
function loadBootstrapUrls() {
  const saved = localStorage.getItem("decengle_bootstraps");
  const custom = saved ? JSON.parse(saved) : [];
  // User custom URLs first, then defaults (deduped)
  const all = [...custom];
  for (const url of DEFAULT_BOOTSTRAPS) {
    if (!all.includes(url)) all.push(url);
  }
  return all;
}

function saveCustomBootstrap(url) {
  const saved = localStorage.getItem("decengle_bootstraps");
  const list = saved ? JSON.parse(saved) : [];
  if (!list.includes(url)) {
    list.push(url);
    localStorage.setItem("decengle_bootstraps", JSON.stringify(list));
  }
}

function removeCustomBootstrap(url) {
  const saved = localStorage.getItem("decengle_bootstraps");
  if (!saved) return;
  const list = JSON.parse(saved).filter((u) => u !== url);
  localStorage.setItem("decengle_bootstraps", JSON.stringify(list));
}

// Save bootstrap URLs discovered from the network
function learnBootstrapUrl(url) {
  if (!url || DEFAULT_BOOTSTRAPS.includes(url)) return;
  // TODO(robustness): Validate URL format and test reachability before saving
  // TODO(robustness): Expire bootstrap URLs that have been unreachable for N days
  saveCustomBootstrap(url);
}

// ── DOM Elements ───────────────────────────────────────────────
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const waitingOverlay = document.getElementById("waiting-overlay");
const btnStart = document.getElementById("btn-start");
const btnNext = document.getElementById("btn-next");
const btnStop = document.getElementById("btn-stop");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const peerCountEl = document.getElementById("peer-count");
const statusEl = document.getElementById("connection-status");
const bootstrapInput = document.getElementById("bootstrap-input");
const btnAddBootstrap = document.getElementById("btn-add-bootstrap");
const bootstrapList = document.getElementById("bootstrap-list");

// ── Services ───────────────────────────────────────────────────
let localStream = null;
let peerId = null;
let publicKeyHex = null;
let privateKey = null; // ECDH private key for E2EE
let ws = null;
let isRunning = false;
let reconnectDelay = 2000;
let reconnectTimer = null;

const webrtcManager = new Decengle.WebRTCManager();
const localState = new Decengle.LocalState();
let dht = null;
let matching = null;
let chat = null;

// ── Bootstrap UI ───────────────────────────────────────────────
function renderBootstrapList() {
  if (!bootstrapList) return;
  bootstrapList.innerHTML = "";
  const urls = loadBootstrapUrls();
  for (const url of urls) {
    const li = document.createElement("li");
    li.textContent = url;
    if (!DEFAULT_BOOTSTRAPS.includes(url)) {
      const btn = document.createElement("button");
      btn.textContent = "x";
      btn.className = "btn-remove-bootstrap";
      btn.addEventListener("click", () => {
        removeCustomBootstrap(url);
        renderBootstrapList();
      });
      li.appendChild(btn);
    }
    bootstrapList.appendChild(li);
  }
}

if (btnAddBootstrap) {
  btnAddBootstrap.addEventListener("click", () => {
    const url = bootstrapInput.value.trim();
    if (url && (url.startsWith("ws://") || url.startsWith("wss://"))) {
      saveCustomBootstrap(url);
      bootstrapInput.value = "";
      renderBootstrapList();
    }
  });
}

renderBootstrapList();

// ── Initialize ─────────────────────────────────────────────────
async function init() {
  const keyPair = await Decengle.generateKeyPair();
  publicKeyHex = await Decengle.exportPublicKey(keyPair.publicKey);
  privateKey = keyPair.privateKey || null;
  peerId = await Decengle.generatePeerId(publicKeyHex);
  console.log("[Decengle] My peer ID:", peerId);

  dht = new Decengle.DHTNode(peerId, webrtcManager);

  dht.onStore = (key, value, timestamp) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "dht-store", key, value, timestamp }));
    }
  };

  dht.onRelayedSignal = (fromPeerId, signalData) => {
    webrtcManager.handleSignal(fromPeerId, signalData, (targetId, data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "signal", to: targetId, data }));
      } else {
        dht.relaySignal(targetId, data);
      }
    });
  };

  matching = new Decengle.MatchingService(dht, localState);
  chat = new Decengle.Chat(dht);

  dht.onAppMessage = (fromId, msg) => {
    if (!msg || msg._dht) return;

    switch (msg.type) {
      case "match-request":
        matching.handleMatchRequest(fromId);
        break;
      case "match-accept":
        onMatchEstablished(fromId);
        break;
      case "match-decline":
        break;
      case "match-ended":
        matching.handleMatchEnded(fromId);
        onMatchEnded(fromId);
        break;
      case "chat-message":
        chat.handleIncoming(fromId, msg);
        break;
      case "bootstrap-announce":
        // Another peer is sharing bootstrap URLs they know about
        if (msg.urls && Array.isArray(msg.urls)) {
          for (const url of msg.urls) learnBootstrapUrl(url);
          renderBootstrapList();
        }
        break;
    }
  };

  matching.onMatchFound = (matchedPeerId) => {
    onMatchEstablished(matchedPeerId);
  };

  matching.onMatchEnded = (matchedPeerId) => {
    onMatchEnded(matchedPeerId);
  };

  chat.onNewMessage = (msg) => {
    appendChatMessage(msg);
  };

  webrtcManager.onPeerStream = (fromId, stream) => {
    if (matching.currentMatch === fromId) {
      remoteVideo.srcObject = stream;
    }
  };

  setInterval(updatePeerCount, 3000);

  localState.onChange((state) => {
    updateStatusUI(state.status);
  });
}

// ── Bootstrap connection ───────────────────────────────────────
function connectToBootstrap() {
  const BOOTSTRAP_URLS = loadBootstrapUrls();

  return new Promise((resolve, reject) => {
    let index = 0;

    function tryNext() {
      if (index >= BOOTSTRAP_URLS.length) {
        reject(new Error("All bootstrap nodes unreachable"));
        return;
      }

      const url = BOOTSTRAP_URLS[index];
      console.log(`[Decengle] Trying bootstrap ${url}...`);
      index++;

      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        tryNext();
      }, 5000);

      socket.onopen = () => {
        clearTimeout(timeout);
        ws = socket;
        console.log(`[Decengle] Connected to bootstrap ${url}`);

        ws.send(
          JSON.stringify({
            type: "join",
            peerId,
            publicKey: publicKeyHex,
          })
        );
        resolve();
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "peers":
            for (const peer of msg.peers) {
              connectToPeer(peer.peerId, true);
            }
            break;

          case "dht-snapshot":
            if (dht && msg.entries) {
              for (const entry of msg.entries) {
                dht.store.set(entry.key, {
                  value: entry.value,
                  timestamp: entry.timestamp,
                });
              }
              console.log(`[Decengle] Imported ${msg.entries.length} DHT entries from bootstrap`);
            }
            break;

          case "bootstrap-list":
            // Bootstrap is sharing other known bootstraps
            if (msg.urls && Array.isArray(msg.urls)) {
              for (const u of msg.urls) learnBootstrapUrl(u);
              renderBootstrapList();
            }
            break;

          case "peer-joined":
            connectToPeer(msg.peerId, false);
            break;

          case "peer-left":
            webrtcManager.closeConnection(msg.peerId);
            break;

          case "signal":
            webrtcManager.handleSignal(msg.from, msg.data, (targetId, data) => {
              ws.send(JSON.stringify({ type: "signal", to: targetId, data }));
            });
            break;
        }
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        tryNext();
      };

      socket.onclose = () => {
        if (ws === socket) {
          console.log("[Decengle] Bootstrap connection closed");
          ws = null;
          scheduleBootstrapReconnect();
        }
      };
    }

    tryNext();
  });
}

function scheduleBootstrapReconnect() {
  if (!isRunning) return;
  if (reconnectTimer) return;

  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  console.log(`[Decengle] Bootstrap down. Retrying in ${reconnectDelay / 1000}s...`);
  peerCountEl.title = "Bootstrap offline — using P2P relay";

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isRunning) return;
    connectToBootstrap()
      .then(() => {
        reconnectDelay = 2000;
        console.log("[Decengle] Reconnected to bootstrap");
        peerCountEl.title = "";
      })
      .catch(() => scheduleBootstrapReconnect());
  }, reconnectDelay);
}

function connectToPeer(remotePeerId, isInitiator) {
  const signalFn = (targetId, data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", to: targetId, data }));
    } else if (dht) {
      dht.relaySignal(targetId, data);
    }
  };

  const conn = webrtcManager.createConnection(remotePeerId, isInitiator, signalFn);
  if (isInitiator) conn.createOffer();
  return conn;
}

// ── Match lifecycle ────────────────────────────────────────────
async function onMatchEstablished(matchedPeerId) {
  console.log("[Decengle] Matched with:", matchedPeerId);

  // Look up their public key from DHT for E2EE
  let remotePublicKeyHex = null;
  const dhtEntry = dht.store.get(matchedPeerId);
  if (dhtEntry && dhtEntry.value && dhtEntry.value.publicKey) {
    remotePublicKeyHex = dhtEntry.value.publicKey;
  }

  // Set up E2EE chat
  await chat.setPartner(matchedPeerId, privateKey, remotePublicKeyHex);

  // TODO(security): Verify remote peer's identity (public key fingerprint confirmation, e.g. show emoji hash)
  // TODO(ux): Show connection quality indicator (ping latency, packet loss via WebRTC stats API)

  if (localStream) {
    const conn = webrtcManager.connections.get(matchedPeerId);
    if (conn) {
      conn.addStream(localStream);
      conn.createOffer();
    }
  }

  waitingOverlay.style.display = "none";
  btnNext.disabled = false;
  chatInput.disabled = false;
  btnSend.disabled = false;
  chatMessages.innerHTML = "";
  appendSystemMessage(
    chat.sharedKey
      ? "Connected to a stranger! (E2EE active)"
      : "Connected to a stranger! (unencrypted)"
  );
}

function onMatchEnded(matchedPeerId) {
  console.log("[Decengle] Match ended with:", matchedPeerId);
  remoteVideo.srcObject = null;
  chat.clear();

  waitingOverlay.style.display = "flex";
  chatInput.disabled = true;
  btnSend.disabled = true;
  chatMessages.innerHTML = "";
  appendSystemMessage("Stranger disconnected.");
}

// ── Media ──────────────────────────────────────────────────────
async function startLocalStream() {
  // TODO(ux): Handle getUserMedia errors gracefully (camera in use, permission denied) with specific messages
  // TODO(ux): Let users pick video/audio constraints (resolution, frame rate)
  // TODO(ux): Support screen sharing as an alternative to camera
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
}

// ── UI Helpers ─────────────────────────────────────────────────
function appendChatMessage(msg) {
  const div = document.createElement("div");
  div.classList.add("chat-msg", msg.isMine ? "mine" : "theirs");
  div.textContent = msg.text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.classList.add("chat-msg", "system");
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updatePeerCount() {
  const count = webrtcManager.getConnectedPeers().length;
  peerCountEl.textContent = `${count} peer${count !== 1 ? "s" : ""}`;
}

function updateStatusUI(status) {
  statusEl.className = "";
  switch (status) {
    case Decengle.STATE.IDLE:
      statusEl.textContent = "Idle";
      statusEl.classList.add("status-idle");
      break;
    case Decengle.STATE.SEARCH:
      statusEl.textContent = "Searching...";
      statusEl.classList.add("status-search");
      break;
    case Decengle.STATE.BUSY:
      statusEl.textContent = "Connected";
      statusEl.classList.add("status-busy");
      break;
  }
}

// ── Event Listeners ────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  try {
    btnStart.disabled = true;
    btnStart.textContent = "Connecting...";
    isRunning = true;
    reconnectDelay = 2000;

    await startLocalStream();
    await connectToBootstrap();
    await new Promise((r) => setTimeout(r, 1500));

    btnStop.disabled = false;
    btnNext.disabled = false;
    btnStart.style.display = "none";

    matching.startSearching();
    waitingOverlay.style.display = "flex";
    appendSystemMessage("Looking for someone to chat with...");
  } catch (err) {
    console.error("[Decengle] Start error:", err);
    btnStart.disabled = false;
    btnStart.textContent = "Start";
    // TODO(ux): Show more specific error messages ("Camera access denied", "No bootstrap available", etc.)
    // TODO(robustness): Clean up partial state (stop localStream if bootstrap fails)
    appendSystemMessage("Failed to connect. Try again.");
  }
});

btnNext.addEventListener("click", () => {
  matching.next();
  remoteVideo.srcObject = null;
  chatMessages.innerHTML = "";
  waitingOverlay.style.display = "flex";
  chatInput.disabled = true;
  btnSend.disabled = true;
  appendSystemMessage("Looking for someone to chat with...");
});

btnStop.addEventListener("click", () => {
  isRunning = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  matching.stop();
  remoteVideo.srcObject = null;

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  webrtcManager.closeAll();
  if (ws) ws.close();

  btnStart.style.display = "";
  btnStart.disabled = false;
  btnStart.textContent = "Start";
  btnStop.disabled = true;
  btnNext.disabled = true;
  chatInput.disabled = true;
  btnSend.disabled = true;
  chatMessages.innerHTML = "";
  waitingOverlay.style.display = "flex";
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value;
  // TODO(security): Sanitize chat input to prevent XSS if rendering ever changes from textContent
  // TODO(ux): Add message length limit with visual feedback
  if (text.trim()) {
    chat.send(text);
    chatInput.value = "";
  }
});

// ── Boot ───────────────────────────────────────────────────────
// TODO(networking): Support running without any bootstrap (pure manual peer exchange via QR code / link)
// TODO(ux): Add "connection stats" debug panel (WebRTC stats, DHT routing table size, etc.)
init();

}); // end DOMContentLoaded