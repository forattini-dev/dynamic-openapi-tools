import { createHash, randomBytes } from 'node:crypto'

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/**
 * Generate a PKCE pair per RFC 7636:
 *   verifier  = 43–128 chars, unreserved URI-safe alphabet
 *   challenge = BASE64URL(SHA256(verifier))
 */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(16))
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
