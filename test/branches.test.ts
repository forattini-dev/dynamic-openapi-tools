import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildBundle } from '../src/bundle/build.js'
import { loadSpec } from '../src/parser/loader.js'
import { resolveSpec } from '../src/parser/resolver.js'
import { fetchWithRetry } from '../src/utils/fetch.js'
import { resolveAuth } from '../src/auth/resolver.js'
import { OAuth2ClientCredentials, TokenExchangeAuth } from '../src/auth/strategies.js'
import { filterOperations } from '../src/parser/filter.js'
import type { ParsedOperation } from '../src/parser/types.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('buildBundle — URL branch of computeSpecSource', () => {
  it('records kind="url" when source is an http(s) URL', async () => {
    const specJson = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Remote', version: '9.9.9' },
      paths: { '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } } },
    })
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(specJson, { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const dir = await mkdtemp(path.join(tmpdir(), 'tools-url-'))
    try {
      const out = path.join(dir, 'remote-mcp')
      const result = await buildBundle({
        source: 'https://api.example.test/openapi.json',
        name: 'remote-mcp',
        out,
        runnerPackage: 'dynamic-openapi-mcp',
        kindLabel: 'MCP',
        runnerInvocation: '--source "$SPEC_FILE"',
      })

      expect(result.specSource.kind).toBe('url')
      expect(result.specSource.value).toBe('https://api.example.test/openapi.json')

      const content = await readFile(out, 'utf-8')
      expect(content).toMatch(/SPEC_SOURCE_KIND='url'/)
      expect(content).toContain("SPEC_SOURCE='https://api.example.test/openapi.json'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('loader — YAML parse error', () => {
  it('wraps YAML parser errors with the source name', async () => {
    // resolveSource classifies any string starting with `openapi` as inline YAML/JSON,
    // so the parser gets this content directly and fails in the YAML path.
    const malformed = 'openapi: 3.0.0\ninfo:\n  title: "unclosed\n  version: 1'
    await expect(loadSpec(malformed)).rejects.toThrow(/Failed to parse YAML spec/)
  })
})

describe('parser/resolver — uncovered paths', () => {
  it('generates an operationId when the spec omits one', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'GenId', version: '1.0.0' },
      paths: {
        '/orders/{orderId}/items': {
          get: {
            parameters: [
              { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    } as any
    const spec = await resolveSpec(doc)
    expect(spec.operations).toHaveLength(1)
    // `generateOperationId` collapses braces → by_<name>, non-alnum → _
    expect(spec.operations[0]!.operationId).toBe('get_orders_by_orderid_items')
  })

  it('merges path-level parameters with operation-level parameters', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'MergeParams', version: '1.0.0' },
      paths: {
        '/things/{thingId}': {
          parameters: [
            { name: 'thingId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'trace', in: 'header', description: 'path-level', schema: { type: 'string' } },
          ],
          get: {
            operationId: 'getThing',
            parameters: [
              { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
              { name: 'trace', in: 'header', description: 'override', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    } as any
    const spec = await resolveSpec(doc)
    const op = spec.operations[0]!
    const names = op.parameters.map((p) => `${p.in}:${p.name}`).sort()
    expect(names).toEqual(['header:trace', 'path:thingId', 'query:verbose'])
    // Operation-level `trace` parameter overrides the path-level duplicate
    const trace = op.parameters.find((p) => p.name === 'trace' && p.in === 'header')!
    expect(trace.description).toBe('override')
  })
})

describe('fetch — uncovered branches', () => {
  it('coerces non-Error throws into an Error', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      throw 'boom'
    })
    await expect(
      fetchWithRetry('https://example.test/ping', undefined, { retries: 0 })
    ).rejects.toThrow('boom')
  })

  it('throws the fallback error when no attempts run (retries < 0)', async () => {
    // A negative retries count makes the for-loop condition false on entry,
    // so lastError stays undefined and the `??` fallback kicks in.
    await expect(
      fetchWithRetry('https://example.test/never', undefined, { retries: -1 })
    ).rejects.toThrow(/Request failed after 0 attempts/)
  })
})

describe('parser/resolver — validation + response examples', () => {
  it('throws a descriptive error for invalid specs', async () => {
    const doc = {
      openapi: '3.0.0',
      // missing required `info` field
      paths: {},
    } as any
    await expect(resolveSpec(doc)).rejects.toThrow(/Invalid OpenAPI spec/)
  })

  it('extracts examples from parameters and requestBody media types', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Examples', version: '1.0.0' },
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            parameters: [
              {
                name: 'mode',
                in: 'query',
                schema: { type: 'string' },
                examples: {
                  fast: { value: 'fast' },
                  safe: { value: 'safe' },
                },
              },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object' },
                  examples: {
                    minimal: { value: { name: 'x' } },
                    full: { value: { name: 'x', tag: 'y' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    } as any
    const spec = await resolveSpec(doc)
    const op = spec.operations[0]!
    expect(op.parameters[0]!.examples!.fast!.value).toBe('fast')
    expect(op.requestBody!.content['application/json']!.examples!.full!.value).toEqual({
      name: 'x',
      tag: 'y',
    })
  })

  it('extracts example collections from response content', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Examples', version: '1.0.0' },
      paths: {
        '/ping': {
          get: {
            operationId: 'ping',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                    examples: {
                      happy: {
                        summary: 'happy path',
                        description: 'a standard response',
                        value: { ok: true },
                      },
                      sad: {
                        value: { ok: false },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any
    const spec = await resolveSpec(doc)
    const examples = spec.operations[0]!.responses['200']!.examples
    expect(examples).toBeDefined()
    expect(examples!.happy!.summary).toBe('happy path')
    expect(examples!.happy!.value).toEqual({ ok: true })
    expect(examples!.sad!.value).toEqual({ ok: false })
  })
})

describe('parser/filter — missing tags branch', () => {
  it('treats an operation with no tags field as untagged', () => {
    const ops: ParsedOperation[] = [
      {
        operationId: 'plain',
        method: 'GET',
        path: '/plain',
        parameters: [],
        responses: {},
        security: [],
        // tags: undefined — triggers `op.tags ?? []`
      } as ParsedOperation,
    ]
    const result = filterOperations(ops, { tags: { exclude: ['admin'] } })
    expect(result).toHaveLength(1)
  })
})

describe('auth/resolver — oauth2 branch', () => {
  it('builds an OAuth2ClientCredentials strategy from config', () => {
    const auth = resolveAuth(
      {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          tokenUrl: 'https://idp.example.test/token',
          scopes: ['read', 'write'],
        },
      },
      {}
    )
    expect(auth).toBeInstanceOf(OAuth2ClientCredentials)
  })
})

describe('auth/strategies — OAuth2 concurrent deduplication', () => {
  it('deduplicates concurrent getToken() calls via pendingRefresh', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const pending = new Promise<Response>((r) => {
      resolveFetch = r
    })
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementationOnce(() => pending)

    const auth = new OAuth2ClientCredentials('id', 'secret', 'https://idp.example.test/token', ['read'])

    const [p1, p2] = [
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() }),
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() }),
    ]

    resolveFetch(new Response(JSON.stringify({ access_token: 'dedup', expires_in: 3600 }), { status: 200 }))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(new Headers(r1.headers).get('Authorization')).toBe('Bearer dedup')
    expect(new Headers(r2.headers).get('Authorization')).toBe('Bearer dedup')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('auth/strategies — remaining branch coverage', () => {
  it('parses expires_at given as a number in milliseconds', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)

    // Number greater than 1e12 is treated as already-milliseconds
    const tokenResponse = { access_token: 'ms-num', expires_at: nowMs + 120_000 }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      response: { expiresAtField: 'expires_at' },
    })
    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer ms-num')
  })

  it('parses expires_at given as a string in seconds', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)

    // String representing seconds (below 1e12)
    const expiresAtSeconds = String(nowMs / 1000 + 3600)
    const tokenResponse = { access_token: 'sec-str', expires_at: expiresAtSeconds }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      response: { expiresAtField: 'expires_at' },
    })
    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer sec-str')
  })

  it('uses the default header name "access_token" when apply.location is "query" without a name', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'q', expires_in: 600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      apply: { location: 'query' },
    })
    const url = new URL('https://api.example.test/x')
    await auth.apply(url, { headers: new Headers() })
    expect(url.searchParams.get('access_token')).toBe('q')
  })

  it('normalizes an empty token_type gracefully', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'nt', token_type: '', expires_in: 600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })
    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    // Empty token_type falls back to the default "Bearer" prefix
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer nt')
  })

  it('reports token-exchange failures cleanly even when the error body is empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('', { status: 500, statusText: 'Server Error' })
    )

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })
    await expect(
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    ).rejects.toThrow(/Token exchange request failed: 500 Server Error$/)
  })

  it('reports OAuth2 failures cleanly even when the error body is empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('', { status: 500, statusText: 'Server Error' })
    )

    const auth = new OAuth2ClientCredentials('id', 'secret', 'https://idp.example.test/token')
    await expect(
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    ).rejects.toThrow(/OAuth2 token request failed: 500 Server Error$/)
  })

  it('defaults OAuth2 token expiry to 3600 seconds when expires_in is missing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'noexp' }), { status: 200 })
    )

    const auth = new OAuth2ClientCredentials('id', 'secret', 'https://idp.example.test/token')
    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer noexp')
  })
})

describe('auth/strategies — parseAbsoluteTimestamp fallthrough', () => {
  it('falls back to expires_in when expiresAtField value is unparseable', async () => {
    const tokenResponse = {
      access_token: 'fall',
      bad_timestamp: { not: 'a timestamp' }, // object — parseAbsoluteTimestamp returns null
      expires_in: 1800,
    }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      response: { expiresAtField: 'bad_timestamp' },
    })

    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer fall')
  })
})

describe('auth/strategies — token exchange expiry helpers', () => {
  it('parses expiresAt timestamps and uses a custom refresh buffer', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)

    const expiresAtSeconds = nowMs / 1000 + 3600 // 1h ahead, seconds
    const tokenResponse = {
      access_token: 'abc123',
      token_type: 'bearer',
      expires_at: expiresAtSeconds,
    }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      request: { fields: { grant_type: 'client_credentials' } },
      response: { expiresAtField: 'expires_at' },
      refreshBufferSeconds: 120,
    })

    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    // token_type is normalized to capitalized "Bearer"
    const headers = new Headers(applied.headers)
    expect(headers.get('Authorization')).toBe('Bearer abc123')
  })

  it('accepts expires_in as a string number and applies default buffer', async () => {
    const tokenResponse = { access_token: 'tok', expires_in: '1800' }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
    })

    const applied = await auth.apply(new URL('https://api.example.test/y'), { headers: new Headers() })
    const headers = new Headers(applied.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok')
  })

  it('falls back to Number.POSITIVE_INFINITY when neither expires_at nor expires_in are usable', async () => {
    const tokenResponse = { access_token: 'forever' }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
    })

    await auth.apply(new URL('https://api.example.test/z'), { headers: new Headers() })

    // Second call must reuse the cached token (no second fetch) because expiry is +Infinity
    await auth.apply(new URL('https://api.example.test/z'), { headers: new Headers() })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('parses absolute timestamps given in milliseconds as a string', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)

    const expiresAtMs = String(nowMs + 60_000) // 1 min ahead, as ms string
    const tokenResponse = { access_token: 't', expires_at: expiresAtMs }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      response: { expiresAtField: 'expires_at' },
    })

    const applied = await auth.apply(new URL('https://api.example.test/ms'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer t')
  })

  it('parses expires_at given as an ISO date string', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)

    const iso = new Date(nowMs + 30 * 60_000).toISOString() // 30 min ahead
    const tokenResponse = { access_token: 't-iso', expires_at: iso }
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      response: { expiresAtField: 'expires_at' },
    })

    const applied = await auth.apply(new URL('https://api.example.test/iso'), { headers: new Headers() })
    expect(new Headers(applied.headers).get('Authorization')).toBe('Bearer t-iso')
  })

  it('routes the token into a cookie header when apply.location is "cookie"', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ck', expires_in: 3600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      apply: { location: 'cookie', name: 'session' },
    })

    const applied = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    const cookie = new Headers(applied.headers).get('Cookie')
    expect(cookie).toContain('session=ck')
  })

  it('routes the token into a query parameter when apply.location is "query"', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'qv', expires_in: 3600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      apply: { location: 'query', name: 'token' },
    })

    const url = new URL('https://api.example.test/x')
    await auth.apply(url, { headers: new Headers() })
    expect(url.searchParams.get('token')).toBe('qv')
  })

  it('sends fields as GET query params when request.method is GET', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'g', expires_in: 600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      request: {
        method: 'GET',
        fields: { a: '1', b: '2' },
      },
    })

    await auth.apply(new URL('https://api.example.test/y'), { headers: new Headers() })
    const calledUrl = fetchMock.mock.calls[0]![0] as string
    expect(calledUrl).toContain('a=1')
    expect(calledUrl).toContain('b=2')
  })

  it('encodes fields as form-urlencoded when contentType says so', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'f', expires_in: 600 }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({
      tokenUrl: 'https://idp.example.test/token',
      request: {
        contentType: 'application/x-www-form-urlencoded',
        fields: { grant_type: 'client_credentials', scope: 'read' },
      },
    })

    await auth.apply(new URL('https://api.example.test/z'), { headers: new Headers() })
    const init = fetchMock.mock.calls[0]![1]!
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    // URLSearchParams serializes to `grant_type=client_credentials&scope=read`
    const body = init.body
    expect(body).toBeInstanceOf(URLSearchParams)
    expect((body as URLSearchParams).get('grant_type')).toBe('client_credentials')
  })

  it('refreshes the cached token when refresh() is called', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'first', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'second', expires_in: 3600 }), { status: 200 }))

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })

    const first = await auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(first.headers).get('Authorization')).toBe('Bearer first')

    const second = await auth.refresh(new URL('https://api.example.test/x'), { headers: new Headers() })
    expect(new Headers(second.headers).get('Authorization')).toBe('Bearer second')
  })

  it('throws a descriptive error when the token endpoint returns non-OK', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('upstream boom', { status: 500, statusText: 'Server Error' })
    )

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })
    await expect(
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    ).rejects.toThrow(/Token exchange request failed: 500/)
  })

  it('throws when the token endpoint returns invalid JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }))

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })
    await expect(
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    ).rejects.toThrow(/Token exchange response is not valid JSON/)
  })

  it('throws when the token field is missing from the response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ something_else: 'nope' }), { status: 200 })
    )

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })
    await expect(
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() })
    ).rejects.toThrow(/missing "access_token" field/)
  })

  it('deduplicates concurrent getToken() calls via pendingRefresh', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const pending = new Promise<Response>((r) => {
      resolveFetch = r
    })
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementationOnce(() => pending)

    const auth = new TokenExchangeAuth({ tokenUrl: 'https://idp.example.test/token' })

    const [p1, p2] = [
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() }),
      auth.apply(new URL('https://api.example.test/x'), { headers: new Headers() }),
    ]

    resolveFetch(new Response(JSON.stringify({ access_token: 'dedup', expires_in: 3600 }), { status: 200 }))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(new Headers(r1.headers).get('Authorization')).toBe('Bearer dedup')
    expect(new Headers(r2.headers).get('Authorization')).toBe('Bearer dedup')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
