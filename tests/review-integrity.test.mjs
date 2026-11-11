import test from 'node:test'
import assert from 'node:assert/strict'
import {assessReviewCompletion, issueFingerprint} from '../src/review-integrity.ts'

test('complete only with all expected units and acknowledged publication', () => {
  const x = assessReviewCompletion(
    ['a:1', 'b:5', 'ignored.txt'],
    [
      {id: 'a:1', status: 'reviewed'},
      {id: 'b:5', status: 'triaged_trivial'},
      {id: 'ignored.txt', status: 'ignored_by_policy'}
    ],
    true
  )
  assert.deepEqual(x, {complete: true, blockers: [], reviewed: 1, skippedByPolicy: 2})
})

test('partial token-budget review is never complete', () => {
  const result = assessReviewCompletion(
    ['a:1', 'a:2'],
    [{id: 'a:1', status: 'reviewed'}, {id: 'a:2', status: 'blocked_by_budget'}],
    true
  )
  assert.equal(result.complete, false)
  assert.ok(result.blockers.includes('blocked_by_budget:a:2'))
})

test('failed analyzer and publisher cannot checkpoint head SHA', () => {
  for (const status of ['pending', 'failed_analysis', 'failed_publish']) {
    const x = assessReviewCompletion(['a:1'], [{id: 'a:1', status}], true)
    assert.equal(x.complete, false, status)
  }
  assert.equal(
    assessReviewCompletion(['a:1'], [{id: 'a:1', status: 'reviewed'}], false).complete,
    false
  )
})

test('missing/extra/duplicate units fail closed', () => {
  assert.equal(assessReviewCompletion([], [], true).complete, false)
  assert.equal(assessReviewCompletion(['a', 'b'], [{id: 'a', status: 'reviewed'}], true).complete, false)
  assert.equal(assessReviewCompletion(['a', 'a'], [{id: 'a', status: 'reviewed'}], true).complete, false)
  assert.equal(assessReviewCompletion(['a'], [{id: 'a', status: 'reviewed'}, {id: 'a', status: 'reviewed'}], true).complete, false)
  assert.equal(assessReviewCompletion(['a'], [{id: 'x', status: 'reviewed'}, {id: 'a', status: 'reviewed'}], true).complete, false)
})

test('issue fingerprint survives line/SHA change by design', () => {
  const finding = {
    path: 'src/driver.c',
    ruleId: 'DATA_RACE',
    symbol: 'CanDrv_ISR',
    evidenceSnippet: 'shared_counter++;'
  }
  const a = issueFingerprint(finding)
  const b = issueFingerprint({...finding, path: './src\\driver.c'})
  assert.equal(a, b)
  assert.match(a, /^[a-f0-9]{64}$/)
})

test('issue fingerprint does not conflate different paths/rules/evidence', () => {
  const f = {
    path: 'src/driver.c',
    ruleId: 'DATA_RACE',
    symbol: 'CanDrv_ISR',
    evidenceSnippet: 'shared_counter++;'
  }
  const fingerprints = new Set([
    issueFingerprint(f),
    issueFingerprint({...f, path: 'src/other.c'}),
    issueFingerprint({...f, ruleId: 'NULL_DEREF'}),
    issueFingerprint({...f, evidenceSnippet: 'other_counter++;'}),
    issueFingerprint({...f, symbol: 'CanDrv_Task'})
  ])
  assert.equal(fingerprints.size, 5)
})

test('fingerprints require provenance-bearing fields', () => {
  const base = {path: 'a.c', ruleId: 'DATA_RACE', symbol: '', evidenceSnippet: 'a++'}
  assert.throws(() => issueFingerprint({...base, path: ''}), TypeError)
  assert.throws(() => issueFingerprint({...base, ruleId: ''}), TypeError)
  assert.throws(() => issueFingerprint({...base, evidenceSnippet: '  '}), TypeError)
})
