import { describe, it, expect } from 'vitest'
import { filterOperations } from '../src/parser/filter.js'
import type { ParsedOperation } from '../src/parser/types.js'

function op(partial: Partial<ParsedOperation> & { operationId: string }): ParsedOperation {
  return {
    method: 'GET',
    path: `/${partial.operationId}`,
    parameters: [],
    responses: {},
    security: [],
    tags: [],
    ...partial,
  }
}

describe('filterOperations', () => {
  const ops = [
    op({ operationId: 'listPets', tags: ['pets'] }),
    op({ operationId: 'createPet', tags: ['pets', 'write'] }),
    op({ operationId: 'deletePet', tags: ['pets', 'write'] }),
    op({ operationId: 'adminStats', tags: ['admin'] }),
    op({ operationId: 'internalPing', tags: ['internal'], hidden: true }),
  ]

  it('returns everything when no filters given (except hidden)', () => {
    const result = filterOperations(ops)
    expect(result.map((o) => o.operationId)).toEqual([
      'listPets',
      'createPet',
      'deletePet',
      'adminStats',
    ])
  })

  it('always removes operations with x-hidden: true', () => {
    const result = filterOperations(ops, { operations: { include: ['internalPing'] } })
    expect(result.map((o) => o.operationId)).toEqual([])
  })

  it('tags.include acts as an allowlist', () => {
    const result = filterOperations(ops, { tags: { include: ['pets'] } })
    expect(result.map((o) => o.operationId)).toEqual(['listPets', 'createPet', 'deletePet'])
  })

  it('tags.exclude removes any op that carries the tag', () => {
    const result = filterOperations(ops, { tags: { exclude: ['write'] } })
    expect(result.map((o) => o.operationId)).toEqual(['listPets', 'adminStats'])
  })

  it('operations.exclude removes unconditionally', () => {
    const result = filterOperations(ops, { operations: { exclude: ['deletePet'] } })
    expect(result.map((o) => o.operationId)).toEqual(['listPets', 'createPet', 'adminStats'])
  })

  it('operations.include overrides tags.exclude (more specific wins)', () => {
    const result = filterOperations(ops, {
      tags: { exclude: ['write'] },
      operations: { include: ['deletePet'] },
    })
    expect(result.map((o) => o.operationId)).toContain('deletePet')
    expect(result.map((o) => o.operationId)).not.toContain('createPet')
  })

  it('operations.exclude beats operations.include (exclude comes first)', () => {
    const result = filterOperations(ops, {
      operations: { include: ['listPets'], exclude: ['listPets'] },
    })
    expect(result.map((o) => o.operationId)).toEqual([])
  })

  it('combines multiple includes with OR semantics', () => {
    const result = filterOperations(ops, {
      tags: { include: ['admin'] },
      operations: { include: ['listPets'] },
    })
    expect(result.map((o) => o.operationId)).toEqual(['listPets', 'adminStats'])
  })

  it('empty arrays behave like undefined', () => {
    const result = filterOperations(ops, { tags: { include: [], exclude: [] } })
    expect(result.map((o) => o.operationId)).toEqual([
      'listPets',
      'createPet',
      'deletePet',
      'adminStats',
    ])
  })
})
