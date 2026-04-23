import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadSpec, resolveSource } from '../src/parser/loader.js'

describe('resolveSource', () => {
  it('returns inline type for objects', () => {
    const result = resolveSource({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {} } as any)
    expect(result.type).toBe('inline')
  })

  it('returns url type for http URLs', () => {
    expect(resolveSource('https://api.test.com/spec.json').type).toBe('url')
    expect(resolveSource('http://api.test.com/spec.json').type).toBe('url')
  })

  it('returns inline type for JSON strings', () => {
    const result = resolveSource('{"openapi":"3.0.3"}')
    expect(result.type).toBe('inline')
  })

  it('returns inline type for YAML-like strings', () => {
    const result = resolveSource('openapi: "3.0.3"\ninfo:\n  title: Test')
    expect(result.type).toBe('inline')
  })

  it('returns file type for file paths', () => {
    expect(resolveSource('./spec.yaml').type).toBe('file')
    expect(resolveSource('/absolute/path/spec.json').type).toBe('file')
  })
})

describe('loadSpec', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads inline object', async () => {
    const doc = await loadSpec({
      openapi: '3.0.3',
      info: { title: 'Inline', version: '1.0.0' },
      paths: {},
    })
    expect(doc.info.title).toBe('Inline')
  })

  it('loads inline JSON string', async () => {
    const json = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'JSONStr', version: '1.0.0' },
      paths: {},
    })
    const doc = await loadSpec(json)
    expect(doc.info.title).toBe('JSONStr')
  })

  it('loads inline YAML string', async () => {
    const yaml = 'openapi: "3.0.3"\ninfo:\n  title: YAMLStr\n  version: "1.0.0"\npaths: {}'
    const doc = await loadSpec(yaml)
    expect(doc.info.title).toBe('YAMLStr')
  })

  it('throws on invalid file path', async () => {
    await expect(loadSpec('/nonexistent/path/spec.yaml')).rejects.toThrow('Failed to read spec file')
  })

  it('throws on invalid JSON inline', async () => {
    await expect(loadSpec('{invalid json')).rejects.toThrow('Failed to parse JSON')
  })

  it('loads from URL', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ openapi: '3.0.3', info: { title: 'Remote', version: '1.0.0' }, paths: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', mockFetch)

    const doc = await loadSpec('https://api.test.com/spec.json')
    expect(doc.info.title).toBe('Remote')
  })

  it('throws on failed URL fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(loadSpec('https://api.test.com/spec.json')).rejects.toThrow('Failed to fetch spec')
  })
})
