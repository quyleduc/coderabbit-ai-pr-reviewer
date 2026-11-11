import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const publisher = readFileSync(new URL('../src/commenter.ts', import.meta.url), 'utf8')
const dedup = readFileSync(new URL('../src/review-dedup.ts', import.meta.url), 'utf8')

test('production reviewer registers and accounts for every parsed hunk', () => {
  assert.match(review, /new HunkCoverage\(\)/)
  assert.match(review, /hunkCoverage\.registerFile\(/)
  assert.match(review, /hunkCoverage\.markPacked\(/)
  assert.match(review, /hunkCoverage\.markUnacknowledged\(/)
  assert.match(review, /hunkCoverage\.snapshot\(\)/)
  assert.match(review, /fileCompletion\.complete && hunkCompletion\.complete/)
})

test('reviewer checks immutable PR head before submitting comments', () => {
  const fresh = review.indexOf('if (!scopeFresh)')
  const publish = review.indexOf('const published = await commenter.submitReview(')
  assert.ok(fresh >= 0 && publish > fresh)
  assert.match(review, /current\.data\.head\.sha === context\.payload\.pull_request\.head\.sha/)
  assert.match(review, /current\.data\.base\.sha === context\.payload\.pull_request\.base\.sha/)
})

test('publisher reconciles existing comments without destructive old-comment deletion', () => {
  const submitStart = publisher.indexOf('async submitReview(')
  const submitEnd = publisher.indexOf('async reviewCommentReply(', submitStart)
  const block = publisher.slice(submitStart, submitEnd)
  assert.match(block, /publishedBotCommentBodies\(pullNumber\)/)
  assert.match(block, /planReviewPublication\(this\.reviewCommentsBuffer, existingBodies\)/)
  assert.doesNotMatch(block, /pulls\.deleteReviewComment\(/)
  assert.doesNotMatch(block, /createReviewComment\(/)
})

test('bot identity validation prevents untrusted comment markers from suppressing findings', () => {
  assert.match(publisher, /'github-actions\[bot\]'/)
  assert.match(dedup, /comment\.user\?\.login === trustedLogin/)
  assert.match(dedup, /throw new Error\('Review-comment pagination exceeds safety limit'\)/)
})

test('publisher only confirms completion after GitHub API acknowledgement', () => {
  const submitStart = publisher.indexOf('async submitReview(')
  const submitEnd = publisher.indexOf('async reviewCommentReply(', submitStart)
  const block = publisher.slice(submitStart, submitEnd)
  assert.match(block, /await publishReviewBatch\(/)
  assert.match(block, /await octokit\.pulls\.submitReview\(/)
  assert.match(block, /return result\.confirmed/)
  // Failure-injection coverage lives in review-publication.test.mjs.
})


test('Compare API 300-file truncation is fail-closed', () => {
  assert.match(review, /incrementalFiles\.length >= 300 \|\| targetBranchFiles\.length >= 300/)
  assert.match(review, /compareCommits may have truncated files at 300/)
})


test('incomplete, stale and truncated reviews fail the CI check explicitly', () => {
  assert.match(review, /setFailed\('Review incomplete; no latest-head checkpoint recorded'\)/)
  assert.match(review, /setFailed\('PR head\/base changed or cannot be verified/)
  assert.match(review, /setFailed\('Review blocked: compareCommits may have truncated files at 300'\)/)
  assert.match(review, /setFailed\('Cannot complete review: eligible file patches unavailable'\)/)
})


test('summary checkpoint read/write errors propagate instead of masquerading as success', () => {
  assert.match(publisher, /Failed to create comment: \$\{e\}[^]*?throw e/)
  assert.match(publisher, /Failed to replace comment: \$\{e\}[^]*?throw e/)
  assert.match(publisher, /Failed to find comment with tag: \$\{e\}[^]*?throw e/)
  assert.match(publisher, /Failed to list comments: \$\{e\}[^]*?throw e/)
  const finalWrite = review.indexOf('await commenter.comment(' + String.fromCharCode(96) + '\${summarizeComment}')
  assert.ok(finalWrite >= 0, 'final summary checkpoint must be persisted')
})

test('bad credentials and model setup fail the Action visibly', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /setFailed\(\s*[\s\S]*?Unable to create summary bot/)
  assert.match(main, /setFailed\(\s*[\s\S]*?Unable to create review bot/)
  assert.doesNotMatch(main, /Skipped: failed to create (?:summary|review) bot/)
})
