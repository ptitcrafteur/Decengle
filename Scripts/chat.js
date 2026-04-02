// chat.js — E2EE text chat module

window.Decengle = window.Decengle || {};

class Chat {
  constructor(dht) {
    this.dht = dht;
    this.messages = [];
    this.onNewMessage = null;
    this.currentPeerId = null;
    this.sharedKey = null; // AES-GCM shared key with current partner
  }

  async setPartner(peerId, privateKey, remotePublicKeyHex) {
    this.currentPeerId = peerId;
    this.messages = [];
    this.sharedKey = null;

    // Derive E2EE shared key
    if (remotePublicKeyHex && privateKey) {
      try {
        const remotePub = await Decengle.importPublicKey(remotePublicKeyHex);
        if (remotePub) {
          this.sharedKey = await Decengle.deriveSharedKey(privateKey, remotePub);
        }
      } catch (e) {
        console.warn("[Chat] E2EE key derivation failed, messages unencrypted:", e.message);
      }
    }
  }

  async send(text) {
    if (!this.currentPeerId || !text.trim()) return;

    const encrypted = await Decengle.encrypt(this.sharedKey, text.trim());

    const msg = {
      type: "chat-message",
      encrypted,
      timestamp: Date.now(),
    };

    this.dht.sendTo(this.currentPeerId, msg);

    const localMsg = { from: "me", text: text.trim(), timestamp: msg.timestamp, isMine: true };
    this.messages.push(localMsg);
    if (this.onNewMessage) this.onNewMessage(localMsg);
  }

  async handleIncoming(fromPeerId, msg) {
    if (msg.type !== "chat-message") return false;

    let text;
    try {
      text = await Decengle.decrypt(this.sharedKey, msg.encrypted);
    } catch {
      text = "[encrypted message — key mismatch]";
    }

    const localMsg = { from: fromPeerId, text, timestamp: msg.timestamp, isMine: false };
    this.messages.push(localMsg);
    if (this.onNewMessage) this.onNewMessage(localMsg);
    return true;
  }

  clear() {
    this.messages = [];
    this.currentPeerId = null;
    this.sharedKey = null;
  }
}

Decengle.Chat = Chat;