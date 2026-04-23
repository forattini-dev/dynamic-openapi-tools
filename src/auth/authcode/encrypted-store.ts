import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Symbolic at-rest protection for token caches. The key is derived from the
 * application name, which is also encoded in the filename — so this is NOT
 * protection against an attacker who read the source. It exists to avoid
 * leaking plaintext tokens through `cat`, grep, backup indexing, or log
 * streams when a file is accidentally shared. For real protection, rely on
 * filesystem permissions (0600) and inject tokens via env.
 */

const IV_LENGTH = 12
const TAG_LENGTH = 16

export function encrypt(plaintext: string, password: string): Buffer {
  const key = deriveKey(password)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decrypt(blob: Buffer, password: string): string {
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('encrypted payload too short')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH)
  const key = deriveKey(password)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

function deriveKey(password: string): Buffer {
  return createHash('sha256').update(password, 'utf-8').digest()
}
