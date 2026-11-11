import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')

test('production uses GitHub pulls.listFiles, never Compare API, for file scope', () => {
  assert.match(review, /octokit\.pulls\.listFiles\(/)
  assert.match(review, /loadCompletePullRequestFiles\(/)
  assert.doesNotMatch(review, /octokit\.repos\.compareCommits\(/)
  assert.doesNotMatch(review, /incrementalFiles|targetBranchFiles/)
})

test('production validates exact file metadata and selected patch before model calls', () => {
  assert.match(review, /currentPR\.data\.changed_files/)
  const check = review.indexOf('verifyPullRequestPatch(file)')
  const firstModel = review.indexOf('lightBot.chat(')
  assert.ok(check > 0 && check < firstModel)
})

test('review works on the entire current PR scope, not historical incremental subsets', () => {
  assert.match(review, /Review full PR diff for each new head SHA/)
  assert.doesNotMatch(review, /highestReviewedCommitId/)
  assert.match(review, /existingSummarizeCmtBody\.includes\(REVIEW_COMPLETE_TAG\)/)
})

test('production must reject missing or stale metadata instead of silently succeeding', () => {
  assert.match(review, /setFailed\('Cannot acquire complete PR files:/)
  assert.match(review, /currentPR\.data\.head\.sha !== context\.payload\.pull_request\.head\.sha/)
  assert.match(review, /currentPR\.data\.base\.sha !== context\.payload\.pull_request\.base\.sha/)
})
