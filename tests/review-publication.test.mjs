import test from 'node:test'
import assert from 'node:assert/strict'
import {publishReviewBatch} from '../src/review-publication.ts'

const finding = {
  path: 'src/can.c',
  startLine: 40,
  endLine: 42,
  message: 'Potential race between task and ISR.'
}

function fakeTransport(overrides = {}) {
  const calls = []
  const transport = {
    async createReview(request) {
      calls.push({kind: 'create', request})
      return 123
    },
    async submitReview(id, body) {
      calls.push({kind: 'submit', id, body})
    },
    async discardPendingReview(id) {
      calls.push({kind: 'discard', id})
    },
    ...overrides
  }
  return {calls, transport}
}

test('one pending finding produces correct GitHub RIGHT-side coordinates', async () => {
  const {calls, transport} = fakeTransport()
  const result = await publishReviewBatch([finding], 'a'.repeat(40), 'Review result', transport)
  assert.deepEqual(result, {confirmed: true, kind: 'submitted'})
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].request.comments, [{
    path: finding.path,
    body: finding.message,
    start_line: 40,
    start_side: 'RIGHT',
    line: 42,
    side: 'RIGHT'
  }])
  assert.deepEqual(calls[1], {kind: 'submit', id: 123, body: 'Review result'})
})

test('single line comment has no unnecessary start_line', async () => {
  const {calls, transport} = fakeTransport()
  const one = {...finding, startLine: 42}
  assert.equal((await publishReviewBatch([one], 'sha', 'body', transport)).confirmed, true)
  assert.equal(calls[0].request.comments[0].start_line, undefined)
})

test('empty review is posted only after direct GitHub acceptance', async () => {
  const {calls, transport} = fakeTransport()
  const result = await publishReviewBatch([], 'sha', 'No findings', transport)
  assert.deepEqual(result, {confirmed: true, kind: 'empty'})
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request, {commitId: 'sha', body: 'No findings', event: 'COMMENT'})
})

test('GitHub create timeout returns unconfirmed and never invokes submit', async () => {
  let submitCalls = 0
  const {transport} = fakeTransport({
    async createReview() {throw new Error('504 timeout')},
    async submitReview() {submitCalls++}
  })
  const result = await publishReviewBatch([finding], 'sha', 'body', transport)
  assert.deepEqual(result, {confirmed: false, kind: 'create_failed', error: 'Error: 504 timeout'})
  assert.equal(submitCalls, 0)
})

test('ambiguous submit failure attempts cleanup and remains unconfirmed', async () => {
  const calls = []
  const {transport} = fakeTransport({
    async submitReview(id) {
      calls.push('submit:' + id)
      throw new Error('timeout after commit')
    },
    async discardPendingReview(id) {calls.push('cleanup:' + id)}
  })
  const result = await publishReviewBatch([finding], 'sha', 'body', transport)
  assert.deepEqual(calls, ['submit:123', 'cleanup:123'])
  assert.deepEqual(result, {
    confirmed: false,
    kind: 'submit_unconfirmed',
    error: 'Error: timeout after commit'
  })
})

test('failed cleanup never becomes permission to repost individual comments', async () => {
  const {transport} = fakeTransport({
    async submitReview() {throw new Error('connection reset')},
    async discardPendingReview() {throw new Error('cleanup failed')}
  })
  const result = await publishReviewBatch([finding], 'sha', 'body', transport)
  assert.equal(result.confirmed, false)
  assert.equal(result.kind, 'submit_unconfirmed')
})

test('invalid GitHub create response cannot count as acknowledged publication', async () => {
  const {transport} = fakeTransport({async createReview() {return NaN}})
  const result = await publishReviewBatch([finding], 'sha', 'body', transport)
  assert.equal(result.confirmed, false)
  assert.equal(result.kind, 'create_failed')
})

test('empty-review API failure is also unconfirmed', async () => {
  const {transport} = fakeTransport({async createReview() {throw new Error('rate limit')}})
  const result = await publishReviewBatch([], 'sha', 'body', transport)
  assert.equal(result.confirmed, false)
  assert.equal(result.kind, 'create_failed')
})
