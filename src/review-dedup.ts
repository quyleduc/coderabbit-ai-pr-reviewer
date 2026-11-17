import {createHash} from 'node:crypto'

/**
 * Publication fingerprint, intentionally different from semantic issue identity.
 * Exact path/range/message prevents replaying identical comments on the same PR.
 * A paraphrased finding may still require future semantic deduplication.
 */
export interface PublishCandidate {
  path: string
  startLine: number
  endLine: number
  message: string
}

const MARKER_PREFIX = 'coderabbit:published-finding-v1:'
const MARKER_REGEX = /<!-- coderabbit:published-finding-v1:([0-9a-f]{64}) -->/g
const RULE_MARKER_PREFIX = 'coderabbit:published-rule-v1:'
const RULE_MARKER_PATTERN =
  /^<!--\s*coderabbit:published-rule-v1:([a-f0-9]{64})\s*-->$/gm
const RULE_HEADING_PATTERN =
  /^\*\*(?:HIGH|MEDIUM|LOW) \/ ([A-Z][A-Z0-9_]{2,63})\*\*$/m

function extractRuleId(message: string): string | null {
  const match = RULE_HEADING_PATTERN.exec(message)
  return match ? match[1] : null
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

export function ruleFingerprint(
  candidate: Omit<PublishCandidate, 'message'>,
  ruleId: string
): string {
  const path = normalizePath(candidate.path)
  if (
    !path ||
    !Number.isSafeInteger(candidate.startLine) ||
    candidate.startLine < 1 ||
    !Number.isSafeInteger(candidate.endLine) ||
    candidate.endLine < candidate.startLine ||
    !/^[A-Z][A-Z0-9_]{2,63}$/.test(ruleId)
  ) {
    throw new TypeError('Invalid PR rule fingerprint input')
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        'rule-v1',
        path,
        candidate.startLine,
        candidate.endLine,
        ruleId
      ])
    )
    .digest('hex')
}

function publishedRuleKeys(body: string): string[] {
  const keys: string[] = []
  for (const match of body.matchAll(RULE_MARKER_PATTERN)) {
    keys.push(match[1])
  }
  return keys
}

export function publishedFingerprints(body: string): string[] {
  return [...body.matchAll(MARKER_REGEX)].map(m => m[1])
}

export function publicationFingerprint(candidate: PublishCandidate): string {
  const path = normalizePath(candidate.path)
  const message = candidate.message
    .replace(MARKER_REGEX, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (
    !path ||
    !message ||
    !Number.isSafeInteger(candidate.startLine) ||
    !Number.isSafeInteger(candidate.endLine) ||
    candidate.startLine < 1 ||
    candidate.endLine < candidate.startLine
  ) {
    throw new TypeError('Invalid PR publication candidate')
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        'publish-v1',
        path,
        candidate.startLine,
        candidate.endLine,
        message
      ])
    )
    .digest('hex')
}

export function filterUnpublishedFindings<T extends PublishCandidate>(
  candidates: readonly T[],
  existingCommentBodies: readonly string[],
  formatMessage: (
    // eslint-disable-next-line no-unused-vars
    message: string
  ) => string = message => message
): T[] {
  const canonical = (value: string) => value.replace(/\r\n/g, '\n').trimEnd()
  const existing = new Set(existingCommentBodies.map(canonical))
  const existingRules = new Set(
    existingCommentBodies.flatMap(publishedRuleKeys)
  )
  const withinRun = new Set<string>()
  const withinRunRules = new Set<string>()
  const fresh: T[] = []
  for (const candidate of candidates) {
    const formatted = {
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      message: formatMessage(candidate.message)
    }
    const fp = publicationFingerprint(formatted)
    const ruleId = extractRuleId(formatted.message)
    const ruleFp = ruleId ? ruleFingerprint(formatted, ruleId) : null
    const ruleTag = ruleFp ? `\n<!-- ${RULE_MARKER_PREFIX}${ruleFp} -->` : ''
    const message = `${formatted.message.trimEnd()}\n\n<!-- ${MARKER_PREFIX}${fp} -->${ruleTag}`
    if (
      withinRun.has(fp) ||
      existing.has(canonical(message)) ||
      (ruleFp !== null &&
        (withinRunRules.has(ruleFp) || existingRules.has(ruleFp)))
    ) {
      continue
    }
    withinRun.add(fp)
    if (ruleFp !== null) withinRunRules.add(ruleFp)
    fresh.push(candidate)
  }
  return fresh
}

/** Pure replay planner: no GitHub API calls and no destructive comment cleanup. */
export function planReviewPublication(
  candidates: readonly PublishCandidate[],
  existingCommentBodies: readonly string[]
): {pending: PublishCandidate[]; suppressed: number} {
  const fresh = filterUnpublishedFindings(candidates, existingCommentBodies)
  const pending = fresh.map(candidate => {
    const ruleId = extractRuleId(candidate.message)
    const ruleTag = ruleId
      ? `\n<!-- ${RULE_MARKER_PREFIX}${ruleFingerprint(candidate, ruleId)} -->`
      : ''
    return {
      ...candidate,
      message: `${candidate.message.trimEnd()}\n\n<!-- ${MARKER_PREFIX}${publicationFingerprint(
        candidate
      )} -->${ruleTag}`
    }
  })
  return {pending, suppressed: candidates.length - pending.length}
}

export interface RemoteReviewComment {
  user?: {login?: string | null} | null
  body?: string | null
}

/**
 * Fetch every page without silently swallowing GitHub failures.
 * The fetcher is injected for deterministic pagination/retry tests.
 * A spoofed marker by a non-publishing user is never trusted.
 */
export async function loadTrustedPublishedBodies(
  fetchPage: (
    // eslint-disable-next-line no-unused-vars
    page: number,
    // eslint-disable-next-line no-unused-vars
    _perPage: number
  ) => Promise<readonly RemoteReviewComment[]>,
  trustedLogin: string,
  trustedCommentTag: string | readonly string[],
  perPage = 100,
  maxPages = 1000
): Promise<string[]> {
  const tags = Array.isArray(trustedCommentTag)
    ? trustedCommentTag
    : [trustedCommentTag]
  if (
    !trustedLogin ||
    tags.length === 0 ||
    tags.some(tag => typeof tag !== 'string' || tag.length === 0) ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  ) {
    throw new TypeError('Invalid trusted comment query')
  }
  const bodies: string[] = []
  for (let page = 1; page <= maxPages; page++) {
    const records = await fetchPage(page, perPage)
    if (!Array.isArray(records)) {
      throw new Error('Unexpected GitHub review comments response')
    }
    if (records.length > perPage) {
      throw new Error('GitHub review comments page exceeds requested size')
    }
    for (const comment of records) {
      if (
        comment.user?.login === trustedLogin &&
        typeof comment.body === 'string' &&
        tags.some(tag => comment.body!.includes(tag))
      ) {
        bodies.push(comment.body)
      }
    }
    if (records.length < perPage) return bodies
  }
  throw new Error('Review-comment pagination exceeds safety limit')
}

export interface AuthoredTaggedComment {
  id: number
  body?: string | null
  user?: {login?: string | null} | null
}

/**
 * Never use untrusted PR comments as state/checkpoint sources.
 * GitHub (not user-supplied Markdown) attests to user.login.
 */
export function findTrustedTaggedComment<T extends AuthoredTaggedComment>(
  comments: readonly T[],
  tag: string,
  trustedLogin: string
): T | null {
  if (!tag || !trustedLogin)
    throw new TypeError('Missing trusted comment identity')
  for (const comment of comments) {
    if (
      comment.user?.login === trustedLogin &&
      typeof comment.body === 'string' &&
      comment.body.includes(tag)
    ) {
      return comment
    }
  }
  return null
}
