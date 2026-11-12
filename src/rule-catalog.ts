/** Canonical categories shared by production prompts, validation and evals. */
export const REVIEW_RULES = {
  NULL_DEREF: 'Pointer is dereferenced without a proven non-null guarantee.',
  DIV_ZERO: 'A divisor can be zero when evaluated.',
  OUT_OF_BOUNDS: 'An access can exceed the valid array or buffer bounds.',
  INTEGER_OVERFLOW:
    'Arithmetic can overflow in a way that breaks correctness or safety.',
  USE_AFTER_FREE: 'Memory is accessed after its lifetime has ended.',
  DOUBLE_FREE: 'The same allocation can be released more than once.',
  RESOURCE_LEAK: 'A resource is not released on a reachable path.',
  UNINITIALIZED_READ: 'A value can be read before it is initialized.',
  DATA_RACE: 'Concurrent accesses can race without required synchronization.',
  DEADLOCK: 'The changed code can create a lock-order cycle or wait forever.',
  INVALID_STATE:
    'The code permits an invalid state transition or invariant violation.',
  API_MISUSE:
    'An API is called with arguments or ordering that violate its contract.',
  ERROR_HANDLING:
    'An error result is ignored or handled in a way that breaks correctness.',
  SECURITY:
    'The change creates a concrete security weakness not covered by a more specific category.',
  LOGIC_ERROR:
    'The changed logic produces an incorrect result for a concrete input.',
  OTHER_DEFECT:
    'A concrete correctness defect that does not fit another listed category.'
} as const

export type ReviewRuleId = keyof typeof REVIEW_RULES

const ruleAliases: Readonly<Record<string, ReviewRuleId>> = {
  NULL_POINTER: 'NULL_DEREF',
  NULL_POINTER_DEREFERENCE: 'NULL_DEREF',
  NULL_POINTER_DEREF: 'NULL_DEREF',
  DIVIDE_BY_ZERO: 'DIV_ZERO',
  DIVISION_BY_ZERO: 'DIV_ZERO',
  ZERO_DIVISION: 'DIV_ZERO',
  BUFFER_OVERFLOW: 'OUT_OF_BOUNDS',
  ARRAY_BOUNDS: 'OUT_OF_BOUNDS',
  ARRAY_OUT_OF_BOUNDS: 'OUT_OF_BOUNDS'
}

/** Normalize common model aliases while keeping unknown labels distinguishable. */
export function canonicalizeRuleId(
  value: string
): ReviewRuleId | 'NON_CANONICAL' {
  if (Object.prototype.hasOwnProperty.call(REVIEW_RULES, value)) {
    return value as ReviewRuleId
  }
  return ruleAliases[value] ?? 'NON_CANONICAL'
}

export function renderReviewRuleCatalog(): string {
  return Object.entries(REVIEW_RULES)
    .map(([id, description]) => `- ${id}: ${description}`)
    .join('\n')
}
