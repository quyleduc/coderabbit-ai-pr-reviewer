import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const commenter = readFileSync(new URL('../src/commenter.ts', import.meta.url), 'utf8')

test('production review validates full JSON and source evidence before buffering', () => {
  const validator = review.indexOf('processStructuredReview(response, changedLineIndex, fileDiff, patchesPacked)')
  const buffer = review.indexOf('await commenter.bufferReviewComment(', validator)
  assert.ok(validator >= 0 && buffer > validator)
  const protocol = readFileSync(new URL('../src/review-protocol.ts', import.meta.url), 'utf8')
  assert.match(protocol, /addedLines\.includes\(line\)/)
  assert.match(protocol, /evidence\.trim\(\) !== added\.texts\.get\(line\)/)
})

test('completed head marker depends on publisher acknowledgement', () => {
  const publisher = review.indexOf('const published = await commenter.submitReview(')
  const completion = review.indexOf('const fileCompletion = assessReviewCompletion(')
  const hunkCompletion = review.indexOf('const hunkCompletion = assessReviewCompletion(')
  const marker = review.indexOf('if (completion.complete)')
  assert.ok(publisher >= 0 && publisher < completion && completion < hunkCompletion && hunkCompletion < marker)
  assert.match(review, /published && summariesFailed\.length === 0 && reviewsFailed\.length === 0/)
  assert.match(review, /latest head SHA not checkpointed/)
})

test('publisher API reports failures instead of swallowing all of them', () => {
  assert.match(commenter, /submitReview\(pullNumber: number, commitId: string, statusMsg: string\): Promise<boolean>/)
  assert.match(commenter, /await octokit\.pulls\.submitReview\(/)
  assert.match(commenter, /await publishReviewBatch\(/)
  assert.match(commenter, /return result\.confirmed/)
  assert.match(commenter, /return false/)
})

test('success guard rejects legacy SHA markers without a completion marker', () => {
  assert.match(review, /existingSummarizeCmtBody\.includes\(REVIEW_COMPLETE_TAG\)/)
  assert.match(review, /existingSummarizeCmtBody\.includes\(currentScopeMarker\)/)
  assert.match(review, /commenter\.getReviewedCommitIds\(existingCommitIdsBlock\)/)
})

test('structured findings do not rely on substring LGTM filtering', () => {
  assert.doesNotMatch(review, /review\.comment\.includes\('LGTM'\)/)
  assert.match(review, /for \(const finding of structured\.comments\)/)
})
