import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')

test('reviewer must not download unchanged base-file contents it never consumes', () => {
  assert.doesNotMatch(review, /octokit\.repos\.getContent\(/)
  assert.doesNotMatch(review, /fileContent/)
})

test('review dataflow retains filename, diff and complete parsed hunk tuples', () => {
  assert.match(review, /return \[file\.filename, fileDiff, patches\]/)
  assert.match(review, /doReview\(filename, fileDiff, patches\)/)
  assert.match(review, /doSummary\(filename, fileDiff\)/)
})
