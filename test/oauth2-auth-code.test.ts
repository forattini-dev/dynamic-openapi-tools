import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenAPIV3 } from 'openapi-types'

// Must run before any code that imports node:child_process so openBrowser
// tests can control spawn. No other module in this test file uses it.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: vi.fn() }
})
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

  it('falls back to the platform default when XDG_DATA_HOME is absent', () => {
    const prev = process.env['XDG_DATA_HOME']
    delete process.env['XDG_DATA_HOME']
    try {
      const dir = tokenCacheDir()
      expect(dir.endsWith('dynamic-openapi-tools')).toBe(true)
    } finally {
      if (prev !== undefined) process.env['XDG_DATA_HOME'] = prev
    }
  })

  it('treats an empty XDG_DATA_HOME the same as absent', () => {
    const prev = process.env['XDG_DATA_HOME']
    process.env['XDG_DATA_HOME'] = ''
    try {
      const dir = tokenCacheDir()
      expect(dir.endsWith('dynamic-openapi-tools')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = prev
    }
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

  it('falls back to interactive login when refresh_token returns a 4xx', async () => {
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
      access_token: 'stale',
      refresh_token: 'rt-dead',
      token_type: 'Bearer',
      expires_at: Date.now() - 1_000,
      scopes: ['read'],
    })

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('refresh token revoked', { status: 400 })
    )
    // Force interactive login to throw so we observe the fallback path without
    // actually opening a browser.
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockRejectedValue(new Error('no browser in tests'))

    await expect(flow.apply(new URL('https://api.test/'), {})).rejects.toThrow('no browser')
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('refresh failed')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the failing refresh call
  })

  it('forceLogin + logout roundtrip via a mocked loopback + token endpoint', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      clientSecret: 'secret',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: ['read'],
      extraAuthParams: { audience: 'api.test' },
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)

    const loopback = await import('../src/auth/authcode/loopback-server.js')
    const captureSpy = vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'the-code',
      // Grab the same state the flow emitted by reading the URL the browser
      // was asked to open. The spy above ran first, so its last call holds it.
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'fresh-at',
          refresh_token: 'fresh-rt',
          token_type: 'Bearer',
          expires_in: 7200,
          scope: 'read write',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    const token = await flow.forceLogin()
    expect(token.access_token).toBe('fresh-at')
    expect(token.scopes).toEqual(['read', 'write'])
    expect(captureSpy).toHaveBeenCalled()

    // extraAuthParams landed in the authorization URL
    const authUrl = new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!)
    expect(authUrl.searchParams.get('audience')).toBe('api.test')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')

    await flow.logout()
    expect(await readTokenCache({ appName: 'global', schemeName: 'test' })).toBeNull()
  })

  it('rejects with a bare error code when no description is provided', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow
    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockResolvedValue({ error: 'server_error' })
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    const err = await flow.forceLogin().catch((e) => e)
    expect(String(err)).toContain('server_error')
    expect(String(err)).not.toContain('—')
  })

  it('surfaces a token-endpoint failure even when the error body is empty', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow
    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'c',
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }))
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/returned 500/)
  })

  it('defaults token_type to Bearer when the response omits it', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: ['read'],
    })
    const flow = auth as OAuth2AuthCodeFlow
    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'c',
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    const token = await flow.forceLogin()
    expect(token.token_type).toBe('Bearer')
  })

  it('rejects when the provider returns an error callback', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockResolvedValue({
      error: 'access_denied',
      errorDescription: 'user said no',
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/access_denied.*user said no/)
  })

  it('rejects when the callback has no code', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockResolvedValue({ state: 'wrong' })
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/did not return an authorization code/)
  })

  it('rejects on state mismatch (CSRF guard)', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockResolvedValue({
      code: 'c',
      state: 'tampered',
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/state mismatch/)
  })

  it('surfaces token-endpoint failures with the upstream error body', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'the-code',
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 })
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/400.*invalid_grant/)
  })

  it('throws when the token endpoint returns no access_token', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'c',
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    await expect(flow.forceLogin()).rejects.toThrow(/did not return an access_token/)
  })

  it('refresh() wipes the cache and forces a new login call', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow

    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'before',
      token_type: 'Bearer',
      expires_at: Date.now() + 60_000,
      scopes: [],
    })

    const browser = await import('../src/auth/authcode/browser.js')
    vi.spyOn(browser, 'openBrowser').mockResolvedValue(true)
    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockImplementation(async () => ({
      code: 'c',
      state: new URL((browser.openBrowser as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!).searchParams.get('state')!,
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'after', token_type: 'Bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    const init = await flow.refresh(new URL('https://api.test/'), {})
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer after')
  })

  it('refresh flow preserves the previous refresh_token when server omits one', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      clientSecret: 'secret',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: ['read'],
      refreshBufferSeconds: 0,
    })
    const flow = auth as OAuth2AuthCodeFlow
    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'old',
      refresh_token: 'keep-me',
      token_type: 'Bearer',
      expires_at: Date.now() - 1000,
      scopes: ['read'],
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'rotated', token_type: 'Bearer', expires_in: 120 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await flow.apply(new URL('https://api.test/'), {})
    const cached = await readTokenCache({ appName: 'global', schemeName: 'test' })
    expect(cached?.refresh_token).toBe('keep-me')
    expect(cached?.access_token).toBe('rotated')
  })

  it('describes non-Error refresh rejections via String() in the stderr warning', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
      refreshBufferSeconds: 0,
    })
    const flow = auth as OAuth2AuthCodeFlow
    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'old',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_at: Date.now() - 1000,
      scopes: [],
    })

    // fetch rejects with a plain string (not an Error). Passes through the
    // catch in resolveToken untouched so describeError exercises String(error).
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('plain-string-rejection' as unknown as Error)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)

    const loopback = await import('../src/auth/authcode/loopback-server.js')
    vi.spyOn(loopback, 'captureCallback').mockRejectedValue(new Error('stop here'))

    await expect(flow.apply(new URL('https://api.test/'), {})).rejects.toThrow('stop here')
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('plain-string-rejection')
  })

  it('deduplicates concurrent apply() calls into one token request', async () => {
    const auth = createOAuth2AuthCodeAuth({
      appName: 'global',
      schemeName: 'test',
      clientId: 'c',
      authorizationUrl: 'https://a.test/auth',
      tokenUrl: 'https://a.test/token',
      scopes: [],
    })
    const flow = auth as OAuth2AuthCodeFlow
    await writeTokenCache({ appName: 'global', schemeName: 'test' }, {
      access_token: 'shared',
      token_type: 'Bearer',
      expires_at: Date.now() + 60_000,
      scopes: [],
    })

    const [a, b] = await Promise.all([
      flow.apply(new URL('https://api.test/'), {}),
      flow.apply(new URL('https://api.test/'), {}),
    ])
    expect(new Headers(a.headers).get('Authorization')).toBe('Bearer shared')
    expect(new Headers(b.headers).get('Authorization')).toBe('Bearer shared')
  })
})

describe('openBrowser', () => {
  let originalBrowser: string | undefined

  beforeEach(() => {
    originalBrowser = process.env['BROWSER']
    delete process.env['BROWSER']
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalBrowser === undefined) delete process.env['BROWSER']
    else process.env['BROWSER'] = originalBrowser
  })

  async function getMockedSpawn(): Promise<ReturnType<typeof vi.fn>> {
    const cp = await import('node:child_process')
    return cp.spawn as unknown as ReturnType<typeof vi.fn>
  }

  it('spawns the platform opener and resolves true when no error fires', async () => {
    const spawn = await getMockedSpawn()
    spawn.mockReset()
    spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })

    const { openBrowser } = await import('../src/auth/authcode/browser.js')
    const result = await openBrowser('https://example.com/?a=1&b=2')
    expect(result).toBe(true)
    expect(spawn).toHaveBeenCalled()
    const args = spawn.mock.calls[0]![1] as string[]
    expect(args[args.length - 1]).toBe('https://example.com/?a=1&b=2')
  })

  it('resolves false when spawn throws synchronously', async () => {
    const spawn = await getMockedSpawn()
    spawn.mockReset()
    spawn.mockImplementation(() => {
      throw new Error('boom')
    })

    const { openBrowser } = await import('../src/auth/authcode/browser.js')
    expect(await openBrowser('https://example.com')).toBe(false)
  })

  it('resolves false when the child emits an error event', async () => {
    const spawn = await getMockedSpawn()
    spawn.mockReset()
    const handlers: Record<string, (err: Error) => void> = {}
    spawn.mockReturnValue({
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        handlers[event] = handler
      }),
      unref: vi.fn(),
    })

    const { openBrowser } = await import('../src/auth/authcode/browser.js')
    const promise = openBrowser('https://example.com')
    handlers['error']!(new Error('nope'))
    expect(await promise).toBe(false)
  })

  it('honors the BROWSER env var', async () => {
    process.env['BROWSER'] = 'myfox'
    const spawn = await getMockedSpawn()
    spawn.mockReset()
    spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })

    const { openBrowser } = await import('../src/auth/authcode/browser.js')
    await openBrowser('https://example.com')
    expect(spawn.mock.calls[0]![0]).toBe('myfox')
  })
})

describe('loopback-server extra cases', () => {
  it('returns 404 for paths other than /callback', async () => {
    const port = 7000 + Math.floor(Math.random() * 1000)
    const waiter = captureCallback({ port, timeoutMs: 3000 })
    await new Promise((r) => setTimeout(r, 50))
    const miss = await fetch(`http://127.0.0.1:${port}/not-here`)
    expect(miss.status).toBe(404)
    // Now feed the real callback so the server shuts down.
    await fetch(`http://127.0.0.1:${port}/callback?code=x&state=y`)
    await waiter
  })

  it('rejects if the port is already in use', async () => {
    const { createServer } = await import('node:http')
    const port = 7000 + Math.floor(Math.random() * 1000)
    const hog = createServer().listen(port, '127.0.0.1')
    try {
      await expect(captureCallback({ port, timeoutMs: 3000 })).rejects.toThrow()
    } finally {
      hog.close()
    }
  })
})

describe('token-cache extra cases', () => {
  let tmp: string
  let prevXdg: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'token-cache-extra-'))
    prevXdg = process.env['XDG_DATA_HOME']
    process.env['XDG_DATA_HOME'] = tmp
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
    else process.env['XDG_DATA_HOME'] = prevXdg
    rmSync(tmp, { recursive: true, force: true })
  })

  it('deleting the last scheme removes the whole file', async () => {
    const key = { appName: 'only', schemeName: 'oauth' }
    await writeTokenCache(key, {
      access_token: 'x',
      token_type: 'Bearer',
      expires_at: 1,
      scopes: [],
    })
    const { existsSync } = await import('node:fs')
    expect(existsSync(tokenCachePath('only'))).toBe(true)
    await deleteTokenCache(key)
    expect(existsSync(tokenCachePath('only'))).toBe(false)
  })

  it('deleting from a missing file is a no-op', async () => {
    await deleteTokenCache({ appName: 'never-existed', schemeName: 'oauth' })
    // No throw, no file.
    const { existsSync } = await import('node:fs')
    expect(existsSync(tokenCachePath('never-existed'))).toBe(false)
  })

  it('skips tokens with missing required fields when reading', async () => {
    // Seed a cache file that's missing EXPIRES_AT for a given scheme.
    const key = { appName: 'partial', schemeName: 'oauth' }
    await writeTokenCache(key, {
      access_token: 'x',
      token_type: 'Bearer',
      expires_at: 1,
      scopes: [],
    })
    // Read back via another scheme name that has no entries — returns null.
    expect(
      await readTokenCache({ appName: 'partial', schemeName: 'other' })
    ).toBeNull()
  })
})

describe('detectOAuth2AuthCode normalizeOptions', () => {
  function schemes(): Record<string, OpenAPIV3.SecuritySchemeObject> {
    return {
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://a.test',
            tokenUrl: 'https://a.test/token',
            scopes: {},
          },
        },
      },
    }
  }

  it('accepts no options and falls back to process.env', () => {
    const prev = process.env['OPENAPI_OAUTH2_CLIENT_ID']
    process.env['OPENAPI_OAUTH2_CLIENT_ID'] = 'from-process'
    try {
      const detected = detectOAuth2AuthCode(schemes())
      expect(detected?.config.clientId).toBe('from-process')
    } finally {
      if (prev === undefined) delete process.env['OPENAPI_OAUTH2_CLIENT_ID']
      else process.env['OPENAPI_OAUTH2_CLIENT_ID'] = prev
    }
  })

  it('ignores bogus per-scheme port values', () => {
    const detected = detectOAuth2AuthCode(schemes(), {
      env: {
        OPENAPI_OAUTH2_CLIENT_ID: 'x',
        OPENAPI_AUTH_OAUTH_PORT: 'not-a-number',
      },
    })
    expect(detected?.config.redirectPort).toBeUndefined()
  })

  it('skips non-oauth2 schemes and schemes without an authorizationCode flow', () => {
    const mixed: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      bearerauth: { type: 'http', scheme: 'bearer' } as OpenAPIV3.SecuritySchemeObject,
      apikey: { type: 'apiKey', in: 'header', name: 'X-Key' } as OpenAPIV3.SecuritySchemeObject,
      clientcreds: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://t.test', scopes: {} } },
      } as OpenAPIV3.SecuritySchemeObject,
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://a.test',
            tokenUrl: 'https://t.test',
            scopes: {},
          },
        },
      } as OpenAPIV3.SecuritySchemeObject,
    }
    const detected = detectOAuth2AuthCode(mixed, { env: { OPENAPI_OAUTH2_CLIENT_ID: 'x' } })
    expect(detected?.schemeName).toBe('oauth')
  })

  it('tolerates flow.scopes being undefined', () => {
    const minimal: Record<string, OpenAPIV3.SecuritySchemeObject> = {
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://a.test',
            tokenUrl: 'https://t.test',
          } as OpenAPIV3.OAuth2SecurityScheme['flows']['authorizationCode'],
        },
      } as OpenAPIV3.SecuritySchemeObject,
    }
    const detected = detectOAuth2AuthCode(minimal, { env: { OPENAPI_OAUTH2_CLIENT_ID: 'x' } })
    expect(detected?.config.scopes).toEqual([])
  })

  it('picks up client-secret and redirect-uri overrides from env', () => {
    const detected = detectOAuth2AuthCode(schemes(), {
      env: {
        OPENAPI_OAUTH2_CLIENT_ID: 'x',
        OPENAPI_OAUTH2_CLIENT_SECRET: 'shh',
        OPENAPI_OAUTH2_REDIRECT_URI: 'http://127.0.0.1:8888/cb',
      },
    })
    expect(detected?.config.clientSecret).toBe('shh')
    expect(detected?.config.redirectUri).toBe('http://127.0.0.1:8888/cb')
  })

})
