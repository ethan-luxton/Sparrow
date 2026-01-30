import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ITERATIONS = 120000;
const KEY_LENGTH = 32;
const DIGEST = 'sha512';

export interface EncryptionContext {
  salt: string;
  iterations?: number;
}

function deriveKey(secret: string, salt: string, iterations = ITERATIONS) {
  return crypto.pbkdf2Sync(secret, Buffer.from(salt, 'hex'), iterations, KEY_LENGTH, DIGEST);
}

export function encryptText(plain: string, secret: string, ctx: EncryptionContext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(secret, ctx.salt, ctx.iterations);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptText(enc: string, secret: string, ctx: EncryptionContext) {
  const data = Buffer.from(enc, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const key = deriveKey(secret, ctx.salt, ctx.iterations);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

export function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}
