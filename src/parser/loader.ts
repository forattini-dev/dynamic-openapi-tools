import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { OpenAPIV3 } from 'openapi-types'
import { fetchWithRetry } from '../utils/fetch.js'

export function resolveSource(source: string | OpenAPIV3.Document) {
  if (typeof source !== 'string') {
    return { type: 'inline' as const, value: source }
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { type: 'url' as const, value: source }
  }

  if (source.trim().startsWith('{') || source.trim().startsWith('openapi')) {
    return { type: 'inline' as const, value: source }
  }

  return { type: 'file' as const, value: source }
}

export async function loadSpec(source: string | OpenAPIV3.Document): Promise<OpenAPIV3.Document> {
  const resolved = resolveSource(source)

  switch (resolved.type) {
    case 'url': {
      const res = await fetchWithRetry(resolved.value)
      if (!res.ok) {
        throw new Error(`Failed to fetch spec from ${resolved.value}: ${res.status} ${res.statusText}`)
      }
      const text = await res.text()
      return parseSpecText(text, resolved.value)
    }

    case 'file': {
      let text: string
      try {
        text = await readFile(resolved.value, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to read spec file "${resolved.value}": ${msg}`)
      }
      return parseSpecText(text, resolved.value)
    }

    case 'inline': {
      if (typeof resolved.value === 'string') {
        return parseSpecText(resolved.value, '(inline)')
      }
      return resolved.value
    }
  }
}

function parseSpecText(text: string, source: string): OpenAPIV3.Document {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to parse JSON spec from ${source}: ${msg}`)
    }
  }

  try {
    return parseYaml(trimmed) as OpenAPIV3.Document
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse YAML spec from ${source}: ${msg}`)
  }
}
