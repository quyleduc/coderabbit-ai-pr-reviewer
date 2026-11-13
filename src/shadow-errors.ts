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
    if (http[1].startsWith('5')) return 'provider_http_server_error'
    return 'provider_http_client_error'
  }

  if (/request failed after configured retries$/i.test(message)) {
    return 'provider_transport_failed'
  }
  if (
    /^(?:Chat Completions|Anthropic|Gemini) response /.test(message) ||
    message === 'LLM response contains invalid JSON'
  ) {
    return 'provider_response_invalid'
  }

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
    /^Invalid (?:review root|hunk|hunks array|hunk id|findings array|finding|rule_id|severity)/.test(message) ||
    /^(?:Missing or excess hunk verdicts|Unexpected hunk id|Duplicate hunk id|Hunk status and findings disagree|Finding line|Finding evidence)/.test(message) ||
    message === 'invalid_output'
  ) {
    return 'model_output_rejected'
  }

  return 'shadow_review_failed'
}
