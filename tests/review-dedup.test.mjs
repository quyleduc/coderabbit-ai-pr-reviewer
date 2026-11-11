import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planReviewPublication,
  publicationFingerprint,
  publishedFingerprints
} from '../src/review-dedup.ts'

const finding = {
  path: 'src/main.c',
  startLine: 7,
  endLine: 7,
  message: 'A null pointer may be dereferenced here.'
}

test('first publication produces a traceable fingerprint marker', () => {
  const result = planReviewPublication([finding], [])
  assert.equal(result.pending.length, 1)
  assert.equal(result.suppressed, 0)
  const keys = publishedFingerprints(result.pending[0].message)
  assert.deepEqual(keys, [publicationFingerprint(finding)])
})

test('identical rerun suppresses a finding already published to GitHub', () => {
  const first = planReviewPublication([finding], []).pending[0]
  const next = planReviewPublication([finding], [first.message])
  assert.equal(next.pending.length, 0)
  assert.equal(next.suppressed, 1)
})

test('duplicates within same LLM response only publish once', () => {
  const result = planReviewPublication([finding, finding], [])
  assert.equal(result.pending.length, 1)
  assert.equal(result.suppressed, 1)
})

test('different file, line or substantive message remains distinct', () => {
  const result = planReviewPublication([
    finding,
    {...finding, path: 'src/other.c'},
    {...finding, startLine: 8, endLine: 8},
    {...finding, message: 'This can race with an ISR.'}
  ], [])
  assert.equal(result.pending.length, 4)
  assert.equal(result.suppressed, 0)
})

test('fingerprint is stable across CRLF and canonical file path spelling', () => {
  const one = publicationFingerprint(finding)
  assert.equal(
    publicationFingerprint({...finding, path: './src\\main.c', message: finding.message + '\r\n'}),
    one
  )
})

test('untrusted free-text without valid marker does not suppress', () => {
  assert.equal(planReviewPublication([finding], ['I already reviewed this.']).pending.length, 1)
  assert.equal(publishedFingerprints('<!-- coderabbit:published-finding-v1:FAKE -->').length, 0)
})

test('invalid candidates cannot become GitHub inline comments', () => {
  assert.throws(() => publicationFingerprint({...finding, startLine: -1}), TypeError)
  assert.throws(() => publicationFingerprint({...finding, endLine: 1}), TypeError)
  assert.throws(() => publicationFingerprint({...finding, message: ''}), TypeError)
  assert.throws(() => publicationFingerprint({...finding, path: ''}), TypeError)
})

test('rerun plan does not mutate its input and original message remains', () => {
  const input = [{...finding}]
  const result = planReviewPublication(input, [])
  assert.deepEqual(input, [finding])
  assert.match(result.pending[0].message, /A null pointer may be dereferenced here/)
  assert.equal(result.pending[0].message.includes('<!-- coderabbit:published-finding-v1:'), true)
})
