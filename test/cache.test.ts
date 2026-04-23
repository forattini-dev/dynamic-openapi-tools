import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileTokenCache,
  MemoryTokenCache,
  defaultCacheFilePath,
  hashKey,
  resolveTokenCache,
} from '../src/auth/cache.js'

describe('MemoryTokenCache', () => {
  it('round-trips an entry', async () => {
    const cache = new MemoryTokenCache()
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    const got = await cache.read('k')
    expect(got?.token).toBe('t')
  })

  it('clears an entry', async () => {
    const cache = new MemoryTokenCache()
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    await cache.clear('k')
    expect(await cache.read('k')).toBeNull()
  })

  it('returns null for missing keys', async () => {
    const cache = new MemoryTokenCache()
    expect(await cache.read('missing')).toBeNull()
  })
})

describe('FileTokenCache', () => {
  let dir: string
  let file: string
  let cache: FileTokenCache

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokencache-'))
    file = join(dir, 'tokens.json')
    cache = new FileTokenCache(file)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a file with mode 0600', async () => {
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    const s = await stat(file)
    // Permission mask lower 9 bits should be 0o600 on POSIX
    expect((s.mode & 0o777).toString(8)).toBe('600')
  })

  it('persists across instances', async () => {
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    const other = new FileTokenCache(file)
    const got = await other.read('k')
    expect(got?.token).toBe('t')
  })

  it('serializes concurrent writes', async () => {
    await Promise.all([
      cache.write('a', { token: 'A', expiresAt: Date.now() + 10_000 }),
      cache.write('b', { token: 'B', expiresAt: Date.now() + 10_000 }),
      cache.write('c', { token: 'C', expiresAt: Date.now() + 10_000 }),
    ])
    const content = JSON.parse(await readFile(file, 'utf-8')) as {
      entries: Record<string, { token: string }>
    }
    expect(content.entries['a']?.token).toBe('A')
    expect(content.entries['b']?.token).toBe('B')
    expect(content.entries['c']?.token).toBe('C')
  })

  it('returns null for expired entries', async () => {
    await cache.write('k', { token: 't', expiresAt: Date.now() - 1 })
    expect(await cache.read('k')).toBeNull()
  })

  it('clear removes the entry but preserves siblings', async () => {
    await cache.write('keep', { token: 'K', expiresAt: Date.now() + 10_000 })
    await cache.write('drop', { token: 'D', expiresAt: Date.now() + 10_000 })
    await cache.clear('drop')
    expect(await cache.read('drop')).toBeNull()
    expect((await cache.read('keep'))?.token).toBe('K')
  })

  it('tolerates missing / malformed cache files', async () => {
    // first read with no file
    expect(await cache.read('k')).toBeNull()
    // write garbage, then read
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    await rm(file)
    expect(await cache.read('k')).toBeNull()
  })

  it('purge removes the backing file', async () => {
    await cache.write('k', { token: 't', expiresAt: Date.now() + 10_000 })
    await cache.purge()
    await expect(stat(file)).rejects.toThrow()
  })

  it('purge is a no-op when the file is already missing', async () => {
    // no writes — nothing to unlink
    await expect(cache.purge()).resolves.toBeUndefined()
  })

  it('clear is a no-op when the key is absent', async () => {
    await cache.write('present', { token: 'P', expiresAt: Date.now() + 10_000 })
    await expect(cache.clear('missing')).resolves.toBeUndefined()
    expect((await cache.read('present'))?.token).toBe('P')
  })
})

describe('defaultCacheFilePath', () => {
  it('respects XDG_CACHE_HOME', () => {
    const prev = process.env['XDG_CACHE_HOME']
    process.env['XDG_CACHE_HOME'] = '/tmp/xdg-cache'
    try {
      expect(defaultCacheFilePath()).toBe('/tmp/xdg-cache/dynamic-openapi-tools/tokens.json')
    } finally {
      if (prev === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = prev
    }
  })

  it('falls back to ~/.cache when XDG is unset', () => {
    const prev = process.env['XDG_CACHE_HOME']
    delete process.env['XDG_CACHE_HOME']
    try {
      expect(defaultCacheFilePath()).toMatch(/\.cache\/dynamic-openapi-tools\/tokens\.json$/)
    } finally {
      if (prev !== undefined) process.env['XDG_CACHE_HOME'] = prev
    }
  })
})

describe('hashKey', () => {
  it('is stable for equal inputs regardless of key order', () => {
    const a = hashKey({ a: '1', b: '2', c: ['x', 'y'] })
    const b = hashKey({ c: ['y', 'x'], b: '2', a: '1' })
    expect(a).toBe(b)
  })

  it('differs for different inputs', () => {
    expect(hashKey({ a: '1' })).not.toBe(hashKey({ a: '2' }))
  })

  it('ignores undefined components', () => {
    const a = hashKey({ a: '1', b: undefined })
    const b = hashKey({ a: '1' })
    expect(a).toBe(b)
  })

  it('produces a 32-char hex prefix', () => {
    expect(hashKey({ a: '1' })).toMatch(/^[a-f0-9]{32}$/)
  })
})

describe('resolveTokenCache', () => {
  it("returns MemoryTokenCache by default and for 'memory'", () => {
    expect(resolveTokenCache(undefined)).toBeInstanceOf(MemoryTokenCache)
    expect(resolveTokenCache('memory')).toBeInstanceOf(MemoryTokenCache)
  })

  it("returns FileTokenCache for 'file'", () => {
    expect(resolveTokenCache('file')).toBeInstanceOf(FileTokenCache)
  })

  it('accepts a { type: "file", path } object', () => {
    const got = resolveTokenCache({ type: 'file', path: '/tmp/test.json' })
    expect(got).toBeInstanceOf(FileTokenCache)
  })

  it('passes through a TokenCache instance', () => {
    const custom = new MemoryTokenCache()
    expect(resolveTokenCache(custom)).toBe(custom)
  })
})
