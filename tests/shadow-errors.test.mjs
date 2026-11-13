import assert from 'node:assert/strict'
import test from 'node:test'
import {classifyShadowFailure} from '../src/shadow-errors.ts'

test('classifies provider and validation failures with bounded codes', () => {
  const cases = [
    ['LLM HTTP 429', 'provider_rate_limit'],
    ['LLM HTTP 503', 'provider_http_server_error'],
    ['LLM HTTP 401', 'provider_http_client_error'],
    ['LLM request failed after configured retries', 'provider_transport_failed'],
    ['Chat Completions response has no choices', 'provider_response_invalid'],
    ['LLM response contains invalid JSON', 'provider_response_invalid'],
    ['Review protocol requires one valid JSON object', 'model_output_rejected'],
    ['Finding evidence does not match added source line', 'model_output_rejected'],
    ['Missing usable patch: secret/path.c', 'diff_validation_failed'],
    ['github_rate_limit', 'github_rate_limit'],
    ['stale_pr', 'stale_pr'],
    ['unrecognized provider body: secret-token', 'shadow_review_failed']
  ]

  for (const [message, expected] of cases) {
    assert.equal(classifyShadowFailure(new Error(message)), expected)
  }
})

test('does not expose arbitrary thrown text in the diagnostic code', () => {
  const secret = 'provider response included api-key=do-not-log'
  assert.equal(classifyShadowFailure(new Error(secret)), 'shadow_review_failed')
  assert.equal(classifyShadowFailure(secret), 'shadow_review_failed')
})
