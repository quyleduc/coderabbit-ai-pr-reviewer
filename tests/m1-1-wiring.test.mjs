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
  assert.ok(block.indexOf('await octokit.pulls.submitReview(') < block.lastIndexOf('return true'))
  assert.match(block, /return false/)
})
