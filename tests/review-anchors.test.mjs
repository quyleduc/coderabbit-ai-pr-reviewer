import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChangedLineIndex,
  resolveReviewAnchor
} from '../src/diff-hunks.ts'

const mixed = '@@ -2,3 +2,3 @@\n context\n-old\n+new\n finish\n'
const mixedIndex = buildChangedLineIndex(mixed)

test('find exact changed lines in mixed hunk', () => {
  assert.deepEqual(mixedIndex, {
    valid: true,
    hunks: [{startLine: 2, endLine: 4, addedLines: [3]}]
  })
})

test('allow a precise changed-line anchor without altering range', () => {
  assert.deepEqual(resolveReviewAnchor(mixedIndex, 3, 3), {
    valid: true, startLine: 3, endLine: 3, adjusted: false
  })
})

test('adjust within original range but not to another hunk', () => {
  assert.deepEqual(resolveReviewAnchor(mixedIndex, 2, 4), {
    valid: true, startLine: 3, endLine: 3, adjusted: true
  })
  assert.deepEqual(resolveReviewAnchor(mixedIndex, 2, 2), {
    valid: false, reason: 'unchanged_line'
  })
})

test('reject out-of-diff and malformed model coordinates', () => {
  for (const [start, end] of [[1, 1], [4, 5], [4, 2], [0, 1], [1.5, 3], [3, Infinity]]) {
    assert.equal(resolveReviewAnchor(mixedIndex, start, end).valid, false)
  }
})

test('preserve contiguous added-only multi-line anchors', () => {
  const idx = buildChangedLineIndex('@@ -0,0 +1,2 @@\n+one\n+two\n')
  assert.deepEqual(resolveReviewAnchor(idx, 1, 2), {
    valid: true, startLine: 1, endLine: 2, adjusted: false
  })
})

test('reject deletion-only hunk for new-side inline comments', () => {
  const idx = buildChangedLineIndex('@@ -3,2 +2,0 @@\n-old\n-older\n')
  assert.equal(idx.valid, true)
  assert.deepEqual(resolveReviewAnchor(idx, 2, 2), {
    valid: false, reason: 'outside_hunk'
  })
})

test('accept default count and file without terminal newline', () => {
  const idx = buildChangedLineIndex(
    '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'
  )
  assert.equal(idx.valid, true)
  assert.deepEqual(resolveReviewAnchor(idx, 1, 1), {
    valid: true, startLine: 1, endLine: 1, adjusted: false
  })
})

test('reject truncated hunks instead of assuming valid coordinates', () => {
  const idx = buildChangedLineIndex('@@ -1,3 +1,3 @@\n-a\n+b\n')
  assert.deepEqual(idx, {valid: false, reason: 'hunk_count_mismatch', hunks: []})
  assert.deepEqual(resolveReviewAnchor(idx, 1, 1), {
    valid: false, reason: 'invalid_diff'
  })
})

test('reject unexpected hunk body and metadata', () => {
  assert.equal(buildChangedLineIndex('@@ -1 +1 @@\nwrong\n').valid, false)
  assert.equal(buildChangedLineIndex('@@ -1 +1 @@\n-old\n\\ unknown\n+new\n').valid, false)
})

test('cannot attach cross-hunk range to unrelated lines', () => {
  const idx = buildChangedLineIndex(
    '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-was\n+now\n'
  )
  assert.equal(idx.valid, true)
  assert.equal(resolveReviewAnchor(idx, 1, 10).valid, false)
  assert.deepEqual(resolveReviewAnchor(idx, 10, 10), {
    valid: true, startLine: 10, endLine: 10, adjusted: false
  })
})

test('unavailable binary patch does not produce publishable anchor', () => {
  const idx = buildChangedLineIndex('')
  assert.deepEqual(idx, {valid: false, reason: 'no_hunks', hunks: []})
  assert.equal(resolveReviewAnchor(idx, 1, 1).valid, false)
})
