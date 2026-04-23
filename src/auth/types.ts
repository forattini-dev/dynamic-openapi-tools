export interface TokenExchangeRequestConfig {
  method?: string
  contentType?: 'application/json' | 'application/x-www-form-urlencoded'
  headers?: Record<string, string>
  fields?: Record<string, string | number | boolean>
}

export interface TokenExchangeResponseConfig {
  tokenField?: string
  tokenTypeField?: string
  expiresInField?: string
  expiresAtField?: string
}

export interface TokenExchangeApplyConfig {
  location?: 'header' | 'query' | 'cookie'
  name?: string
  prefix?: string
}

export interface TokenExchangeAuthConfig {
  tokenUrl: string
  request?: TokenExchangeRequestConfig
  response?: TokenExchangeResponseConfig
  apply?: TokenExchangeApplyConfig
  refreshBufferSeconds?: number
  defaultExpiresIn?: number
}

export interface AuthConfig {
  bearerToken?: string
  apiKey?: string
  basicAuth?: { username: string; password: string }
  oauth2?: {
    clientId: string
    clientSecret: string
    tokenUrl: string
    scopes?: string[]
  }
  tokenExchange?: TokenExchangeAuthConfig
  custom?: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>
  /**
   * Where to persist access tokens retrieved by `oauth2` and `tokenExchange`.
   * - `'memory'` (default): tokens live only while the process is up
   * - `'file'`: tokens survive restarts via `$XDG_CACHE_HOME/dynamic-openapi-tools/tokens.json` (chmod 0600)
   * - Custom object: pass a `TokenCache` instance (keychain adapter, in-redis, etc.)
   */
  cache?: import('./cache.js').TokenCacheOption
}

export interface ResolvedAuth {
  apply(url: URL, init: RequestInit): Promise<RequestInit>
  refresh?(url: URL, init: RequestInit): Promise<RequestInit>
}
