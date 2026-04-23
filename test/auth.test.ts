import { describe, it, expect } from 'vitest'
import { BearerAuth, ApiKeyAuth, BasicAuth } from '../src/auth/strategies.js'
import { resolveAuth } from '../src/auth/resolver.js'

describe('auth strategies', () => {
  it('BearerAuth sets Authorization header', async () => {
    const auth = new BearerAuth('my-token')
    const url = new URL('https://api.example.com/pets')
    const result = await auth.apply(url, { method: 'GET', headers: new Headers() })

    const headers = result.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('ApiKeyAuth sets header', async () => {
    const auth = new ApiKeyAuth('key-123', 'X-API-Key', 'header')
    const url = new URL('https://api.example.com/pets')
    const result = await auth.apply(url, { method: 'GET', headers: new Headers() })

    const headers = result.headers as Headers
    expect(headers.get('X-API-Key')).toBe('key-123')
  })

  it('ApiKeyAuth sets query param', async () => {
    const auth = new ApiKeyAuth('key-123', 'api_key', 'query')
    const url = new URL('https://api.example.com/pets')
    await auth.apply(url, { method: 'GET', headers: new Headers() })

    expect(url.searchParams.get('api_key')).toBe('key-123')
  })

  it('BasicAuth sets Authorization header', async () => {
    const auth = new BasicAuth('user', 'pass')
    const url = new URL('https://api.example.com/pets')
    const result = await auth.apply(url, { method: 'GET', headers: new Headers() })

    const headers = result.headers as Headers
    const expected = `Basic ${btoa('user:pass')}`
    expect(headers.get('Authorization')).toBe(expected)
  })
})

describe('auth resolver', () => {
  it('resolves bearer token from config', () => {
    const auth = resolveAuth({ bearerToken: 'test-token' }, {})
    expect(auth).not.toBeNull()
  })

  it('resolves api key from config', () => {
    const auth = resolveAuth({ apiKey: 'test-key' }, {})
    expect(auth).not.toBeNull()
  })

  it('returns null when no auth configured', () => {
    const auth = resolveAuth(undefined, {})
    expect(auth).toBeNull()
  })
})
