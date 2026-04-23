import type { OpenAPIV3 } from 'openapi-types'
import type { ResolvedAuth } from '../types.js'
import { OAuth2AuthCodeFlow, type OAuth2AuthCodeConfig } from './oauth2-auth-code.js'

export const DEFAULT_APP_NAME = 'global'

export interface DetectedOAuth2AuthCode {
  schemeName: string
  config: OAuth2AuthCodeConfig
}

export interface DetectOptions {
  /**
   * Cache file name for the resolved token. Each consumer (dynamic-openapi-cli,
   * dynamic-openapi-mcp, bundled shims, …) should pass its own name; defaults
   * to DEFAULT_APP_NAME (`global`).
   */
  appName?: string
  /** Override process.env (testing). */
  env?: NodeJS.ProcessEnv
}

/**
 * Scan `securitySchemes` for an OAuth2 scheme whose `authorizationCode` flow
 * is configured and for which a client id is available in the environment.
 * Returns the first match (specs almost never declare more than one).
 */
export function detectOAuth2AuthCode(
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>,
  options: DetectOptions | NodeJS.ProcessEnv = {}
): DetectedOAuth2AuthCode | null {
  const normalized = normalizeOptions(options)
  const env = normalized.env ?? process.env
  const appName = normalized.appName ?? DEFAULT_APP_NAME
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (!scheme || scheme.type !== 'oauth2') continue
    const flow = (scheme as OpenAPIV3.OAuth2SecurityScheme).flows?.authorizationCode
    if (!flow) continue

    const schemeEnv = envKeyFor(name)
    const clientId = env[`OPENAPI_AUTH_${schemeEnv}_CLIENT_ID`] ?? env['OPENAPI_OAUTH2_CLIENT_ID']
    if (!clientId) continue

    const clientSecret =
      env[`OPENAPI_AUTH_${schemeEnv}_CLIENT_SECRET`] ?? env['OPENAPI_OAUTH2_CLIENT_SECRET']
    const scopeOverride =
      env[`OPENAPI_AUTH_${schemeEnv}_SCOPES`] ?? env['OPENAPI_OAUTH2_SCOPES']
    const portEnv = env[`OPENAPI_AUTH_${schemeEnv}_PORT`] ?? env['OPENAPI_OAUTH2_PORT']
    const redirectUri =
      env[`OPENAPI_AUTH_${schemeEnv}_REDIRECT_URI`] ?? env['OPENAPI_OAUTH2_REDIRECT_URI']

    const scopes = scopeOverride
      ? scopeOverride.split(/[\s,]+/).filter(Boolean)
      : Object.keys(flow.scopes ?? {})

    const config: OAuth2AuthCodeConfig = {
      appName,
      schemeName: name,
      clientId,
      authorizationUrl: flow.authorizationUrl,
      tokenUrl: flow.tokenUrl,
      scopes,
    }
    if (clientSecret) config.clientSecret = clientSecret
    if (redirectUri) config.redirectUri = redirectUri
    if (portEnv) {
      const port = Number.parseInt(portEnv, 10)
      if (!Number.isNaN(port) && port > 0) config.redirectPort = port
    }

    return { schemeName: name, config }
  }

  return null
}

export function createOAuth2AuthCodeAuth(config: OAuth2AuthCodeConfig): ResolvedAuth & { forceLogin(): Promise<unknown>; logout(): Promise<void> } {
  return new OAuth2AuthCodeFlow(config)
}

function envKeyFor(schemeName: string): string {
  return schemeName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function normalizeOptions(options: DetectOptions | NodeJS.ProcessEnv): DetectOptions {
  // Heuristic: a DetectOptions has at most two known keys; anything else is
  // a raw env map (legacy callers that pass process.env directly).
  const keys = Object.keys(options)
  if (keys.length === 0) return {}
  const looksLikeOptions = keys.every((k) => k === 'appName' || k === 'env')
  if (looksLikeOptions) return options as DetectOptions
  return { env: options as NodeJS.ProcessEnv }
}
