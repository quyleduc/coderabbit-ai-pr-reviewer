import test from 'node:test'
import assert from 'node:assert/strict'
import {parseReviewResponse} from '../src/review-response.ts'

test('accepts the current model format with issue, diff block and LGTM', () => {
  const value = [
    '22-22:',
    'Possible syntax error.',
    '```diff',
    '- retrn z',
    '+ return z',
    '```',
    '---',
    '24-25:',
    'LGTM!',
    '---'
  ].join('\n')
  const reviews = parseReviewResponse(value)
  assert.equal(reviews.length, 2)
  assert.deepEqual(reviews.map(({startLine, endLine}) => [startLine, endLine]), [[22, 22], [24, 25]])
  assert.match(reviews[0].comment, /Possible syntax error/)
  assert.equal(reviews[1].comment, 'LGTM!')
})

test('empty model comment cannot acknowledge a hunk', () => {
  assert.throws(() => parseReviewResponse('22-22:\n---'), /empty|missing/i)
  assert.throws(() => parseReviewResponse('22-22:\n  \n---'), /empty|missing/i)
})

test('line-like headings inside fenced code do not create bogus findings', () => {
  const response = [
    '11-11:',
    'This line contains source text:',
    '```c',
    '22-22:',
    '---',
    '```',
    '---'
  ].join('\n')
  const reviews = parseReviewResponse(response)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].startLine, 11)
  assert.match(reviews[0].comment, /22-22:/)
  assert.match(reviews[0].comment, /\n---\n/)
})

test('code fence line labels in diff code are sanitized, not treated as response headings', () => {
  const response = '9-9:\n```diff\n 9: -wrong\n 9: +right\n```\n---'
  const reviews = parseReviewResponse(response)
  assert.equal(reviews.length, 1)
  assert.doesNotMatch(reviews[0].comment, /9: -wrong/)
  assert.match(reviews[0].comment, /-wrong/)
})

test('unterminated code fence rejects the response', () => {
  assert.throws(() => parseReviewResponse('9-9:\n```c\nint x = 2;\n---'), /fence|unterminated/i)
})

test('invalid, reversed or overflowing model coordinates are rejected', () => {
  for (const source of ['0-1:\nBug\n---', '9-8:\nBug\n---', '9999999999999999999-9999999999999999999:\nBug\n---']) {
    assert.throws(() => parseReviewResponse(source), /invalid|range/i)
  }
})

test('an empty or unrelated response must not be counted as a review', () => {
  assert.deepEqual(parseReviewResponse(''), [])
  assert.deepEqual(parseReviewResponse('I reviewed the code, LGTM!'), [])
})

test('multiple findings in the same code hunk remain separate', () => {
  const response = '2-2:\nFirst issue\n---\n3-3:\nSecond issue\n---'
  assert.deepEqual(parseReviewResponse(response).map(v => v.comment), ['First issue', 'Second issue'])
})
