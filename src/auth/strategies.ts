import type { OpenAPIV3 } from 'openapi-types'
import type { ResolvedAuth, TokenExchangeApplyConfig, TokenExchangeAuthConfig } from './types.js'
import { fetchWithRetry } from '../utils/fetch.js'

export class BearerAuth implements ResolvedAuth {
  constructor(private token: string) {}

  async apply(_url: URL, init: RequestInit): Promise<RequestInit> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    return { ...init, headers }
  }
}

export class ApiKeyAuth implements ResolvedAuth {
  constructor(
    private key: string,
    private paramName: string,
    private location: 'header' | 'query' | 'cookie'
  ) {}

  async apply(url: URL, init: RequestInit): Promise<RequestInit> {
    switch (this.location) {
      case 'header': {
        const headers = new Headers(init.headers)
        headers.set(this.paramName, this.key)
        return { ...init, headers }
      }
      case 'query': {
        url.searchParams.set(this.paramName, this.key)
        return init
      }
      case 'cookie': {
        const headers = new Headers(init.headers)
        setCookieValue(headers, this.paramName, this.key)
        return { ...init, headers }
      }
    }
  }
}

export class BasicAuth implements ResolvedAuth {
  constructor(
    private username: string,
    private password: string
  ) {}

  async apply(_url: URL, init: RequestInit): Promise<RequestInit> {
    const credentials = `${this.username}:${this.password}`
    const encoded = Buffer.from(credentials, 'utf-8').toString('base64')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Basic ${encoded}`)
    return { ...init, headers }
  }
}

export class OAuth2ClientCredentials implements ResolvedAuth {
  private tokenCache: { token: string; expiresAt: number } | null = null
  private pendingRefresh: Promise<string> | null = null

  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokenUrl: string,
    private scopes: string[] = []
  ) {}

  async apply(_url: URL, init: RequestInit): Promise<RequestInit> {
    const token = await this.getToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }

  async refresh(_url: URL, init: RequestInit): Promise<RequestInit> {
    this.tokenCache = null
    const token = await this.getToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token
    }

    if (this.pendingRefresh) {
      return this.pendingRefresh
    }

    this.pendingRefresh = this.fetchToken()

    try {
      return await this.pendingRefresh
    } finally {
      this.pendingRefresh = null
    }
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    })

    if (this.scopes.length > 0) {
      body.set('scope', this.scopes.join(' '))
    }

    const res = await fetchWithRetry(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, { retries: 2, timeout: 15_000 })

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '')
      throw new Error(
        `OAuth2 token request failed: ${res.status} ${res.statusText}${errorBody ? ` - ${errorBody}` : ''}`
      )
    }

    let data: Record<string, unknown>
    try {
      data = await res.json() as Record<string, unknown>
    } catch {
      throw new Error('OAuth2 token response is not valid JSON')
    }

    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('OAuth2 token response missing "access_token" field')
    }

    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600
    const bufferSeconds = Math.min(60, expiresIn * 0.1)

    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (expiresIn - bufferSeconds) * 1000,
    }

    return data.access_token
  }
}

type TokenExchangeCache = {
  token: string
  tokenType?: string
  expiresAt: number
}

export class TokenExchangeAuth implements ResolvedAuth {
  private tokenCache: TokenExchangeCache | null = null
  private pendingRefresh: Promise<TokenExchangeCache> | null = null

  constructor(private config: TokenExchangeAuthConfig) {}

  async apply(url: URL, init: RequestInit): Promise<RequestInit> {
    const token = await this.getToken()
    return applyTokenValue(url, init, token, this.config.apply)
  }

  async refresh(url: URL, init: RequestInit): Promise<RequestInit> {
    this.tokenCache = null
    const token = await this.getToken()
    return applyTokenValue(url, init, token, this.config.apply)
  }

  private async getToken(): Promise<TokenExchangeCache> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache
    }

    if (this.pendingRefresh) {
      return this.pendingRefresh
    }

    this.pendingRefresh = this.fetchToken()

    try {
      return await this.pendingRefresh
    } finally {
      this.pendingRefresh = null
    }
  }

  private async fetchToken(): Promise<TokenExchangeCache> {
    const request = this.config.request ?? {}
    const method = request.method?.toUpperCase() ?? 'POST'
    const url = new URL(this.config.tokenUrl)
    const headers = new Headers(request.headers)
    let body: RequestInit['body']

    if (request.fields && Object.keys(request.fields).length > 0) {
      if (method === 'GET' || method === 'HEAD') {
        for (const [key, value] of Object.entries(request.fields)) {
          url.searchParams.set(key, String(value))
        }
      } else {
        const contentType = request.contentType ?? 'application/json'
        headers.set('Content-Type', contentType)

        if (contentType === 'application/x-www-form-urlencoded') {
          const params = new URLSearchParams()
          for (const [key, value] of Object.entries(request.fields)) {
            params.set(key, String(value))
          }
          body = params
        } else {
          body = JSON.stringify(request.fields)
        }
      }
    }

    const res = await fetchWithRetry(url.toString(), {
      method,
      headers,
      body,
    }, { retries: 2, timeout: 15_000, retryPolicy: 'all' })

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '')
      throw new Error(
        `Token exchange request failed: ${res.status} ${res.statusText}${errorBody ? ` - ${errorBody}` : ''}`
      )
    }

    let data: Record<string, unknown>
    try {
      data = await res.json() as Record<string, unknown>
    } catch {
      throw new Error('Token exchange response is not valid JSON')
    }

    const responseConfig = this.config.response ?? {}
    const tokenValue = getValueAtPath(data, responseConfig.tokenField ?? 'access_token')
    if (typeof tokenValue !== 'string' || !tokenValue) {
      throw new Error(`Token exchange response missing "${responseConfig.tokenField ?? 'access_token'}" field`)
    }

    const tokenTypeValue = getValueAtPath(data, responseConfig.tokenTypeField ?? 'token_type')
    const tokenType = typeof tokenTypeValue === 'string' && tokenTypeValue
      ? normalizeSchemeName(tokenTypeValue)
      : undefined

    const token = {
      token: tokenValue,
      tokenType,
      expiresAt: resolveTokenExpiry(data, this.config),
    }

    this.tokenCache = token
    return token
  }
}

export class CustomAuth implements ResolvedAuth {
  constructor(private handler: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>) {}

  async apply(url: URL, init: RequestInit): Promise<RequestInit> {
    return this.handler(url.toString(), init)
  }
}

export class CompositeAuth implements ResolvedAuth {
  constructor(private strategies: ResolvedAuth[]) {}

  async apply(url: URL, init: RequestInit): Promise<RequestInit> {
    let result = init
    for (const strategy of this.strategies) {
      result = await strategy.apply(url, result)
    }
    return result
  }

  async refresh(url: URL, init: RequestInit): Promise<RequestInit> {
    let result = init
    for (const strategy of this.strategies) {
      if (strategy.refresh) {
        result = await strategy.refresh(url, result)
      } else {
        result = await strategy.apply(url, result)
      }
    }
    return result
  }
}

export function createAuthFromScheme(
  scheme: OpenAPIV3.SecuritySchemeObject,
  credential: string
): ResolvedAuth | null {
  switch (scheme.type) {
    case 'http': {
      if (scheme.scheme === 'bearer') {
        return new BearerAuth(credential)
      }
      if (scheme.scheme === 'basic') {
        const colonIndex = credential.indexOf(':')
        if (colonIndex === -1) {
          return new BasicAuth(credential, '')
        }
        return new BasicAuth(credential.slice(0, colonIndex), credential.slice(colonIndex + 1))
      }
      return null
    }
    case 'apiKey': {
      const location = scheme.in as 'header' | 'query' | 'cookie'
      if (!['header', 'query', 'cookie'].includes(location)) {
        return new ApiKeyAuth(credential, scheme.name, 'header')
      }
      return new ApiKeyAuth(credential, scheme.name, location)
    }
    default:
      return null
  }
}

function applyTokenValue(
  url: URL,
  init: RequestInit,
  token: TokenExchangeCache,
  applyConfig: TokenExchangeApplyConfig | undefined
): RequestInit {
  const location = applyConfig?.location ?? 'header'
  const name = applyConfig?.name ?? (location === 'header' ? 'Authorization' : 'access_token')
  const prefix = applyConfig?.prefix
    ?? (location === 'header' && name.toLowerCase() === 'authorization'
      ? `${token.tokenType ?? 'Bearer'} `
      : '')
  const value = `${prefix}${token.token}`

  switch (location) {
    case 'header': {
      const headers = new Headers(init.headers)
      headers.set(name, value)
      return { ...init, headers }
    }
    case 'query': {
      url.searchParams.set(name, value)
      return init
    }
    case 'cookie': {
      const headers = new Headers(init.headers)
      setCookieValue(headers, name, value)
      return { ...init, headers }
    }
  }
}

function getValueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in current) {
      return (current as Record<string, unknown>)[segment]
    }
    return undefined
  }, value)
}

function resolveTokenExpiry(data: Record<string, unknown>, config: TokenExchangeAuthConfig): number {
  const response = config.response ?? {}
  const now = Date.now()

  if (response.expiresAtField) {
    const expiresAt = parseAbsoluteTimestamp(getValueAtPath(data, response.expiresAtField))
    if (expiresAt !== null) {
      return applyRefreshBuffer(expiresAt, now, config.refreshBufferSeconds)
    }
  }

  const expiresInValue = getValueAtPath(data, response.expiresInField ?? 'expires_in')
  const expiresIn = parseDurationSeconds(expiresInValue) ?? config.defaultExpiresIn

  if (expiresIn === undefined) {
    return Number.POSITIVE_INFINITY
  }

  const bufferSeconds = config.refreshBufferSeconds
    ?? Math.min(60, Math.max(5, expiresIn * 0.1))

  return now + Math.max(expiresIn - bufferSeconds, 0) * 1000
}

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return null
}

function parseAbsoluteTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

function applyRefreshBuffer(expiresAt: number, now: number, configuredBufferSeconds: number | undefined): number {
  const secondsUntilExpiry = Math.max((expiresAt - now) / 1000, 0)
  const bufferSeconds = configuredBufferSeconds
    ?? Math.min(60, Math.max(5, secondsUntilExpiry * 0.1))
  return Math.max(now, expiresAt - bufferSeconds * 1000)
}

function normalizeSchemeName(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function setCookieValue(headers: Headers, name: string, value: string): void {
  const encodedName = encodeURIComponent(name)
  const encodedValue = encodeURIComponent(value)
  const existing = headers.get('Cookie')

  if (!existing) {
    headers.set('Cookie', `${encodedName}=${encodedValue}`)
    return
  }

  const parts = existing
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  const withoutTarget = parts.filter((part) => !part.startsWith(`${encodedName}=`))
  withoutTarget.push(`${encodedName}=${encodedValue}`)
  headers.set('Cookie', withoutTarget.join('; '))
}
