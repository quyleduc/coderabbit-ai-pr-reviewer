import {createHash} from 'node:crypto'

/**
 * Pure review-accounting primitives. Do not equate a successful LLM response
 * with completed review. Completion requires explicit coverage for each
 * eligible unit and an acknowledgement from the publisher.
 */
export type CoverageStatus =
  | 'reviewed'
  | 'ignored_by_policy'
  | 'triaged_trivial'
  | 'pending'
  | 'blocked_by_budget'
  | 'failed_analysis'
  | 'failed_publish'

export interface CoverageEntry {
  id: string
  status: CoverageStatus
}

export interface CompletionAssessment {
  complete: boolean
  blockers: string[]
  reviewed: number
  skippedByPolicy: number
}

const terminalNonError = new Set<CoverageStatus>([
  'reviewed',
  'ignored_by_policy',
  'triaged_trivial'
])

export const assessReviewCompletion = (
  expectedIds: readonly string[],
  entries: readonly CoverageEntry[],
  publisherAcknowledged: boolean
): CompletionAssessment => {
  const blockers: string[] = []
  const expected = new Set(expectedIds)
  if (expectedIds.length === 0) blockers.push('no_eligible_units')
  if (expected.size !== expectedIds.length)
    blockers.push('duplicate_expected_ids')

  const accounted = new Map<string, CoverageStatus>()
  for (const entry of entries) {
    if (!expected.has(entry.id)) {
      blockers.push(`unexpected_unit:${entry.id}`)
    } else if (accounted.has(entry.id)) {
      blockers.push(`duplicate_unit:${entry.id}`)
    } else {
      accounted.set(entry.id, entry.status)
    }
  }
  for (const id of expected) {
    const status = accounted.get(id)
    if (!status) {
      blockers.push(`missing_unit:${id}`)
    } else if (!terminalNonError.has(status)) {
      blockers.push(`${status}:${id}`)
    }
  }
  if (!publisherAcknowledged) blockers.push('publication_unconfirmed')

  return {
    complete: blockers.length === 0,
    blockers,
    reviewed: entries.filter(entry => entry.status === 'reviewed').length,
    skippedByPolicy: entries.filter(
      entry =>
        entry.status === 'ignored_by_policy' ||
        entry.status === 'triaged_trivial'
    ).length
  }
}

/**
 * Stable semantic issue key inspired by PR-Agent dedup and SARIF fingerprints.
 * Excludes volatile SHA, line number and natural-language paraphrasing.
 * Supply a stable qualified symbol where known, and the faulty source snippet
 * rather than the full review description.
 */
export interface FingerprintInput {
  path: string
  ruleId: string
  symbol: string
  evidenceSnippet: string
}

export const issueFingerprint = (finding: FingerprintInput): string => {
  const path = finding.path.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  const rule = finding.ruleId.trim()
  const symbol = finding.symbol.trim()
  const evidence = finding.evidenceSnippet.replace(/\r\n/g, '\n').trim()
  if (!path || !rule || !evidence) {
    throw new TypeError('Fingerprint needs path, ruleId and evidenceSnippet')
  }
  // JSON array boundaries prevent ambiguous string concatenation collisions.
  return createHash('sha256')
    .update(JSON.stringify(['review-finding-v1', path, rule, symbol, evidence]))
    .digest('hex')
}
