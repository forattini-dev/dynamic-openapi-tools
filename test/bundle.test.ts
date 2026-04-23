import { describe, it, expect } from 'vitest'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildBundle } from '../src/bundle/build.js'
import { renderBundleShim } from '../src/bundle/render.js'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'petstore.yaml')

describe('buildBundle', () => {
  it('writes an executable bash shim with the embedded spec', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tools-bundle-'))
    try {
      const out = path.join(dir, 'petstore-mcp')
      const result = await buildBundle({
        source: FIXTURE,
        name: 'petstore-mcp',
        out,
        runnerPackage: 'dynamic-openapi-mcp',
        kindLabel: 'MCP',
        runnerInvocation: '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"',
        installSuccessHint: 'Point your MCP client at:  %s',
        appVersion: '2.3.4',
      })

      expect(result.operations).toBe(5)
      expect(result.version).toBe('2.3.4')
      expect(result.specSource.kind).toBe('file')

      const content = await readFile(out, 'utf-8')
      expect(content.startsWith('#!/usr/bin/env bash\n')).toBe(true)
      expect(content).toMatch(/MCP_NAME='petstore-mcp'/)
      expect(content).toMatch(/MCP_VERSION='2.3.4'/)
      expect(content).toMatch(/SPEC_B64='[A-Za-z0-9+/=]+'/)
      expect(content).toMatch(/SPEC_MD5='[0-9a-f]{32}'/)
      expect(content).toMatch(/npx --yes dynamic-openapi-mcp/)
      expect(content).toMatch(/--source "\$SPEC_FILE"/)
      expect(content).toContain('Point your MCP client at:')

      const stats = await stat(out)
      expect(stats.mode & 0o111).toBeGreaterThan(0)

      const b64Match = content.match(/SPEC_B64='([^']+)'/)
      const decoded = Buffer.from(b64Match![1]!, 'base64').toString('utf-8')
      const spec = JSON.parse(decoded) as { info: { title: string } }
      expect(spec.info.title).toBe('Petstore')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('supports CLI-style invocation (--spec + --name + --app-version)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tools-bundle-'))
    try {
      const out = path.join(dir, 'petstore-cli')
      await buildBundle({
        source: FIXTURE,
        name: 'petstore-cli',
        out,
        runnerPackage: 'dynamic-openapi-cli',
        kindLabel: 'CLI',
        runnerInvocation:
          '--spec "$SPEC_FILE" --name "$CLI_NAME" --app-version "$CLI_VERSION" "${PASSTHROUGH[@]}"',
        installSuccessHint: 'Run:  %s --help',
      })

      const content = await readFile(out, 'utf-8')
      expect(content).toMatch(/CLI_NAME='petstore-cli'/)
      expect(content).toMatch(/npx --yes dynamic-openapi-cli/)
      expect(content).toMatch(/--spec "\$SPEC_FILE"/)
      expect(content).toMatch(/--name "\$CLI_NAME"/)
      expect(content).toMatch(/--app-version "\$CLI_VERSION"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves the user-provided source verbatim (no absolute-path leak)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tools-bundle-'))
    try {
      const out = path.join(dir, 'relative-cli')
      // Resolve the source relative to cwd before calling so we simulate a consumer
      // passing a relative path — the stored SPEC_SOURCE must match exactly, not be absolutized.
      const relative = path.relative(process.cwd(), FIXTURE)
      await buildBundle({
        source: relative,
        name: 'relative-cli',
        out,
        runnerPackage: 'dynamic-openapi-mcp',
        kindLabel: 'MCP',
        runnerInvocation: '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"',
      })

      const content = await readFile(out, 'utf-8')
      expect(content).toContain(`SPEC_SOURCE='${relative}'`)
      expect(content).not.toContain(path.resolve(FIXTURE))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marks inline-spec bundles with an empty SPEC_SOURCE so update fails loud', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tools-bundle-'))
    try {
      const out = path.join(dir, 'inline')
      const specText = await readFile(FIXTURE, 'utf-8')
      await buildBundle({
        source: specText,
        name: 'inline-mcp',
        out,
        runnerPackage: 'dynamic-openapi-mcp',
        kindLabel: 'MCP',
        runnerInvocation: '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"',
      })

      const content = await readFile(out, 'utf-8')
      expect(content).toMatch(/SPEC_SOURCE_KIND='inline'/)
      expect(content).toContain(`SPEC_SOURCE=''`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('defaults version and description to the spec', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tools-bundle-'))
    try {
      const out = path.join(dir, 'defaults')
      const result = await buildBundle({
        source: FIXTURE,
        name: 'defaults',
        out,
        runnerPackage: 'dynamic-openapi-mcp',
        kindLabel: 'MCP',
        runnerInvocation: '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"',
      })
      expect(result.version).toBe('1.0.0')
      const content = await readFile(out, 'utf-8')
      expect(content).toMatch(/MCP_VERSION='1.0.0'/)
      expect(content).toMatch(/MCP_DESCRIPTION='Petstore'/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('renderBundleShim', () => {
  it('escapes single quotes in name and description', () => {
    const shim = renderBundleShim({
      name: "dangerous'name",
      version: '1.0',
      description: "it's tricky",
      runnerPackage: 'dynamic-openapi-mcp',
      kindLabel: 'MCP',
      runnerInvocation: '--source "$SPEC_FILE"',
      specSource: { kind: 'file', value: 'test/fixtures/petstore.yaml' },
      specBase64: 'e30=',
      specMd5: 'abc',
    })
    expect(shim).toMatch(/MCP_NAME='dangerous'\\''name'/)
    expect(shim).toMatch(/MCP_DESCRIPTION='it'\\''s tricky'/)
  })

  it('uses the default install-success hint when none is provided', () => {
    const shim = renderBundleShim({
      name: 'x',
      version: '1',
      description: 'x',
      runnerPackage: 'dynamic-openapi-mcp',
      kindLabel: 'MCP',
      runnerInvocation: '--source "$SPEC_FILE"',
      specSource: { kind: 'inline', value: '' },
      specBase64: 'e30=',
      specMd5: 'abc',
    })
    expect(shim).toMatch(/Run:  %s/)
  })
})
