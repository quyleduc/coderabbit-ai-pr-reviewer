import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const commenter = readFileSync(new URL('../src/commenter.ts', import.meta.url), 'utf8')

test('production review uses diff-coordinate guard before buffering inline comments', () => {
  const anchor = review.indexOf('const anchor = resolveReviewAnchor(')
  const buffer = review.indexOf('await commenter.bufferReviewComment(')
  assert.ok(anchor >= 0 && buffer > anchor)
  assert.match(review, /if \(!anchor\.valid\)/)
  assert.doesNotMatch(review, /bestPatchStartLine/)
})

test('completed head marker depends on publisher acknowledgement', () => {
  const publisher = review.indexOf('const published = await commenter.submitReview(')
  const completion = review.indexOf('const completion = assessReviewCompletion(')
  const marker = review.indexOf('if (completion.complete)')
  assert.ok(publisher >= 0 && publisher < completion && completion < marker)
  assert.match(review, /published && summariesFailed\.length === 0 && reviewsFailed\.length === 0/)
  assert.match(review, /latest head SHA not checkpointed/)
})

test('publisher API reports failures instead of swallowing all of them', () => {
  assert.match(commenter, /submitReview\(pullNumber: number, commitId: string, statusMsg: string\): Promise<boolean>/)
  assert.match(commenter, /return allPublished/)
  assert.match(commenter, /return false/)
})

test('success guard rejects legacy SHA markers without a completion marker', () => {
  assert.match(review, /highestReviewedCommitId === context\.payload\.pull_request\.head\.sha &&\s*existingSummarizeCmtBody\.includes\(REVIEW_COMPLETE_TAG\)/)
})

test('substantive bug feedback containing LGTM is not discarded', () => {
  assert.doesNotMatch(review, /review\.comment\.includes\('LGTM'\)/)
  assert.match(review, /review\.comment\.trim\(\)/)
})
