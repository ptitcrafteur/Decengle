const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 9000;
const SELF_URL = process.env.SELF_URL || null; // e.g. "wss://decengle.example.com"
const PEER_BOOTSTRAPS = (process.env.PEER_BOOTSTRAPS || "").split(",").filter(Boolean);

const wss = new WebSocketServer({ port: PORT });

// ── Bootstrap's own DHT identity ───────────────────────────────
const bootstrapId = crypto.randomBytes(20).toString("hex");
console.log(`[Bootstrap] ID: ${bootstrapId}`);
console.log(`[Bootstrap] Listening on ws://0.0.0.0:${PORT}`);
if (SELF_URL) console.log(`[Bootstrap] Self URL: ${SELF_URL}`);

// ── Connected peers: Map<peerId, { ws, publicKey, joinedAt }> ──
const peers = new Map();

// ── DHT store ──────────────────────────────────────────────────
const dhtStore = new Map();

dhtStore.set(bootstrapId, {
  value: { peerId: bootstrapId, state: "idle", lastSeen: Date.now() },
  timestamp: Date.now(),
});

// ── Known bootstrap URLs (discovered from peers or config) ─────
const knownBootstraps = new Set(PEER_BOOTSTRAPS);
if (SELF_URL) knownBootstraps.add(SELF_URL);

// ── Periodic cleanup of stale DHT entries (>60s) ───────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dhtStore) {
    if (now - entry.timestamp > 60000) {
      dhtStore.delete(key);
    }
  }
}, 15000);

// ── Bootstrap-to-bootstrap peering ─────────────────────────────
const bootstrapPeers = new Map(); // url -> ws

function connectToBootstrapPeer(url) {
  if (!url || url === SELF_URL) return;
  if (bootstrapPeers.has(url)) return;

  console.log(`[Bootstrap] Connecting to peer bootstrap: ${url}`);
  const peerWs = new WebSocket(url);
  bootstrapPeers.set(url, peerWs);

  peerWs.on("open", () => {
    console.log(`[Bootstrap] Connected to peer bootstrap: ${url}`);
    // Announce ourselves as a bootstrap
    peerWs.send(JSON.stringify({
      type: "join",
      peerId: bootstrapId,
      publicKey: "",
      isBootstrap: true,
      bootstrapUrl: SELF_URL,
    }));

    // Share our known bootstrap list
    peerWs.send(JSON.stringify({
      type: "bootstrap-share",
      urls: Array.from(knownBootstraps),
    }));

    // Share our DHT snapshot
    const entries = [];
    for (const [key, entry] of dhtStore) {
      entries.push({ key, value: entry.value, timestamp: entry.timestamp });
    }
    peerWs.send(JSON.stringify({ type: "dht-sync", entries }));
  });

  peerWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Import DHT data from peer bootstrap
    if (msg.type === "dht-snapshot" || msg.type === "dht-sync") {
      if (msg.entries) {
        for (const entry of msg.entries) {
          const existing = dhtStore.get(entry.key);
          if (!existing || existing.timestamp < entry.timestamp) {
            dhtStore.set(entry.key, { value: entry.value, timestamp: entry.timestamp });
          }
        }
        console.log(`[Bootstrap] Synced ${msg.entries.length} DHT entries from ${url}`);
      }
    }

    // Learn about other bootstraps
    if (msg.type === "bootstrap-share" || msg.type === "bootstrap-list") {
      if (msg.urls) {
        for (const u of msg.urls) {
          if (u && u !== SELF_URL && !knownBootstraps.has(u)) {
            knownBootstraps.add(u);
            connectToBootstrapPeer(u);
          }
        }
      }
    }
  });

  peerWs.on("close", () => {
    bootstrapPeers.delete(url);
    // Retry after 30s
    setTimeout(() => connectToBootstrapPeer(url), 30000);
  });

  peerWs.on("error", () => {
    bootstrapPeers.delete(url);
    setTimeout(() => connectToBootstrapPeer(url), 30000);
  });
}

// Connect to configured peer bootstraps on startup
for (const url of PEER_BOOTSTRAPS) {
  connectToBootstrapPeer(url);
}

// Periodically sync DHT with peer bootstraps
setInterval(() => {
  const entries = [];
  for (const [key, entry] of dhtStore) {
    entries.push({ key, value: entry.value, timestamp: entry.timestamp });
  }
  const syncMsg = JSON.stringify({ type: "dht-sync", entries });
  for (const [url, peerWs] of bootstrapPeers) {
    if (peerWs.readyState === WebSocket.OPEN) {
      peerWs.send(syncMsg);
    }
  }
}, 20000);

// ── Client connections ─────────────────────────────────────────
wss.on("connection", (ws) => {
  let peerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "join": {
        peerId = msg.peerId;
        peers.set(peerId, {
          ws,
          publicKey: msg.publicKey,
          joinedAt: Date.now(),
        });
        console.log(`[+] ${peerId.slice(0, 12)}… joined (${peers.size} peers)`);

        // If this is another bootstrap announcing itself, track it
        if (msg.isBootstrap && msg.bootstrapUrl) {
          knownBootstraps.add(msg.bootstrapUrl);
          connectToBootstrapPeer(msg.bootstrapUrl);
        }

        dhtStore.set(peerId, {
          value: {
            peerId,
            publicKey: msg.publicKey,
            state: "idle",
            lastSeen: Date.now(),
          },
          timestamp: Date.now(),
        });

        // Send peer list
        const peerList = [];
        for (const [id, p] of peers) {
          if (id !== peerId) peerList.push({ peerId: id, publicKey: p.publicKey });
        }
        ws.send(JSON.stringify({ type: "peers", peers: peerList }));

        // Send DHT snapshot
        const dhtSnapshot = [];
        for (const [key, entry] of dhtStore) {
          dhtSnapshot.push({ key, value: entry.value, timestamp: entry.timestamp });
        }
        ws.send(JSON.stringify({ type: "dht-snapshot", entries: dhtSnapshot }));

        // Send known bootstrap list so client can cache them
        ws.send(JSON.stringify({
          type: "bootstrap-list",
          urls: Array.from(knownBootstraps),
        }));

        // Announce to other peers
        broadcast(peerId, JSON.stringify({
          type: "peer-joined",
          peerId,
          publicKey: msg.publicKey,
        }));
        break;
      }

      case "dht-store": {
        if (msg.key && msg.value !== undefined) {
          dhtStore.set(msg.key, {
            value: msg.value,
            timestamp: msg.timestamp || Date.now(),
          });
        }
        break;
      }

      case "dht-get": {
        const entry = dhtStore.get(msg.key);
        ws.send(JSON.stringify({
          type: "dht-result",
          reqId: msg.reqId,
          key: msg.key,
          value: entry ? entry.value : null,
        }));
        break;
      }

      // Client sharing bootstrap URLs it knows
      case "bootstrap-share": {
        if (msg.urls) {
          for (const u of msg.urls) {
            if (u && u !== SELF_URL && !knownBootstraps.has(u)) {
              knownBootstraps.add(u);
              connectToBootstrapPeer(u);
            }
          }
        }
        break;
      }

      case "signal": {
        const target = peers.get(msg.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({
            type: "signal",
            from: peerId,
            data: msg.data,
          }));
        }
        break;
      }

      case "leave": {
        removePeer(peerId);
        break;
      }
    }
  });

  ws.on("close", () => removePeer(peerId));
  ws.on("error", () => removePeer(peerId));
});

function removePeer(id) {
  if (!id || !peers.has(id)) return;
  peers.delete(id);
  dhtStore.delete(id);
  console.log(`[-] ${id.slice(0, 12)}… left (${peers.size} peers)`);
  broadcast(id, JSON.stringify({ type: "peer-left", peerId: id }));
}

function broadcast(excludeId, data) {
  for (const [id, p] of peers) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}