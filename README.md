# dynamic-openapi-tools

Shared building blocks for the `dynamic-openapi-{cli,mcp,skill}` family.

## What's inside

| Module | Exports | Used by |
|:-------|:--------|:--------|
| `dynamic-openapi-tools/parser` | `loadSpec`, `resolveSpec`, `filterOperations`, `resolveSource`, types (`ParsedSpec`, `ParsedOperation`, ...) | cli, mcp, skill |
| `dynamic-openapi-tools/auth`   | `resolveAuth`, `BearerAuth`, `ApiKeyAuth`, `BasicAuth`, `OAuth2ClientCredentials`, `TokenExchangeAuth`, `CustomAuth`, `CompositeAuth` | cli, mcp |
| `dynamic-openapi-tools/bundle` | `buildBundle`, `renderBundleShim` (parameterized bash shim generator for standalone binaries) | cli, mcp |
| `dynamic-openapi-tools/utils`  | `fetchWithRetry`, `sanitizeToolName`, `truncateDescription` | cli, mcp |

The root entry (`dynamic-openapi-tools`) re-exports everything.

## Install

```bash
pnpm add dynamic-openapi-tools
```

## Bundle example

The `bundle` module is parameterized — each consumer passes the `runnerPackage`
(npm package name to exec at runtime), `kindLabel` (variable prefix in the generated
shim), and a bash `runnerInvocation` snippet describing how to invoke the runner
once the spec has been decoded to `$SPEC_FILE`.

```ts
import { buildBundle } from 'dynamic-openapi-tools/bundle'

// MCP-style bundle: runner receives --source
await buildBundle({
  source: './petstore.yaml',
  name: 'petstore-mcp',
  out: './bin/petstore-mcp',
  runnerPackage: 'dynamic-openapi-mcp',
  kindLabel: 'MCP',
  runnerInvocation: '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"',
  installSuccessHint: 'Point your MCP client at:  %s',
})

// CLI-style bundle: runner also receives --name and --app-version
await buildBundle({
  source: './petstore.yaml',
  name: 'petstore-cli',
  out: './bin/petstore-cli',
  runnerPackage: 'dynamic-openapi-cli',
  kindLabel: 'CLI',
  runnerInvocation:
    '--spec "$SPEC_FILE" --name "$CLI_NAME" --app-version "$CLI_VERSION" "${PASSTHROUGH[@]}"',
  installSuccessHint: 'Run:  %s --help',
})
```

Generated shims expose `--show-spec`, `--spec-md5`, `--spec <override>`, `install`,
`uninstall`, and `update` — regardless of the runner.

## The family

| Package | Role |
|:--------|:-----|
| [`dynamic-openapi-cli`](https://github.com/forattini-dev/dynamic-openapi-cli) | Generic CLI for any OpenAPI spec |
| [`dynamic-openapi-mcp`](https://github.com/forattini-dev/dynamic-openapi-mcp) | MCP server for any OpenAPI spec |
| [`dynamic-openapi-skill`](https://github.com/forattini-dev/dynamic-openapi-skill) | Claude Code skill generator for any OpenAPI spec |

## License

MIT
