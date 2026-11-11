/**
 * Publishing transport seam. Keep GitHub API calls at the edge, with the
 * success/failure state machine exercised using injected fake responses.
 * This module intentionally has no runtime dependencies.
 */
export interface PlannedComment {
  path: string
  startLine: number
  endLine: number
  message: string
}

export interface GitHubReviewComment {
  path: string
  body: string
  line: number
  side: 'RIGHT'
  start_line?: number
  start_side?: 'RIGHT'
}

export interface ReviewTransport {
  createReview: (request: {
    commitId: string
    body?: string
    event?: 'COMMENT'
    comments?: GitHubReviewComment[]
  }) => Promise<number>
  submitReview: (reviewId: number, body: string) => Promise<void>
  discardPendingReview: (reviewId: number) => Promise<void>
}

export type ReviewPublishResult =
  | {confirmed: true; kind: 'empty' | 'submitted'}
  | {confirmed: false; kind: 'create_failed' | 'submit_unconfirmed'; error: string}

/**
 * On unknown GitHub API outcomes, return an explicit failure. Never retry
 * blind individual posts, because the server may have committed the request.
 */
export async function publishReviewBatch(
  pending: readonly PlannedComment[],
  commitId: string,
  body: string,
  transport: ReviewTransport
): Promise<ReviewPublishResult> {
  if (pending.length === 0) {
    try {
      await transport.createReview({commitId, event: 'COMMENT', body})
      return {confirmed: true, kind: 'empty'}
    } catch (error) {
      return {confirmed: false, kind: 'create_failed', error: String(error)}
    }
  }

  const comments: GitHubReviewComment[] = pending.map(comment => {
    const result: GitHubReviewComment = {
      path: comment.path,
      body: comment.message,
      line: comment.endLine,
      side: 'RIGHT'
    }
    if (comment.startLine !== comment.endLine) {
      result.start_line = comment.startLine
      result.start_side = 'RIGHT'
    }
    return result
  })

  let id: number
  try {
    id = await transport.createReview({commitId, comments})
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('Invalid GitHub review id')
    }
  } catch (error) {
    return {confirmed: false, kind: 'create_failed', error: String(error)}
  }

  try {
    await transport.submitReview(id, body)
    return {confirmed: true, kind: 'submitted'}
  } catch (error) {
    // A failed submission is ambiguous (the server may have committed it).
    // Cleanup is best effort only, and never turns this into success.
    try {
      await transport.discardPendingReview(id)
    } catch {
      // Cleanup failure is included in an unconfirmed result, not swallowed
      // as permission to post an individual duplicate.
    }
    return {confirmed: false, kind: 'submit_unconfirmed', error: String(error)}
  }
}
