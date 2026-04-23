import { createHash } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { loadSpec, resolveSource } from '../parser/loader.js'
import { resolveSpec } from '../parser/resolver.js'
import { renderBundleShim } from './render.js'
import type { BuildBundleOptions, BuildBundleResult, SpecSource } from './types.js'

/**
 * Build a standalone bash bundle that embeds an OpenAPI spec and execs a runner
 * package at startup. The returned result reports what was written; consumers
 * can log a human-readable summary using those fields.
 *
 * The user-provided `source` is preserved verbatim in the shim (no `path.resolve`)
 * so that committed bundles do not leak absolute host paths. Use URLs for fully
 * portable bundles.
 */
export async function buildBundle(options: BuildBundleOptions): Promise<BuildBundleResult> {
  const doc = await loadSpec(options.source)
  const spec = await resolveSpec(doc)

  const json = JSON.stringify(spec.raw)
  const base64 = Buffer.from(json, 'utf-8').toString('base64')
  const md5 = createHash('md5').update(json).digest('hex')

  const version = options.appVersion ?? spec.version
  const description = options.description ?? spec.title
  const specSource = computeSpecSource(options.source)

  const script = renderBundleShim({
    name: options.name,
    version,
    description,
    runnerPackage: options.runnerPackage,
    kindLabel: options.kindLabel,
    runnerInvocation: options.runnerInvocation,
    installSuccessHint: options.installSuccessHint,
    specSource,
    specBase64: base64,
    specMd5: md5,
  })

  await writeFile(options.out, script, 'utf-8')
  await chmod(options.out, 0o755)

  return {
    bytes: Buffer.byteLength(script, 'utf-8'),
    operations: spec.operations.length,
    version,
    md5,
    specSource,
  }
}

function computeSpecSource(source: string): SpecSource {
  const resolved = resolveSource(source)
  switch (resolved.type) {
    case 'url':
      return { kind: 'url', value: String(resolved.value) }
    case 'file':
      // Store the user's input path verbatim — do NOT path.resolve.
      // Absolute paths would leak the author's host filesystem into committed bundles.
      return { kind: 'file', value: String(resolved.value) }
    case 'inline':
      return { kind: 'inline', value: '' }
  }
}
