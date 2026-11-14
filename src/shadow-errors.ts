/**
 * Map internal shadow-evaluation failures to bounded public diagnostics.
 * Never return provider, PR, patch, or exception text.
 */
export function classifyShadowFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''

  if (message === 'github_rate_limit') return 'github_rate_limit'
  if (message === 'stale_pr') return 'stale_pr'

  const http = /^(?:LLM|OpenAI) HTTP (\d{3})$/.exec(message)
  if (http) {
    if (http[1] === '429') return 'provider_rate_limit'
    return `provider_http_${http[1]}`
  }

  if (/request failed after configured retries$/i.test(message)) {
    return 'provider_transport_failed'
  }
  if (/ response exceeds size limit$/.test(message)) {
    return 'provider_response_too_large'
  }
  const providerResponseCodes: Record<string, string> = {
    'OpenAI response exceeded output token budget': 'provider_output_limit',
    'OpenAI response incomplete or unconfirmed': 'provider_incomplete_response',
    'OpenAI response contains reasoning but no final output text':
      'provider_reasoning_only',
    'OpenAI response contains no output items': 'provider_empty_output',
    'OpenAI response contains no assistant message': 'provider_missing_message',
    'OpenAI response missing or empty': 'provider_empty_output',
    'Invalid OpenAI response JSON': 'provider_invalid_json_envelope',
    'Chat Completions response has no choices': 'provider_missing_choices',
    'Chat Completions response exceeded output token budget':
      'provider_output_limit',
    'Chat Completions response did not finish with text':
      'provider_incomplete_response',
    'Chat Completions response is empty': 'provider_empty_output',
    'Anthropic response exceeded output token budget': 'provider_output_limit',
    'Anthropic response did not finish with text':
      'provider_incomplete_response',
    'Anthropic response has no content': 'provider_missing_content',
    'Anthropic response is empty': 'provider_empty_output',
    'Gemini response has no candidates': 'provider_missing_candidates',
    'Gemini response exceeded output token budget': 'provider_output_limit',
    'Gemini response was blocked or did not finish':
      'provider_incomplete_response',
    'Gemini response has no content': 'provider_missing_content',
    'Gemini response is empty': 'provider_empty_output',
    'LLM response contains invalid JSON': 'provider_invalid_json_envelope'
  }
  if (providerResponseCodes[message]) return providerResponseCodes[message]

  if (
    message === 'invalid_diff' ||
    /^Invalid diff\b/.test(message) ||
    /^Diff hunk count mismatch$/.test(message) ||
    /^Overlapping diff hunks$/.test(message) ||
    /\bpatch\b/i.test(message) ||
    /PR files pagination|Incomplete or inconsistent PR file count/.test(message)
  ) {
    return 'diff_validation_failed'
  }

  if (
    /^Review protocol /.test(message) ||
    /^Unsupported review protocol /.test(message) ||
    /^Invalid (?:review root|hunk|hunks array|hunk id|hunk status|findings array|finding|finding line|finding message|rule_id|severity)/.test(
      message
    ) ||
    /^(?:Missing or excess hunk verdicts|Unexpected hunk id|Duplicate hunk id|Hunk status and findings disagree|Finding line|Finding evidence)/.test(
      message
    ) ||
    message === 'invalid_output'
  ) {
    return 'model_output_rejected'
  }

  return 'shadow_review_failed'
}
