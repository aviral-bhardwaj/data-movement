const crypto = require('crypto');
const config = require('./config');

// AES-256-GCM encryption for connector credentials at rest.
// Layout: base64( iv[12] | tag[16] | ciphertext )
const KEY = Buffer.from(config.encryptionKey, 'hex');
if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
}

function encrypt(plain) {
  if (plain === undefined || plain === null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function encryptJson(obj) {
  return encrypt(JSON.stringify(obj));
}

function decryptJson(payload) {
  const s = decrypt(payload);
  return s ? JSON.parse(s) : null;
}

module.exports = { encrypt, decrypt, encryptJson, decryptJson };
