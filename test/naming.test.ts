import { describe, it, expect } from 'vitest'
import { sanitizeToolName, truncateDescription } from '../src/utils/naming.js'

describe('sanitizeToolName', () => {
  it('keeps valid names as-is', () => {
    expect(sanitizeToolName('listPets')).toBe('listPets')
    expect(sanitizeToolName('get_pets_by_id')).toBe('get_pets_by_id')
  })

  it('replaces invalid characters', () => {
    expect(sanitizeToolName('get /pets/{id}')).toBe('get_pets_id')
  })

  it('collapses multiple underscores', () => {
    expect(sanitizeToolName('get___pets')).toBe('get_pets')
  })

  it('strips leading/trailing underscores', () => {
    expect(sanitizeToolName('_listPets_')).toBe('listPets')
  })

  it('truncates long names to 64 chars', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeToolName(long).length).toBe(64)
  })
})

describe('truncateDescription', () => {
  it('returns short strings as-is', () => {
    expect(truncateDescription('hello')).toBe('hello')
  })

  it('truncates long strings with ellipsis', () => {
    const long = 'a'.repeat(300)
    const result = truncateDescription(long)
    expect(result.length).toBe(200)
    expect(result.endsWith('...')).toBe(true)
  })

  it('returns empty string for undefined', () => {
    expect(truncateDescription(undefined)).toBe('')
  })
})
