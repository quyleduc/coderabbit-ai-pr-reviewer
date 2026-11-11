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

export function publishedFingerprints(body: string): string[] {
  return [...body.matchAll(MARKER_REGEX)].map(m => m[1])
}

export function publicationFingerprint(candidate: PublishCandidate): string {
  const path = candidate.path.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  const message = candidate.message
    .replace(MARKER_REGEX, '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!path || !message ||
      !Number.isSafeInteger(candidate.startLine) ||
      !Number.isSafeInteger(candidate.endLine) ||
      candidate.startLine < 1 ||
      candidate.endLine < candidate.startLine) {
    throw new TypeError('Invalid PR publication candidate')
  }
  return createHash('sha256')
    .update(JSON.stringify([
      'publish-v1', path, candidate.startLine, candidate.endLine, message
    ]))
    .digest('hex')
}

/** Pure replay planner: no GitHub API calls and no destructive comment cleanup. */
export function planReviewPublication(
  candidates: readonly PublishCandidate[],
  existingCommentBodies: readonly string[]
): {pending: PublishCandidate[]; suppressed: number} {
  const seen = new Set<string>()
  for (const body of existingCommentBodies) {
    for (const fp of publishedFingerprints(body)) seen.add(fp)
  }
  const pending: PublishCandidate[] = []
  let suppressed = 0
  for (const candidate of candidates) {
    const fp = publicationFingerprint(candidate)
    if (seen.has(fp)) {
      suppressed++
      continue
    }
    seen.add(fp)
    pending.push({
      ...candidate,
      message: candidate.message.trimEnd() +
        '\n\n<!-- ' + MARKER_PREFIX + fp + ' -->'
    })
  }
  return {pending, suppressed}
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
  fetchPage: (page: number, perPage: number) => Promise<readonly RemoteReviewComment[]>,
  trustedLogin: string,
  trustedCommentTag: string,
  perPage = 100,
  maxPages = 1000
): Promise<string[]> {
  if (!trustedLogin || !trustedCommentTag ||
      !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1) {
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
        comment.body.includes(trustedCommentTag)
      ) {
        bodies.push(comment.body)
      }
    }
    if (records.length < perPage) return bodies
  }
  throw new Error('Review-comment pagination exceeds safety limit')
}
