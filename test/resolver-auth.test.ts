import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveAuth } from '../src/auth/resolver.js'
import { BearerAuth, ApiKeyAuth, BasicAuth, CompositeAuth, CustomAuth, TokenExchangeAuth } from '../src/auth/strategies.js'
import type { OpenAPIV3 } from 'openapi-types'

const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
  apiKeyAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
}

describe('resolveAuth', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when no config or env vars', () => {
    const auth = resolveAuth(undefined, {})
    expect(auth).toBeNull()
  })

  it('returns CustomAuth when custom is provided', () => {
    const auth = resolveAuth({ custom: () => ({}) }, schemes)
    expect(auth).toBeInstanceOf(CustomAuth)
  })

  it('returns BearerAuth from config', () => {
    const auth = resolveAuth({ bearerToken: 'tok' }, schemes)
    expect(auth).toBeInstanceOf(BearerAuth)
  })

  it('returns ApiKeyAuth from config using scheme info', () => {
    const auth = resolveAuth({ apiKey: 'key123' }, schemes)
    expect(auth).toBeInstanceOf(ApiKeyAuth)
  })

  it('returns ApiKeyAuth with default name when no apiKey scheme exists', () => {
    const auth = resolveAuth({ apiKey: 'key123' }, { bearerAuth: { type: 'http', scheme: 'bearer' } })
    expect(auth).toBeInstanceOf(ApiKeyAuth)
  })

  it('returns BasicAuth from config', () => {
    const auth = resolveAuth({ basicAuth: { username: 'u', password: 'p' } }, schemes)
    expect(auth).toBeInstanceOf(BasicAuth)
  })

  it('returns CompositeAuth when multiple strategies configured', () => {
    const auth = resolveAuth({ bearerToken: 'tok', apiKey: 'key' }, schemes)
    expect(auth).toBeInstanceOf(CompositeAuth)
  })

  it('returns TokenExchangeAuth from config', () => {
    const auth = resolveAuth({
      tokenExchange: {
        tokenUrl: 'https://auth.test.com/session',
        request: {
          fields: { credId: 'abc', credSecret: 'secret' },
        },
      },
    }, schemes)
    expect(auth).toBeInstanceOf(TokenExchangeAuth)
  })

  it('resolves from per-scheme env vars', () => {
    vi.stubEnv('OPENAPI_AUTH_BEARERAUTH_TOKEN', 'env-token')
    const auth = resolveAuth(undefined, schemes)
    expect(auth).toBeInstanceOf(BearerAuth)
  })

  it('resolves from per-scheme env vars with KEY suffix', () => {
    vi.stubEnv('OPENAPI_AUTH_APIKEYAUTH_KEY', 'env-key')
    const auth = resolveAuth(undefined, schemes)
    // Should find bearerAuth first in iteration, but since no TOKEN env, moves to apiKeyAuth
    // Actually iteration order depends on Object.entries
    expect(auth).not.toBeNull()
  })

  it('resolves from global OPENAPI_AUTH_TOKEN', () => {
    vi.stubEnv('OPENAPI_AUTH_TOKEN', 'global-token')
    const auth = resolveAuth(undefined, {})
    expect(auth).toBeInstanceOf(BearerAuth)
  })

  it('resolves from global OPENAPI_API_KEY with matching scheme', () => {
    vi.stubEnv('OPENAPI_API_KEY', 'global-key')
    const auth = resolveAuth(undefined, schemes)
    expect(auth).toBeInstanceOf(ApiKeyAuth)
  })

  it('resolves from global OPENAPI_API_KEY with default name', () => {
    vi.stubEnv('OPENAPI_API_KEY', 'global-key')
    const auth = resolveAuth(undefined, {})
    expect(auth).toBeInstanceOf(ApiKeyAuth)
  })
})
