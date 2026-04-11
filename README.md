<p align="center">
  <h1 align="center">Decengle</h1>
  <p align="center">
    A fully decentralized, peer-to-peer video & text chat — meet strangers with real privacy.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/WebRTC-P2P-blue?style=flat-square" alt="WebRTC" />
  <img src="https://img.shields.io/badge/E2EE-AES--GCM--256-green?style=flat-square" alt="E2EE" />
  <img src="https://img.shields.io/badge/DHT-Kademlia-orange?style=flat-square" alt="DHT" />
  <img src="https://img.shields.io/badge/Zero-Dependencies-purple?style=flat-square" alt="Zero Dependencies" />
</p>

---

## What is Decengle?

Decengle is an anonymous video chat platform where you can talk to random strangers — like Omegle, but **fully decentralized**. There is no central server routing your video, audio, or messages. Everything flows directly between you and your match over encrypted WebRTC connections.

## Features

### Peer-to-Peer Video & Audio
- Direct WebRTC media streams between peers — no relay servers
- Camera and microphone captured via the browser's native `getUserMedia` API
- All media encrypted at the transport level via DTLS-SRTP

### End-to-End Encrypted Chat
- ECDH P-256 key exchange to derive a shared secret
- AES-GCM-256 encryption on every chat message
- Keys are never transmitted — only public keys are shared via the DHT
- Graceful fallback if E2EE derivation fails (transport encryption still active)

### Kademlia DHT
- Fully distributed peer discovery running on WebRTC data channels
- 160-bit peer IDs derived from SHA-256 of each peer's public key
- Peers announce their state (`idle`, `search`, `busy`) into the DHT
- DHT entries auto-expire after 60 seconds to keep the network fresh
- Data replicated across the K closest peers for resilience

### Random Matching
- Discover searching peers via DHT lookups — no central matchmaker
- Match request/accept/decline flow handled entirely peer-to-peer
- Block list to prevent re-matching with specific users
- One-click **Next** to disconnect and instantly search for someone new

### Lightweight Bootstrap
- A minimal Node.js WebSocket server for initial peer discovery only
- Bootstrap nodes peer with each other and share DHT state
- Once connected to the mesh, the bootstrap is no longer needed
- Fully configurable — add your own bootstrap nodes from the UI
- Custom bootstrap URLs persist in `localStorage`

### Zero Frontend Dependencies
- Pure vanilla JavaScript (ES6+), HTML5 and CSS3
- Web Crypto API for all cryptographic operations
- No frameworks, no bundlers, no build step — just open `index.html`

---

## Architecture

```
┌─────────────┐         WebSocket         ┌──────────────────┐
│   Browser    │◄────── (discovery) ──────►│  Bootstrap Node  │
│              │                           └──────────────────┘
│  ┌────────┐  │
│  │  DHT   │  │        WebRTC (P2P)
│  │Kademlia│  │◄═══════════════════════►  Stranger's Browser
│  └────────┘  │   video / audio / chat
│              │   (DTLS-SRTP encrypted)
└─────────────┘
```

1. **Bootstrap** — Your browser connects to a bootstrap node via WebSocket to discover peers  
2. **DHT Join** — Your peer ID and public key are announced into the distributed hash table  
3. **Match** — The matching service polls the DHT for peers in `search` state  
4. **WebRTC** — A direct peer connection is established (STUN for NAT traversal)  
5. **Chat & Video** — All data flows directly between browsers, encrypted end-to-end  

---

## Getting Started

### 1. Start the Bootstrap Server

```bash
cd bootstrap
npm install
npm start
```

The server starts on port `9000` by default.

| Environment Variable | Description |
|---|---|
| `PORT` | Server port (default: `9000`) |
| `SELF_URL` | Public URL to advertise (e.g. `wss://example.com`) |
| `PEER_BOOTSTRAPS` | Comma-separated URLs of other bootstrap nodes to peer with |

### 2. Open the App

Open `index.html` in your browser. That's it — no build step required.

### 3. Connect

1. Click **Start** to enable your camera and begin searching  
2. Wait for a match (or add more bootstrap nodes to grow the network)  
3. Chat via video and text — encrypted end-to-end  
4. Click **Next** to find someone new, or **Stop** to disconnect  

---

## Security Model

| Layer | Protection | Always Active? |
|---|---|---|
| Media (video/audio) | DTLS-SRTP | Yes |
| Data channel transport | DTLS | Yes |
| Chat message content | AES-GCM-256 (ECDH-derived key) | When both peers' public keys are in the DHT |

- **No TURN servers** — your traffic never passes through a relay. Either a direct connection is established, or the connection doesn't happen.
- **Peer IDs** are derived from the SHA-256 hash of your public key — no accounts, no usernames, no tracking.
- **Keys are ephemeral** — a new ECDH keypair is generated every session.

---

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 |
| Crypto | Web Crypto API (ECDH P-256, AES-GCM-256, SHA-256) |
| Networking | WebRTC (media + data channels) |
| Peer Discovery | Kademlia DHT over WebRTC |
| Bootstrap Server | Node.js + `ws` |
| Storage | Browser `localStorage` |

---

## Project Structure

```
Decengle/
├── index.html              # Single-page app
├── Style/
│   └── style.css           # Dark theme UI
├── Scripts/
│   ├── app.js              # Main entry — wires everything together
│   ├── chat.js             # E2EE text chat module
│   ├── crypto.js           # ECDH key exchange, AES-GCM, peer ID generation
│   ├── dht.js              # Kademlia DHT implementation
│   ├── matching.js         # Random peer matching service
│   ├── state.js            # Local state (favorites, blocks, history)
│   ├── userWebcamService.js # Camera/mic access
│   └── webrtc.js           # WebRTC connection manager
└── bootstrap/
    ├── package.json
    └── server.js            # Lightweight WebSocket bootstrap node
```

---

## License

This project is open source. Use it, fork it, run your own node.

---

<!-- TODO(docs): Add a Troubleshooting section (NAT traversal failures, camera permissions, no peers found) -->
<!-- TODO(docs): Add a Roadmap / Known Limitations section -->
<!-- TODO(docs): Add deployment guide for production bootstrap nodes (Docker, systemd, reverse proxy with TLS) -->
<!-- TODO(docs): Document the signaling protocol and DHT message format for third-party clients -->
<!-- TODO(docs): Add contributing guidelines (CONTRIBUTING.md) -->
