import type { OpenAPIV3 } from 'openapi-types'
import type { AuthConfig, ResolvedAuth } from './types.js'
import {
  BearerAuth,
  ApiKeyAuth,
  BasicAuth,
  OAuth2ClientCredentials,
  TokenExchangeAuth,
  CustomAuth,
  CompositeAuth,
  createAuthFromScheme,
} from './strategies.js'

export function resolveAuth(
  config: AuthConfig | undefined,
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>
): ResolvedAuth | null {
  const strategies: ResolvedAuth[] = []

  if (config?.custom) {
    return new CustomAuth(config.custom)
  }

  if (config?.bearerToken) {
    strategies.push(new BearerAuth(config.bearerToken))
  }

  if (config?.apiKey) {
    const apiKeyScheme = Object.values(securitySchemes).find(
      (s) => s.type === 'apiKey'
    ) as OpenAPIV3.ApiKeySecurityScheme | undefined

    if (apiKeyScheme) {
      strategies.push(new ApiKeyAuth(config.apiKey, apiKeyScheme.name, apiKeyScheme.in as 'header' | 'query' | 'cookie'))
    } else {
      strategies.push(new ApiKeyAuth(config.apiKey, 'X-API-Key', 'header'))
    }
  }

  if (config?.basicAuth) {
    strategies.push(new BasicAuth(config.basicAuth.username, config.basicAuth.password))
  }

  if (config?.oauth2) {
    strategies.push(
      new OAuth2ClientCredentials(
        config.oauth2.clientId,
        config.oauth2.clientSecret,
        config.oauth2.tokenUrl,
        config.oauth2.scopes
      )
    )
  }

  if (config?.tokenExchange) {
    strategies.push(new TokenExchangeAuth(config.tokenExchange))
  }

  if (strategies.length > 0) {
    return strategies.length === 1 ? strategies[0] : new CompositeAuth(strategies)
  }

  return resolveAuthFromEnv(securitySchemes)
}

function resolveAuthFromEnv(
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>
): ResolvedAuth | null {
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    const envToken = process.env[`OPENAPI_AUTH_${envName}_TOKEN`]
      ?? process.env[`OPENAPI_AUTH_${envName}_KEY`]

    if (envToken) {
      const auth = createAuthFromScheme(scheme, envToken)
      if (auth) return auth
    }
  }

  const globalToken = process.env['OPENAPI_AUTH_TOKEN']
  if (globalToken) {
    return new BearerAuth(globalToken)
  }

  const globalApiKey = process.env['OPENAPI_API_KEY']
  if (globalApiKey) {
    const apiKeyScheme = Object.values(securitySchemes).find(
      (s) => s.type === 'apiKey'
    ) as OpenAPIV3.ApiKeySecurityScheme | undefined

    if (apiKeyScheme) {
      return new ApiKeyAuth(globalApiKey, apiKeyScheme.name, apiKeyScheme.in as 'header' | 'query' | 'cookie')
    }
    return new ApiKeyAuth(globalApiKey, 'X-API-Key', 'header')
  }

  return null
}
