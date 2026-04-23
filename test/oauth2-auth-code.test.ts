import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenAPIV3 } from 'openapi-types'
import { detectOAuth2AuthCode, createOAuth2AuthCodeAuth } from '../src/auth/authcode/resolver.js'
import { generatePkce, generateState } from '../src/auth/authcode/pkce.js'
import {
  readTokenCache,
  writeTokenCache,
  deleteTokenCache,
  tokenCachePath,
  tokenCacheDir,
} from '../src/auth/authcode/token-cache.js'
import { captureCallback } from '../src/auth/authcode/loopback-server.js'
import { OAuth2AuthCodeFlow } from '../src/auth/authcode/oauth2-auth-code.js'
import { derivePassword } from '../src/auth/authcode/token-cache.js'
import { decrypt } from '../src/auth/authcode/encrypted-store.js'

describe('generatePkce', () => {
  it('produces a verifier of the expected shape', () => {
    const pair = generatePkce()
    expect(pair.method).toBe('S256')
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('generates a different verifier each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe('generateState', () => {
  it('produces a distinct url-safe string', () => {
    expect(generateState()).not.toBe(generateState())
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('token cache', () => {
  let tmp: string
  let prevXdg: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'token-cache-'))
    prevXdg = process.env['XDG_DATA_HOME']
    process.env['XDG_DATA_HOME'] = tmp
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = prevXdg
    rmSync(tmp, { recursive: true, force: true })
  })

  it('derives the cache dir from XDG_DATA_HOME', () => {
    expect(tokenCacheDir()).toBe(join(tmp, 'dynamic-openapi-tools'))
  })

  it('sanitizes the app name so it cannot escape the cache dir', async () => {
    const full = tokenCachePath('../../evil/../key')
    const { basename, dirname } = await import('node:path')
    expect(dirname(full)).toBe(tokenCacheDir())
    expect(basename(full).includes('/')).toBe(false)
    expect(basename(full).includes('\\')).toBe(false)
    expect(basename(full).endsWith('.env')).toBe(true)
  })

  it('round-trips a token via write/read/delete', async () => {
    const key = { appName: 'myapp', schemeName: 'oauth' }
    await writeTokenCache(key, {
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_at: 123,
      scopes: ['a', 'b'],
    })
    const read = await readTokenCache(key)
    expect(read).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_at: 123,
      scopes: ['a', 'b'],
    })
    await deleteTokenCache(key)
    expect(await readTokenCache(key)).toBeNull()
  })

  it('keeps multiple schemes in the same app file isolated', async () => {
    const a = { appName: 'shared', schemeName: 'oauth_a' }
    const b = { appName: 'shared', schemeName: 'oauth_b' }
    await writeTokenCache(a, {
      access_token: 'at-a',
      token_type: 'Bearer',
      expires_at: 10,
      scopes: [],
    })
    await writeTokenCache(b, {
      access_token: 'at-b',
      token_type: 'Bearer',
      expires_at: 20,
      scopes: ['x'],
    })
    expect((await readTokenCache(a))?.access_token).toBe('at-a')
    expect((await readTokenCache(b))?.access_token).toBe('at-b')
    await deleteTokenCache(a)
    expect(await readTokenCache(a)).toBeNull()
    expect((await readTokenCache(b))?.access_token).toBe('at-b')
  })

  it('stores the cache as an AES-GCM blob that cannot be read as plaintext', async () => {
    const key = { appName: 'opaque', schemeName: 'oauth' }
    await writeTokenCache(key, {
      access_token: 'super-secret-token',
      token_type: 'Bearer',
      expires_at: 1,
      scopes: [],
    })
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(tokenCachePath('opaque'))
    expect(raw.toString('utf-8')).not.toContain('super-secret-token')
    expect(raw.toString('utf-8')).not.toContain('ACCESS_TOKEN')
  })

  it('composes the AES password from host, user and appName, and is overridable for tests', async () => {
    const prev = process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD']
    delete process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD']
    try {
      const composed = derivePassword('some-app')
      // Hostname and username vary by environment, but the appName must be at the tail
      expect(composed.endsWith('-some-app')).toBe(true)
      // Must NOT be just the appName (otherwise filename == password)
      expect(composed).not.toBe('some-app')

      process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD'] = 'fixed-seed'
      expect(derivePassword('app')).toBe('fixed-seed-app')
    } finally {
      if (prev === undefined) delete process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD']
      else process.env['OPENAPI_AUTHCODE_CACHE_PASSWORD'] = prev
    }
  })

  it('cannot be decrypted using just the appName as the password', async () => {
    const key = { appName: 'hardened', schemeName: 'oauth' }
    await writeTokenCache(key, {
      access_token: 'top-secret',
      token_type: 'Bearer',
      expires_at: 1,
      scopes: [],
    })
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(tokenCachePath('hardened'))
    expect(() => decrypt(raw, 'hardened')).toThrow()
  })

  it('returns null when the file is corrupted or has the wrong password', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(tokenCacheDir(), { recursive: true })
    await writeFile(tokenCachePath('broken'), Buffer.from('not a valid encrypted blob'))
    expect(await readTokenCache({ appName: 'broken', schemeName: 'oauth' })).toBeNull()
  })
})

describe('detectOAuth2AuthCode', () => {
  function schemes(): Record<string, OpenAPIV3.SecuritySchemeObject> {
    return {
      myoauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://issuer.test/authorize',
            tokenUrl: 'https://issuer.test/token',
            scopes: { 'read:pets': 'Read pets', 'write:pets': 'Write pets' },
          },
        },
      },
    }
  }

  it('returns null when no env clientId is set', () => {
    expect(detectOAuth2AuthCode(schemes(), {})).toBeNull()
  })

  it('picks up the global OPENAPI_OAUTH2_CLIENT_ID', () => {
    const detected = detectOAuth2AuthCode(schemes(), {
      OPENAPI_OAUTH2_CLIENT_ID: 'global-client',
    })
    expect(detected?.schemeName).toBe('myoauth')
    expect(detected?.config.clientId).toBe('global-client')
    expect(detected?.config.authorizationUrl).toBe('https://issuer.test/authorize')
    expect(detected?.config.scopes).toEqual(['read:pets', 'write:pets'])
  })

  it('prefers the per-scheme env over the global one', () => {
    const detected = detectOAuth2AuthCode(schemes(), {
      OPENAPI_OAUTH2_CLIENT_ID: 'global',
      OPENAPI_AUTH_MYOAUTH_CLIENT_ID: 'scoped',
      OPENAPI_AUTH_MYOAUTH_SCOPES: 'read:pets',
      OPENAPI_AUTH_MYOAUTH_PORT: '9999',
    })
    expect(detected?.config.clientId).toBe('scoped')
    expect(detected?.config.scopes).toEqual(['read:pets'])
    expect(detected?.config.redirectPort).toBe(9999)
  })

  it('defaults appName to "global" and accepts an override', () => {
    const detected = detectOAuth2AuthCode(schemes(), {
      env: { OPENAPI_OAUTH2_CLIENT_ID: 'x' },
    })
    expect(detected?.config.appName).toBe('global')

    const detectedWithApp = detectOAuth2AuthCode(schemes(), {
      appName: 'my-pet-store',
      env: { OPENAPI_OAUTH2_CLIENT_ID: 'x' },
    })
    expect(detectedWithApp?.config.appName).toBe('my-pet-store')
  })

  it('ignores schemes that do not declare an authorizationCode flow', () => {
    const implicitOnly: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      implicitonly: {
        type: 'oauth2',
        flows: {
          implicit: {
            authorizationUrl: 'https://a.test',
            scopes: {},
          },
        },
      },
    }
    expect(
      detectOAuth2AuthCode(implicitOnly, { OPENAPI_OAUTH2_CLIENT_ID: 'x' })
    ).toBeNull()
  })
})

describe('captureCallback', () => {
  it('resolves with code and state when a matching request arrives', async () => {
    const port = 7000 + Math.floor(Math.random() * 1000)
    const waiter = captureCallback({ port, timeoutMs: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`)
    expect(res.status).toBe(200)
    const callback = await waiter
    expect(callback.code).toBe('abc')
    expect(callback.state).toBe('xyz')
  })

  it('captures error and error_description', async () => {
    const port = 7000 + Math.floor(Math.random() * 1000)
    const waiter = captureCallback({ port, timeoutMs: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=nope`)
    const callback = await waiter
    expect(callback.error).toBe('access_denied')
    expect(callback.errorDescription).toBe('nope')
  })

  it('rejects on timeout', async () => {
    const port = 7000 + Math.floor(Math.random() * 1000)
    await expect(captureCallback({ port, timeoutMs: 50 })).rejects.toThrow(/timed out/)
  })
})

describe('OAuth2AuthCodeFlow token lifecycle', () => {
  let tmp: string
  let prevXdg: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'oauth2-'))
    prevXdg = process.env['XDG_DATA_HOME']
    process.env['XDG_DATA_HOME'] = tmp
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = prevXdg
    rmSync(tmp, { recursive: true, force: true })
  })

  it('applies a cached token without hitting the network', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: ['read'],
    })
    const flow = auth as OAuth2AuthCodeFlow
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'cached-at',
      token_type: 'Bearer',
      expires_at: Date.now() + 60_000,
      scopes: ['read'],
    })

    const init = await flow.apply(new URL('https://api.test/'), {})
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer cached-at')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refreshes via refresh_token when the cached token is expired', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: ['read'],
      refreshBufferSeconds: 0,
    })
    const flow = auth as OAuth2AuthCodeFlow

    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'old-at',
      refresh_token: 'rt-1',
      token_type: 'Bearer',
      expires_at: Date.now() - 5_000,
      scopes: ['read'],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'rt-2',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const init = await flow.apply(new URL('https://api.test/'), {})
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer new-at')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = fetchSpy.mock.calls[0]![1]!.body as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-1')
  })
})
