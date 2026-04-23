export interface SpecSource {
  kind: 'url' | 'file' | 'inline'
  value: string
}

export interface BundleShimParams {
  /** Name of the generated binary, e.g. 'petstore-mcp' */
  name: string
  /** Version string shown in the shim header */
  version: string
  /** Description shown in the shim header */
  description: string
  /** npm package name of the runner the shim will exec, e.g. 'dynamic-openapi-mcp' */
  runnerPackage: string
  /** Label used for shell variable prefixes and header text (e.g. 'MCP' → MCP_NAME, MCP_VERSION) */
  kindLabel: string
  /**
   * Bash snippet injected after `exec "${RUNNER[@]}"` describing how to invoke the runner
   * once the spec has been decoded into $SPEC_FILE. Line-continuations with `\` are preserved.
   *
   * @example
   *   // for dynamic-openapi-mcp:
   *   '--source "$SPEC_FILE" "${PASSTHROUGH[@]}"'
   * @example
   *   // for dynamic-openapi-cli:
   *   '--spec "$SPEC_FILE" --name "$CLI_NAME" --app-version "$CLI_VERSION" "${PASSTHROUGH[@]}"'
   */
  runnerInvocation: string
  /**
   * Optional printf format string shown when `install` succeeds and the target dir is on PATH.
   * The single %s is replaced with the installed symlink path.
   */
  installSuccessHint?: string
  /** Spec origin captured in the shim so `update` can re-fetch */
  specSource: SpecSource
  /** Base64-encoded JSON of the dereferenced spec */
  specBase64: string
  /** MD5 hash of the JSON-stringified dereferenced spec */
  specMd5: string
}

export interface BuildBundleOptions {
  /** Spec source as passed by the user (URL, file path, or inline text) */
  source: string
  /** Name of the generated binary (also written to the shim as ${KIND}_NAME) */
  name: string
  /** Output path where the shim will be written */
  out: string
  /** npm package name of the runner that the shim will exec */
  runnerPackage: string
  /** Label for shell variable prefix and header text */
  kindLabel: string
  /** Bash snippet describing runner invocation, see {@link BundleShimParams.runnerInvocation} */
  runnerInvocation: string
  /** Optional hint shown after a successful `install` */
  installSuccessHint?: string
  /** Override for the version shown in the shim (default: spec.info.version) */
  appVersion?: string
  /** Override for the description shown in the shim (default: spec.info.title) */
  description?: string
}

export interface BuildBundleResult {
  /** Byte size of the written shim */
  bytes: number
  /** Number of operations in the parsed spec */
  operations: number
  /** Version that was baked into the shim */
  version: string
  /** MD5 of the embedded spec */
  md5: string
  /** Spec source captured in the shim */
  specSource: SpecSource
}
