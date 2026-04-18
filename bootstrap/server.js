const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 9000;
const SELF_URL = process.env.SELF_URL || null; // e.g. "wss://decengle.example.com"
const PEER_BOOTSTRAPS = (process.env.PEER_BOOTSTRAPS || "").split(",").filter(Boolean);

// ── Structured logging ─────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function log(level, category, message, data) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    msg: message,
  };
  if (data !== undefined) entry.data = data;
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ── Message schema validation ──────────────────────────────────
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES, 10) || 65536; // 64 KB

const MESSAGE_SCHEMAS = {
  join: {
    required: { peerId: "string", publicKey: "string" },
    optional: { isBootstrap: "boolean", bootstrapUrl: "string" },
  },
  "dht-store": {
    required: { key: "string" },
    optional: { value: "any", timestamp: "number" },
    custom(msg) { return msg.value !== undefined; },
  },
  "dht-get": {
    required: { key: "string" },
    optional: { reqId: "any" },
  },
  "bootstrap-share": {
    required: { urls: "array" },
    custom(msg) { return Array.isArray(msg.urls) && msg.urls.every(u => typeof u === "string"); },
  },
  signal: {
    required: { to: "string", data: "any" },
  },
  leave: {},
};

function validateMessage(msg) {
  if (typeof msg !== "object" || msg === null) return "payload must be an object";
  if (typeof msg.type !== "string") return "missing or invalid 'type'";

  const schema = MESSAGE_SCHEMAS[msg.type];
  if (!schema) return `unknown message type '${msg.type}'`;

  if (schema.required) {
    for (const [field, expectedType] of Object.entries(schema.required)) {
      if (!(field in msg)) return `missing required field '${field}'`;
      if (expectedType === "any") continue;
      if (expectedType === "array") {
        if (!Array.isArray(msg[field])) return `'${field}' must be an array`;
      } else if (typeof msg[field] !== expectedType) {
        return `'${field}' must be of type ${expectedType}`;
      }
    }
  }

  if (schema.optional) {
    for (const [field, expectedType] of Object.entries(schema.optional)) {
      if (!(field in msg)) continue;
      if (expectedType === "any") continue;
      if (expectedType === "array") {
        if (!Array.isArray(msg[field])) return `'${field}' must be an array`;
      } else if (typeof msg[field] !== expectedType) {
        return `'${field}' must be of type ${expectedType}`;
      }
    }
  }

  if (schema.custom && !schema.custom(msg)) return "failed custom validation";

  return null; // valid
}

// ── Rate limiting per IP ───────────────────────────────────────
const MAX_MESSAGES_PER_SEC = parseInt(process.env.MAX_MESSAGES_PER_SEC, 10) || 30;
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 5;
const RATE_LIMIT_BAN_MS = parseInt(process.env.RATE_LIMIT_BAN_MS, 10) || 60000;

// Map<ip, { tokens, lastRefill, bannedUntil }>
const rateLimiters = new Map();
// Map<ip, number> — active connection count per IP
const connectionsPerIp = new Map();

function getRateLimiter(ip) {
  let rl = rateLimiters.get(ip);
  if (!rl) {
    rl = { tokens: MAX_MESSAGES_PER_SEC, lastRefill: Date.now(), bannedUntil: 0 };
    rateLimiters.set(ip, rl);
  }
  return rl;
}

/** Returns true if the message is allowed, false if rate-limited. */
function consumeToken(ip) {
  const rl = getRateLimiter(ip);
  const now = Date.now();

  if (now < rl.bannedUntil) return false;

  // Refill tokens based on elapsed time (token-bucket)
  const elapsed = now - rl.lastRefill;
  rl.tokens = Math.min(MAX_MESSAGES_PER_SEC, rl.tokens + (elapsed / 1000) * MAX_MESSAGES_PER_SEC);
  rl.lastRefill = now;

  if (rl.tokens < 1) {
    // Temporarily ban this IP
    rl.bannedUntil = now + RATE_LIMIT_BAN_MS;
    log("warn", "ratelimit", "IP exceeded message rate — temporarily banned", { ip, maxPerSec: MAX_MESSAGES_PER_SEC, banSec: RATE_LIMIT_BAN_MS / 1000 });
    return false;
  }

  rl.tokens -= 1;
  return true;
}

// Clean up stale rate-limiter entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rl] of rateLimiters) {
    if (now > rl.bannedUntil && rl.tokens >= MAX_MESSAGES_PER_SEC && !connectionsPerIp.has(ip)) {
      rateLimiters.delete(ip);
    }
  }
}, 120000);

const wss = new WebSocketServer({ port: PORT });

// ── Bootstrap's own DHT identity ───────────────────────────────
const bootstrapId = crypto.randomBytes(20).toString("hex");
log("info", "bootstrap", "Server starting", { id: bootstrapId, port: PORT, selfUrl: SELF_URL || null });

// ── Connected peers: Map<peerId, { ws, publicKey, joinedAt }> ──
const peers = new Map();

// ── DHT store ──────────────────────────────────────────────────
const dhtStore = new Map();
// TODO(security): Add a max size cap for dhtStore (e.g. 10,000 entries) to prevent memory exhaustion
// TODO(robustness): Persist DHT store to disk (e.g. SQLite) so data survives server restarts

dhtStore.set(bootstrapId, {
  value: { peerId: bootstrapId, state: "idle", lastSeen: Date.now() },
  timestamp: Date.now(),
});

// ── Known bootstrap URLs (discovered from peers or config) ─────
const knownBootstraps = new Set(PEER_BOOTSTRAPS);
if (SELF_URL) knownBootstraps.add(SELF_URL);

// ── Periodic cleanup of stale DHT entries (>60s) ───────────────
// TODO(networking): Make expiration time configurable via env var
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

  // TODO(security): Validate bootstrap URL format before connecting (prevent SSRF)
  // TODO(networking): Add mutual authentication between bootstrap nodes
  log("info", "federation", "Connecting to peer bootstrap", { url });
  const peerWs = new WebSocket(url);
  bootstrapPeers.set(url, peerWs);

  peerWs.on("open", () => {
    log("info", "federation", "Connected to peer bootstrap", { url });
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
        log("debug", "federation", "Synced DHT entries from peer bootstrap", { url, count: msg.entries.length });
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
wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;

  // ── Per-IP connection limit ──────────────────────────────────
  const connCount = (connectionsPerIp.get(ip) || 0) + 1;
  if (connCount > MAX_CONNECTIONS_PER_IP) {
    log("warn", "ratelimit", "IP exceeded max connections", { ip, max: MAX_CONNECTIONS_PER_IP });
    ws.close(1008, "Too many connections");
    return;
  }
  connectionsPerIp.set(ip, connCount);
  ws.on("close", () => {
    const c = (connectionsPerIp.get(ip) || 1) - 1;
    if (c <= 0) connectionsPerIp.delete(ip); else connectionsPerIp.set(ip, c);
  });

  let peerId = null;

  ws.on("message", (raw) => {
    // ── Per-IP message rate limit ────────────────────────────────
    if (!consumeToken(ip)) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    // ── Payload size limit ───────────────────────────────────────
    if (raw.length > MAX_PAYLOAD_BYTES) {
      ws.send(JSON.stringify({ type: "error", message: "Payload too large" }));
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Schema validation ────────────────────────────────────────
    const validationError = validateMessage(msg);
    if (validationError) {
      ws.send(JSON.stringify({ type: "error", message: validationError }));
      return;
    }

    switch (msg.type) {
      case "join": {
        peerId = msg.peerId;
        peers.set(peerId, {
          ws,
          publicKey: msg.publicKey,
          joinedAt: Date.now(),
        });
        log("info", "peer", "Peer joined", { peerId: peerId.slice(0, 12), totalPeers: peers.size });

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
        // TODO(security): Validate that msg.key matches the peer's actual ID to prevent impersonation
        // TODO(security): Limit value size (e.g. max 1KB) to prevent storage abuse
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
        // TODO(security): Verify that the sender (peerId) actually owns the connection sending this message
        // TODO(networking): Add TURN server relay as fallback when direct P2P fails (symmetric NAT)
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

// TODO(networking): Add health check endpoint (HTTP GET /health) for monitoring
// TODO(networking): Add clustering support (multiple workers) for higher throughput
// TODO(networking): Add WebSocket compression (permessage-deflate) for bandwidth savings
// TODO(robustness): Add metrics collection (connected peers, messages/sec, DHT size)

function removePeer(id) {
  if (!id || !peers.has(id)) return;
  peers.delete(id);
  dhtStore.delete(id);
  log("info", "peer", "Peer left", { peerId: id.slice(0, 12), totalPeers: peers.size });
  broadcast(id, JSON.stringify({ type: "peer-left", peerId: id }));
}

function broadcast(excludeId, data) {
  for (const [id, p] of peers) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown(signal) {
  log("info", "bootstrap", "Shutdown signal received, closing gracefully", { signal });

  // Stop accepting new connections
  wss.close(() => {
    log("info", "bootstrap", "WebSocket server closed");
  });

  // Close all client connections with a Going Away code
  for (const [id, p] of peers) {
    try { p.ws.close(1001, "Server shutting down"); } catch {}
  }
  peers.clear();

  // Close all bootstrap peer connections
  for (const [url, peerWs] of bootstrapPeers) {
    try { peerWs.close(1001, "Server shutting down"); } catch {}
  }
  bootstrapPeers.clear();

  // Allow a short window for close frames to be sent, then force exit
  setTimeout(() => {
    log("warn", "bootstrap", "Forcing exit after shutdown timeout");
    process.exit(1);
  }, 5000).unref();

  // If everything closed cleanly, exit 0
  setImmediate(() => {
    if (peers.size === 0 && bootstrapPeers.size === 0) {
      process.exit(0);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));