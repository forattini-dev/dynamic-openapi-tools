import { describe, it, expect } from 'vitest'
import * as root from '../src/index.js'
import * as parser from '../src/parser/index.js'
import * as auth from '../src/auth/index.js'
import * as bundle from '../src/bundle/index.js'
import * as utils from '../src/utils/index.js'

describe('public exports', () => {
  it('re-exports parser symbols', () => {
    expect(typeof parser.loadSpec).toBe('function')
    expect(typeof parser.resolveSpec).toBe('function')
    expect(typeof parser.resolveSource).toBe('function')
    expect(typeof parser.filterOperations).toBe('function')
  })

  it('re-exports auth symbols', () => {
    expect(typeof auth.resolveAuth).toBe('function')
    expect(typeof auth.BearerAuth).toBe('function')
    expect(typeof auth.ApiKeyAuth).toBe('function')
    expect(typeof auth.BasicAuth).toBe('function')
    expect(typeof auth.OAuth2ClientCredentials).toBe('function')
    expect(typeof auth.TokenExchangeAuth).toBe('function')
    expect(typeof auth.CustomAuth).toBe('function')
    expect(typeof auth.CompositeAuth).toBe('function')
  })

  it('re-exports bundle symbols', () => {
    expect(typeof bundle.buildBundle).toBe('function')
    expect(typeof bundle.renderBundleShim).toBe('function')
  })

  it('re-exports utils symbols', () => {
    expect(typeof utils.fetchWithRetry).toBe('function')
    expect(typeof utils.sanitizeToolName).toBe('function')
    expect(typeof utils.truncateDescription).toBe('function')
  })

  it('root index re-exports everything', () => {
    expect(typeof root.loadSpec).toBe('function')
    expect(typeof root.resolveAuth).toBe('function')
    expect(typeof root.buildBundle).toBe('function')
    expect(typeof root.fetchWithRetry).toBe('function')
  })
})
