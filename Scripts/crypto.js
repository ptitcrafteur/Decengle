// crypto.js — Key generation, peer ID, and E2EE (ECDH + AES-GCM)
// Falls back to random IDs when crypto.subtle is unavailable (file:// protocol)
// TODO(security): Warn the user visibly when running in fallback mode (no real encryption)
// TODO(security): Add key rotation — periodically renegotiate ECDH keys during long conversations
// TODO(security): Add SAS (Short Authentication String) verification to confirm peer identity

window.Decengle = window.Decengle || {};

const hasSubtle = !!(crypto && crypto.subtle);

Decengle.generateKeyPair = async function () {
  if (hasSubtle) {
    return await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
  }
  const raw = crypto.getRandomValues(new Uint8Array(65));
  return { publicKey: raw, privateKey: raw, _fallback: true };
};

Decengle.exportPublicKey = async function (key) {
  if (hasSubtle && !key._fallback) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return Decengle.bufToHex(raw);
  }
  return Decengle.bufToHex(key.buffer || key);
};

// Import a remote peer's public key from hex for ECDH
Decengle.importPublicKey = async function (hexKey) {
  if (!hasSubtle) return null;
  const raw = Decengle.hexToBuf(hexKey);
  return await crypto.subtle.importKey(
    "raw", raw,
    { name: "ECDH", namedCurve: "P-256" },
    true, []
  );
};

// Derive a shared AES-GCM-256 key from our private key + their public key
Decengle.deriveSharedKey = async function (privateKey, remotePublicKey) {
  if (!hasSubtle) return null;
  return await crypto.subtle.deriveKey(
    { name: "ECDH", public: remotePublicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

// Encrypt plaintext → { iv, ct }
Decengle.encrypt = async function (sharedKey, plaintext) {
  if (!hasSubtle || !sharedKey) return { _plain: true, text: plaintext };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, sharedKey, encoded
  );
  return { iv: Decengle.bufToHex(iv.buffer), ct: Decengle.bufToHex(ciphertext) };
};

// Decrypt { iv, ct } → plaintext string
Decengle.decrypt = async function (sharedKey, encryptedMsg) {
  // TODO(security): Remove plaintext fallback — if E2EE fails, messages should not be sent unencrypted
  if (!hasSubtle || !sharedKey || encryptedMsg._plain) {
    return encryptedMsg._plain ? encryptedMsg.text : null;
  }
  const iv = new Uint8Array(Decengle.hexToBuf(encryptedMsg.iv));
  const ct = Decengle.hexToBuf(encryptedMsg.ct);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, sharedKey, ct
  );
  return new TextDecoder().decode(decrypted);
};

Decengle.generatePeerId = async function (publicKeyHex) {
  // TODO(security): Add a random salt to the peer ID to prevent cross-session tracking
  //   (currently the same public key always produces the same peer ID)
  if (hasSubtle) {
    const data = Decengle.hexToBuf(publicKeyHex);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Decengle.bufToHex(hash.slice(0, 20));
  }
  const random = crypto.getRandomValues(new Uint8Array(20));
  return Decengle.bufToHex(random.buffer);
};

Decengle.bufToHex = function (buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

Decengle.hexToBuf = function (hex) {
  const bytes = hex.match(/.{2}/g).map((byte) => parseInt(byte, 16));
  return new Uint8Array(bytes).buffer;
};

Decengle.xorDistance = function (a, b) {
  const aBuf = new Uint8Array(Decengle.hexToBuf(a));
  const bBuf = new Uint8Array(Decengle.hexToBuf(b));
  const result = new Uint8Array(aBuf.length);
  for (let i = 0; i < aBuf.length; i++) {
    result[i] = aBuf[i] ^ bBuf[i];
  }
  return Decengle.bufToHex(result.buffer);
};

Decengle.compareDistance = function (d1, d2) {
  for (let i = 0; i < d1.length; i += 2) {
    const b1 = parseInt(d1.substring(i, i + 2), 16);
    const b2 = parseInt(d2.substring(i, i + 2), 16);
    if (b1 < b2) return -1;
    if (b1 > b2) return 1;
  }
  return 0;
};