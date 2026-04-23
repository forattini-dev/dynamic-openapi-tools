import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

export interface TokenCacheEntry {
  token: string
  expiresAt: number
  tokenType?: string
}

export interface TokenCache {
  read(key: string): Promise<TokenCacheEntry | null>
  write(key: string, entry: TokenCacheEntry): Promise<void>
  clear(key: string): Promise<void>
}

export class MemoryTokenCache implements TokenCache {
  private store = new Map<string, TokenCacheEntry>()

  async read(key: string): Promise<TokenCacheEntry | null> {
    return this.store.get(key) ?? null
  }

  async write(key: string, entry: TokenCacheEntry): Promise<void> {
    this.store.set(key, entry)
  }

  async clear(key: string): Promise<void> {
    this.store.delete(key)
  }
}

interface FileCacheShape {
  version: 1
  entries: Record<string, TokenCacheEntry>
}

export class FileTokenCache implements TokenCache {
  private readonly filePath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultCacheFilePath()
  }

  async read(key: string): Promise<TokenCacheEntry | null> {
    const data = await this.load()
    const entry = data.entries[key]
    if (!entry) return null
    if (Number.isFinite(entry.expiresAt) && Date.now() >= entry.expiresAt) {
      return null
    }
    return entry
  }

  async write(key: string, entry: TokenCacheEntry): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.load()
      data.entries[key] = entry
      await this.persist(data)
    })
    return this.writeQueue
  }

  async clear(key: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.load()
      if (!(key in data.entries)) return
      delete data.entries[key]
      await this.persist(data)
    })
    return this.writeQueue
  }

  private async load(): Promise<FileCacheShape> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<FileCacheShape>
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return { version: 1, entries: parsed.entries }
      }
    } catch {
      // missing or unreadable — treat as empty cache
    }
    return { version: 1, entries: {} }
  }

  private async persist(data: FileCacheShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  async purge(): Promise<void> {
    try {
      await unlink(this.filePath)
    } catch {
      // nothing to purge
    }
  }
}

export function defaultCacheFilePath(): string {
  const xdg = process.env['XDG_CACHE_HOME']
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.cache')
  return join(base, 'dynamic-openapi-tools', 'tokens.json')
}

export function hashKey(components: Record<string, string | string[] | undefined>): string {
  const entries: Array<[string, string | string[]]> = []
  for (const [k, v] of Object.entries(components)) {
    if (v === undefined) continue
    entries.push([k, Array.isArray(v) ? [...v].sort() : v])
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32)
}

export type TokenCacheOption = TokenCache | 'memory' | 'file' | { type: 'file'; path?: string }

export function resolveTokenCache(option: TokenCacheOption | undefined): TokenCache {
  if (!option || option === 'memory') return new MemoryTokenCache()
  if (option === 'file') return new FileTokenCache()
  if (typeof option === 'object' && 'type' in option && option.type === 'file') {
    return new FileTokenCache(option.path)
  }
  return option as TokenCache
}
