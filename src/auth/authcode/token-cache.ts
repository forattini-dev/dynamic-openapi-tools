import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import path from 'node:path'
import { decrypt, encrypt } from './encrypted-store.js'

export interface CachedToken {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_at: number
  scopes: string[]
}

/**
 * Lookup keys for a single cache file: one `.env` per application (CLI or
 * bundled binary), one `schemeName` section inside it.
 */
export interface TokenCacheKey {
  appName: string
  schemeName: string
}

const APP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Where the encrypted `<appName>.env` lives. `$XDG_DATA_HOME` wins on every
 * platform if set; otherwise pick the native per-user data dir of the current
 * OS (Library/Application Support on macOS, %LOCALAPPDATA% on Windows,
 * ~/.local/share on Linux).
 */
export function tokenCacheDir(): string {
  const xdg = process.env['XDG_DATA_HOME']
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'dynamic-openapi-tools')
  }
  switch (process.platform) {
    /* v8 ignore next 2 — covered on macOS CI */
    case 'darwin':
      return path.join(homedir(), 'Library', 'Application Support', 'dynamic-openapi-tools')
    /* v8 ignore next 5 — covered on Windows CI */
    case 'win32': {
      const local = process.env['LOCALAPPDATA']
      const base = local && local.length > 0 ? local : path.join(homedir(), 'AppData', 'Local')
      return path.join(base, 'dynamic-openapi-tools')
    }
    default:
      return path.join(homedir(), '.local', 'share', 'dynamic-openapi-tools')
  }
}

export function tokenCachePath(appName: string): string {
  return path.join(tokenCacheDir(), `${sanitizeAppName(appName)}.env`)
}

export async function readTokenCache(key: TokenCacheKey): Promise<CachedToken | null> {
  const entries = await readEncryptedEnv(key.appName)
  if (!entries) return null
  return entriesToToken(entries, key.schemeName)
}

export async function writeTokenCache(key: TokenCacheKey, token: CachedToken): Promise<void> {
  const existing = (await readEncryptedEnv(key.appName)) ?? new Map<string, string>()
  applyTokenToEntries(existing, key.schemeName, token)
  await writeEncryptedEnv(key.appName, existing)
}

export async function deleteTokenCache(key: TokenCacheKey): Promise<void> {
  const existing = await readEncryptedEnv(key.appName)
  if (!existing) return
  removeSchemeFromEntries(existing, key.schemeName)
  if (existing.size === 0) {
    // `rm` with `force: true` swallows ENOENT; any remaining failure is a
    // filesystem issue the caller cannot recover from, surface it.
    await rm(tokenCachePath(key.appName), { force: true })
    return
  }
  await writeEncryptedEnv(key.appName, existing)
}

async function readEncryptedEnv(appName: string): Promise<Map<string, string> | null> {
  const file = tokenCachePath(appName)
  let blob: Buffer
  try {
    blob = await readFile(file)
  } catch {
    // ENOENT is the expected missing-cache path; other errors (EACCES, EIO)
    // are rare and the caller treats them the same as "no cache yet".
    return null
  }
  let plaintext: string
  try {
    plaintext = decrypt(blob, derivePassword(appName))
  } catch {
    return null
  }
  return parseEnv(plaintext)
}

async function writeEncryptedEnv(appName: string, entries: Map<string, string>): Promise<void> {
  await mkdir(tokenCacheDir(), { recursive: true, mode: 0o700 })
  const plaintext = serializeEnv(entries)
  const blob = encrypt(plaintext, derivePassword(appName))
  await writeFile(tokenCachePath(appName), blob, { mode: 0o600 })
}

/**
 * Compose the AES password from three parts that are all trivially
 * derivable on the same account (so this stays *symbolic* protection, not
 * real crypto) but are NOT present in the filename itself: the machine
 * hostname and the current user's login name. A stolen `.env` file alone
 * cannot be decrypted without knowing both — which is the step up from the
 * previous "password == filename" scheme.
 *
 * Override via OPENAPI_AUTHCODE_CACHE_PASSWORD for deterministic tests or
 * environments where hostname/user are unstable (containers, CI).
 */
export function derivePassword(appName: string): string {
  const override = process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD']
  if (override && override.length > 0) return `${override}-${appName}`
  const host = safePart(hostname())
  const user = safePart(userInfo().username)
  return `${host}-${user}-${appName}`
}

function safePart(value: string): string {
  // hostname()/userInfo().username always return non-empty in practice.
  /* v8 ignore next */
  if (!value || value.length === 0) return 'unknown'
  return value
}

function envPrefix(schemeName: string): string {
  return `${schemeName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`
}

function applyTokenToEntries(entries: Map<string, string>, schemeName: string, token: CachedToken): void {
  const prefix = envPrefix(schemeName)
  entries.set(`${prefix}ACCESS_TOKEN`, token.access_token)
  entries.set(`${prefix}TOKEN_TYPE`, token.token_type)
  entries.set(`${prefix}EXPIRES_AT`, String(token.expires_at))
  entries.set(`${prefix}SCOPES`, token.scopes.join(','))
  if (token.refresh_token) {
    entries.set(`${prefix}REFRESH_TOKEN`, token.refresh_token)
  } else {
    entries.delete(`${prefix}REFRESH_TOKEN`)
  }
}

function removeSchemeFromEntries(entries: Map<string, string>, schemeName: string): void {
  const prefix = envPrefix(schemeName)
  for (const key of Array.from(entries.keys())) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

function entriesToToken(entries: Map<string, string>, schemeName: string): CachedToken | null {
  const prefix = envPrefix(schemeName)
  const accessToken = entries.get(`${prefix}ACCESS_TOKEN`)
  const tokenType = entries.get(`${prefix}TOKEN_TYPE`)
  const expiresAtRaw = entries.get(`${prefix}EXPIRES_AT`)
  const scopesRaw = entries.get(`${prefix}SCOPES`)
  if (!accessToken || !tokenType || !expiresAtRaw) return null

  const expiresAt = Number.parseInt(expiresAtRaw, 10)
  // Defensive against a tampered cache file; our writes always use a valid number.
  /* v8 ignore next */
  if (!Number.isFinite(expiresAt)) return null

  const token: CachedToken = {
    access_token: accessToken,
    token_type: tokenType,
    expires_at: expiresAt,
    scopes: scopesRaw ? scopesRaw.split(',').filter(Boolean) : [],
  }
  const refresh = entries.get(`${prefix}REFRESH_TOKEN`)
  if (refresh) token.refresh_token = refresh
  return token
}

function parseEnv(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    // Our writes always produce KEY=VALUE; skip malformed lines from tampered files.
    /* v8 ignore next */
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    entries.set(key, value)
  }
  return entries
}

function serializeEnv(entries: Map<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n') + '\n'
}

function sanitizeAppName(name: string): string {
  if (APP_NAME_PATTERN.test(name)) return name
  return name.replace(/[^A-Za-z0-9._-]+/g, '-')
}
