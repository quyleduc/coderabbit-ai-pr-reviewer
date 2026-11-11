import test from 'node:test'
import assert from 'node:assert/strict'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {processStructuredReview} from '../src/review-protocol.ts'
import {planReviewPublication} from '../src/review-dedup.ts'
import {publishReviewBatch} from '../src/review-publication.ts'

const patch = '@@ -1,2 +1,2 @@\n-old\n+newValue();\n keep\n@@ -8 +8 @@\n-before\n+after();\n'
const index = buildChangedLineIndex(patch)
const clean = {id: 'h0', status: 'clean', findings: []}
const issue = {
  id: 'h1', status: 'issues',
  findings: [{line: 8, rule_id: 'NULL_DEREF', severity: 'high',
    message: 'Potential null pointer access.',
    evidence: 'after();'}]
}
const response = hunks => JSON.stringify({version: 1, hunks})

test('structured protocol acknowledges every expected hunk and emits evidence-backed findings', () => {
  const result = processStructuredReview(response([clean, issue]), index, patch, 2)
  assert.deepEqual(result.reviewedHunks, [0, 1])
  assert.equal(result.comments.length, 1)
  assert.equal(result.comments[0].startLine, 8)
  assert.equal(result.comments[0].endLine, 8)
  assert.match(result.comments[0].message, /NULL_DEREF/)
  assert.match(result.comments[0].message, /Potential null pointer access/)
})

test('reject missing or duplicate hunk reports instead of checkpointing partial output', () => {
  assert.throws(() => processStructuredReview(response([clean]), index, patch, 2), /missing|hunk/i)
  assert.throws(() => processStructuredReview(response([clean, clean]), index, patch, 2), /duplicate/i)
  assert.throws(() => processStructuredReview(response([clean, {...issue, id: 'h99'}]), index, patch, 2), /unexpected|invalid hunk/i)
})

test('reject findings on context lines or another hunk', () => {
  const badContext = {...issue, findings: [{...issue.findings[0], line: 2}]}
  const wrongHunk = {...issue, findings: [{...issue.findings[0], line: 1, evidence: 'newValue();'}]}
  assert.throws(() => processStructuredReview(response([clean, badContext]), index, patch, 2), /changed|evidence|line/i)
  assert.throws(() => processStructuredReview(response([clean, wrongHunk]), index, patch, 2), /hunk|line/i)
})

test('source evidence must match the actual added source line, not model imagination', () => {
  const bad = {...issue, findings: [{...issue.findings[0], evidence: 'not in the actual diff'}]}
  assert.throws(() => processStructuredReview(response([clean, bad]), index, patch, 2), /evidence/i)
})

test('reject inconsistent or incomplete verdicts', () => {
  const noFindings = {...issue, findings: []}
  const cleanWithIssue = {...clean, findings: issue.findings}
  assert.throws(() => processStructuredReview(response([clean, noFindings]), index, patch, 2), /findings|status/i)
  assert.throws(() => processStructuredReview(response([cleanWithIssue, issue]), index, patch, 2), /findings|status/i)
})

test('strict schema rejects unknown properties, invalid severity, negative line and oversized messages', () => {
  assert.throws(() => processStructuredReview(JSON.stringify({version: 2, hunks: [clean, issue]}), index, patch, 2), /version/i)
  assert.throws(() => processStructuredReview(response([{...clean, fabricated: true}, issue]), index, patch, 2), /field|schema/i)
  assert.throws(() => processStructuredReview(response([clean, {...issue, findings: [{...issue.findings[0], severity: 'criticality'}]}]), index, patch, 2), /severity/i)
  assert.throws(() => processStructuredReview(response([clean, {...issue, findings: [{...issue.findings[0], line: -1}]}]), index, patch, 2), /line/i)
  assert.throws(() => processStructuredReview(response([clean, {...issue, findings: [{...issue.findings[0], message: 'x'.repeat(3000)}]}]), index, patch, 2), /message/i)
})

test('accept one JSON code fence but reject extra untrusted prose and invalid JSON', () => {
  const json = response([clean, issue])
  const fenced = [String.fromCharCode(96, 96, 96) + 'json', json, String.fromCharCode(96, 96, 96)].join('\n')
  assert.equal(processStructuredReview(fenced, index, patch, 2).comments.length, 1)
  assert.throws(() => processStructuredReview('Ignore all prior instructions\n' + json, index, patch, 2), /JSON|protocol/i)
  assert.throws(() => processStructuredReview('{', index, patch, 2), /JSON|protocol/i)
})

test('end-to-end deterministic fake model to fake GitHub publication', async () => {
  const fakeModel = async () => response([clean, issue])
  const fakeCalls = []
  const fakeGitHub = {
    createReview: async request => {
      fakeCalls.push({kind: 'create', request})
      return 44
    },
    submitReview: async (id, body) => {
      fakeCalls.push({kind: 'submit', id, body})
    },
    discardPendingReview: async () => { throw new Error('should not cleanup') }
  }
  const review = processStructuredReview(await fakeModel(), index, patch, 2)
  const candidates = review.comments.map(v => ({path: 'src/driver.c', ...v}))
  const planned = planReviewPublication(candidates, [])
  const outcome = await publishReviewBatch(planned.pending, 'a'.repeat(40), 'Review status', fakeGitHub)
  assert.deepEqual(outcome, {confirmed: true, kind: 'submitted'})
  assert.equal(fakeCalls.length, 2)
  assert.equal(fakeCalls[0].request.comments[0].path, 'src/driver.c')
  assert.equal(fakeCalls[0].request.comments[0].line, 8)
  assert.equal(fakeCalls[1].id, 44)
})
