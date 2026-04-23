import type { ResolvedAuth } from '../types.js'
import { openBrowser } from './browser.js'
import { captureCallback } from './loopback-server.js'
import { generatePkce, generateState } from './pkce.js'
import {
  readTokenCache,
  writeTokenCache,
  deleteTokenCache,
  type CachedToken,
  type TokenCacheKey,
} from './token-cache.js'

export interface OAuth2AuthCodeConfig {
  /**
   * Application name — used as the token cache file name and the encryption
   * password. "global" for the raw dynamic CLI; the bundle's --name otherwise.
   */
  appName: string
  /** Scheme name from the spec (used for user-facing messages and cache section). */
  schemeName: string
  clientId: string
  /** Optional for public clients (when the authorization server accepts PKCE alone). */
  clientSecret?: string
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  /** Loopback port for the redirect listener. Defaults to 7999. */
  redirectPort?: number
  /** Explicit redirect URI override (some providers require pre-registration). */
  redirectUri?: string
  /** Extra query params added to the authorization URL (audience, prompt, …). */
  extraAuthParams?: Record<string, string>
  /** Seconds to subtract from `expires_in` when deciding if a token is still fresh. */
  refreshBufferSeconds?: number
}

interface TokenEndpointResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

const DEFAULT_REDIRECT_PORT = 7999
const DEFAULT_REFRESH_BUFFER_SECONDS = 30

/**
 * OAuth2 authorization-code flow with PKCE. Caches tokens on disk under
 * $XDG_DATA_HOME/dynamic-openapi-tools/<appName>.env (AES-256-GCM encrypted,
 * key derived from appName — symbolic at-rest protection). Refreshes tokens
 * transparently, and triggers a browser login on first use or when refresh
 * fails.
 */
export class OAuth2AuthCodeFlow implements ResolvedAuth {
  private config: OAuth2AuthCodeConfig
  private cacheKey: TokenCacheKey
  private cached?: CachedToken
  private pendingTokenRequest?: Promise<string>

  constructor(config: OAuth2AuthCodeConfig) {
    this.config = config
    this.cacheKey = { appName: config.appName, schemeName: config.schemeName }
  }

  async apply(_url: URL, init: RequestInit): Promise<RequestInit> {
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }

  async refresh(_url: URL, init: RequestInit): Promise<RequestInit> {
    this.cached = undefined
    await deleteTokenCache(this.cacheKey)
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }

  /** Force a fresh login, bypassing the cache. Used by the `login` subcommand. */
  async forceLogin(): Promise<CachedToken> {
    this.cached = undefined
    await deleteTokenCache(this.cacheKey)
    const token = await this.runLoginFlow()
    return token
  }

  /** Wipe the cached token. Used by the `logout` subcommand. */
  async logout(): Promise<void> {
    this.cached = undefined
    await deleteTokenCache(this.cacheKey)
  }

  private async getAccessToken(): Promise<string> {
    if (this.pendingTokenRequest) return this.pendingTokenRequest

    this.pendingTokenRequest = this.resolveToken().finally(() => {
      this.pendingTokenRequest = undefined
    })
    return this.pendingTokenRequest
  }

  private async resolveToken(): Promise<string> {
    if (!this.cached) this.cached = (await readTokenCache(this.cacheKey)) ?? undefined

    const buffer = (this.config.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
    const now = Date.now()

    if (this.cached && this.cached.expires_at - buffer > now) {
      return this.cached.access_token
    }

    if (this.cached?.refresh_token) {
      try {
        const refreshed = await this.runRefreshFlow(this.cached.refresh_token)
        return refreshed.access_token
      } catch (error) {
        process.stderr.write(
          `oauth2 ${this.config.schemeName}: refresh failed (${describeError(error)}), falling back to interactive login\n`
        )
      }
    }

    const token = await this.runLoginFlow()
    return token.access_token
  }

  private async runLoginFlow(): Promise<CachedToken> {
    const port = this.config.redirectPort ?? DEFAULT_REDIRECT_PORT
    const redirectUri = this.config.redirectUri ?? `http://127.0.0.1:${port}/callback`
    const pkce = generatePkce()
    const state = generateState()

    const authUrl = buildAuthorizationUrl(this.config, redirectUri, pkce.challenge, state)

    process.stderr.write(`oauth2 ${this.config.schemeName}: opening browser for login\n`)
    process.stderr.write(`  If your browser does not open, visit:\n  ${authUrl}\n`)

    const [, callback] = await Promise.all([
      openBrowser(authUrl),
      captureCallback({ port, host: '127.0.0.1', path: '/callback' }),
    ])

    if (callback.error) {
      throw new Error(
        `OAuth2 login rejected: ${callback.error}${callback.errorDescription ? ` — ${callback.errorDescription}` : ''}`
      )
    }
    if (!callback.code) {
      throw new Error('OAuth2 login did not return an authorization code')
    }
    if (!callback.state || callback.state !== state) {
      throw new Error('OAuth2 login state mismatch — possible CSRF, aborting')
    }

    const tokens = await this.exchangeCode(callback.code, redirectUri, pkce.verifier)
    const cached = toCachedToken(tokens, this.config.scopes)
    this.cached = cached
    await writeTokenCache(this.cacheKey, cached)
    return cached
  }

  private async runRefreshFlow(refreshToken: string): Promise<CachedToken> {
    const body = new URLSearchParams()
    body.set('grant_type', 'refresh_token')
    body.set('refresh_token', refreshToken)
    body.set('client_id', this.config.clientId)
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret)

    const tokens = await this.postTokenEndpoint(body)
    // If the server omits refresh_token on refresh, keep the previous one.
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken
    const cached = toCachedToken(tokens, this.config.scopes)
    this.cached = cached
    await writeTokenCache(this.cacheKey, cached)
    return cached
  }

  private async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<TokenEndpointResponse> {
    const body = new URLSearchParams()
    body.set('grant_type', 'authorization_code')
    body.set('code', code)
    body.set('redirect_uri', redirectUri)
    body.set('client_id', this.config.clientId)
    body.set('code_verifier', verifier)
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret)

    return this.postTokenEndpoint(body)
  }

  private async postTokenEndpoint(body: URLSearchParams): Promise<TokenEndpointResponse> {
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OAuth2 token endpoint returned ${response.status}${text ? `: ${text}` : ''}`)
    }

    const json = (await response.json()) as TokenEndpointResponse
    if (!json || typeof json.access_token !== 'string') {
      throw new Error('OAuth2 token endpoint did not return an access_token')
    }
    return json
  }
}

function buildAuthorizationUrl(
  config: OAuth2AuthCodeConfig,
  redirectUri: string,
  codeChallenge: string,
  state: string
): string {
  const url = new URL(config.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (config.scopes.length > 0) url.searchParams.set('scope', config.scopes.join(' '))
  if (config.extraAuthParams) {
    for (const [k, v] of Object.entries(config.extraAuthParams)) {
      url.searchParams.set(k, v)
    }
  }
  return url.toString()
}

function toCachedToken(response: TokenEndpointResponse, fallbackScopes: string[]): CachedToken {
  const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : 3600
  const scopes = typeof response.scope === 'string' && response.scope.length > 0
    ? response.scope.split(/\s+/)
    : fallbackScopes
  const token: CachedToken = {
    access_token: response.access_token,
    token_type: response.token_type ?? 'Bearer',
    expires_at: Date.now() + expiresIn * 1000,
    scopes,
  }
  if (response.refresh_token) token.refresh_token = response.refresh_token
  return token
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
