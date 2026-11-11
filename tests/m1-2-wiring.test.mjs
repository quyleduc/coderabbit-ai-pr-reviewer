import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const prompts = readFileSync(new URL('../src/prompts.ts', import.meta.url), 'utf8')

test('production model response uses strict structured validator, not Markdown parser', () => {
  assert.match(review, /processStructuredReview\(response, changedLineIndex, fileDiff, patchesPacked\)/)
  assert.doesNotMatch(review, /parseReviewResponse\(response\)/)
})

test('every packed hunk has a stable h-prefixed id in model input', () => {
  assert.match(review, /review_hunk id=h/)
  assert.match(review, /getTokenCount\([^)]*hunk/i)
})

test('publisher buffers only validated findings from structured output', () => {
  const validate = review.indexOf('processStructuredReview(response, changedLineIndex, fileDiff, patchesPacked)')
  const publish = review.indexOf('await commenter.bufferReviewComment(', validate)
  assert.ok(validate > 0 && publish > validate)
})

test('prompt mandates exact JSON per hunk rather than free-form Markdown', () => {
  assert.match(prompts, /"version":1/)
  assert.match(prompts, /"status":"clean"/)
  assert.match(prompts, /"status":"issues"/)
  assert.match(prompts, /"evidence"/)
  assert.doesNotMatch(prompts.slice(prompts.indexOf('reviewFileDiff ='), prompts.indexOf('  comment =')), /Example response[\s\S]*22-22:/)
})
