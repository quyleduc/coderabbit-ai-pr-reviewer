import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {classifyEvaluationFailure} from '../scripts/controlled-model-eval.mjs'

const sanitize = (message, stage = 'model_request') =>
  classifyEvaluationFailure(new Error(message), stage, 1)

test('safe diagnostics reveal numeric provider HTTP status without raw provider body', () => {
  assert.deepEqual(sanitize('OpenAI HTTP 429'), {
    stage: 'model_request',
    reason: 'HTTP_429',
    fixture_index: 1
  })
  assert.equal(sanitize('OpenAI HTTP 401').reason, 'HTTP_401')
  assert.equal(sanitize('OpenAI HTTP 400').reason, 'HTTP_400')
})

test('safe diagnostics distinguish transport, incomplete, missing and malformed Responses output', () => {
  assert.equal(
    sanitize('OpenAI request failed after configured retries').reason,
    'TRANSPORT_FAILURE'
  )
  assert.equal(
    sanitize('LLM request failed after configured retries').reason,
    'TRANSPORT_FAILURE'
  )
  assert.equal(
    sanitize('OpenAI response incomplete or unconfirmed').reason,
    'RESPONSE_INCOMPLETE'
  )
  assert.equal(
    sanitize('Anthropic response did not finish with text').reason,
    'RESPONSE_INCOMPLETE'
  )
  assert.equal(
    sanitize('OpenAI response missing or empty').reason,
    'RESPONSE_EMPTY'
  )
  assert.equal(sanitize('Gemini response is empty').reason, 'RESPONSE_EMPTY')
  assert.equal(
    sanitize('Chat Completions response exceeded output token budget').reason,
    'RESPONSE_BUDGET_EXHAUSTED'
  )
  assert.equal(
    sanitize('Invalid OpenAI response JSON').reason,
    'RESPONSE_INVALID_JSON'
  )
  assert.equal(
    sanitize('LLM response contains invalid JSON').reason,
    'RESPONSE_INVALID_JSON'
  )
})

test('review protocol error reports stage but never leaks model output, prompt or token', () => {
  const hostile = 'secret=sk-or-v1-private\nsource: *ptr; JSON: {a:1}'
  const result = sanitize(hostile, 'review_validation')
  assert.equal(result.reason, 'REVIEW_PROTOCOL_REJECTED')
  assert.equal(result.stage, 'review_validation')
  assert.ok(!JSON.stringify(result).includes('sk-or-v1-private'))
})

test('unknown errors are not echoed, stage and fixture index are strictly bounded', () => {
  const secret = 'sk-or-v1-private-source'
  const result = classifyEvaluationFailure(
    {message: secret},
    'my-own-unsafe-stage',
    99999999
  )
  assert.deepEqual(result, {
    stage: 'unknown',
    reason: 'UNCLASSIFIED_FAILURE',
    fixture_index: 0
  })
  const unknown = sanitize('Provider response: ' + secret)
  assert.equal(unknown.reason, 'MODEL_REQUEST_FAILED')
  assert.ok(!JSON.stringify(unknown).includes(secret))
})

test('review validation diagnostics distinguish JSON, schema, missing hunks and source evidence', () => {
  for (const [sourceError, expectedReason] of [
    ['Review protocol requires one valid JSON object', 'PROTOCOL_INVALID_JSON'],
    ['Invalid review root schema fields', 'PROTOCOL_ROOT_SCHEMA'],
    ['Missing or excess hunk verdicts', 'PROTOCOL_HUNK_COVERAGE'],
    ['Unexpected hunk id', 'PROTOCOL_HUNK_ID'],
    ['Duplicate hunk id', 'PROTOCOL_HUNK_ID'],
    ['Hunk status and findings disagree', 'PROTOCOL_STATUS_FINDINGS'],
    ['Invalid finding schema fields', 'PROTOCOL_FINDING_SCHEMA'],
    ['Finding line is not an added line in its hunk', 'PROTOCOL_LINE_MISMATCH'],
    [
      'Finding evidence does not match added source line',
      'PROTOCOL_EVIDENCE_MISMATCH'
    ],
    ['Invalid rule_id', 'PROTOCOL_RULE_ID'],
    ['Invalid severity', 'PROTOCOL_SEVERITY'],
    ['Invalid finding message', 'PROTOCOL_MESSAGE'],
    ['Review protocol exceeds response size limit', 'PROTOCOL_TOO_LARGE']
  ]) {
    assert.deepEqual(sanitize(sourceError, 'review_validation'), {
      stage: 'review_validation',
      reason: expectedReason,
      fixture_index: 1
    })
  }
})

test('unknown review parser failure cannot echo arbitrary source or provider response', () => {
  const untrustedOutput =
    'Unexpected provider text: secret=sk-or-v1-secret\\n+return numerator / divisor;'
  const result = sanitize(untrustedOutput, 'review_validation')
  assert.equal(result.reason, 'REVIEW_PROTOCOL_REJECTED')
  assert.equal(result.stage, 'review_validation')
  assert.ok(!JSON.stringify(result).includes('sk-or-v1-secret'))
  assert.ok(!JSON.stringify(result).includes('numerator'))
})

test('CLI diagnostics log only safe category and numeric fixture index', () => {
  const source = readFileSync(
    new URL('../scripts/controlled-model-eval.mjs', import.meta.url),
    'utf8'
  )
  assert.match(
    source,
    /classifyEvaluationFailure\(error, stage, fixtureIndex\)/
  )
  assert.match(source, /JSON\.stringify\(classifyEvaluationFailure/)
  assert.doesNotMatch(
    source,
    /console\.error\(error\)|console\.error\(error\.message\)/
  )
})
