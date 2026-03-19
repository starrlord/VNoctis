import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = 'vnm-r2-settings'; // static salt — uniqueness comes from IV

/**
 * Derives a 32-byte encryption key from the given secret via scrypt.
 * @param {string} secret
 * @returns {Buffer}
 */
function deriveKey(secret) {
  return scryptSync(secret, SALT, 32);
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a colon-delimited hex string: iv:authTag:ciphertext
 *
 * @param {string} plaintext
 * @param {string} secret  Typically VNM_JWT_SECRET
 * @returns {string}
 */
export function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypts a string produced by encrypt().
 *
 * @param {string} ciphertext  iv:authTag:encrypted in hex
 * @param {string} secret
 * @returns {string}
 */
export function decrypt(ciphertext, secret) {
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  const key = deriveKey(secret);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}
