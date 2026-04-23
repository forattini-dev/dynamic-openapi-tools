import type { ParsedOperation } from './types.js'

export interface OperationFilter {
  include?: string[]
  exclude?: string[]
}

export interface OperationFilters {
  tags?: OperationFilter
  operations?: OperationFilter
}

/**
 * Filter operations according to the provided rules.
 *
 * Precedence (first match wins):
 *   1. `x-hidden: true` on the operation always removes it — spec author wins.
 *   2. `operations.exclude` removes the operation unconditionally.
 *   3. `operations.include` forces the operation through, even against `tags.exclude`.
 *   4. `tags.exclude` removes the operation if any of its tags match.
 *   5. When any include list is non-empty, only operations matching at least one include pass.
 *   6. Otherwise, the operation passes.
 */
export function filterOperations(
  operations: ParsedOperation[],
  filters?: OperationFilters,
): ParsedOperation[] {
  const tagInclude = filters?.tags?.include ?? []
  const tagExclude = filters?.tags?.exclude ?? []
  const opInclude = filters?.operations?.include ?? []
  const opExclude = filters?.operations?.exclude ?? []
  const hasInclude = tagInclude.length > 0 || opInclude.length > 0

  return operations.filter((op) => {
    if (op.hidden) return false
    if (opExclude.includes(op.operationId)) return false
    if (opInclude.includes(op.operationId)) return true

    const opTags = op.tags ?? []
    if (tagExclude.length > 0 && opTags.some((t) => tagExclude.includes(t))) {
      return false
    }

    if (!hasInclude) return true
    return opTags.some((t) => tagInclude.includes(t))
  })
}
