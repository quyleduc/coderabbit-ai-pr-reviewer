/** Shared, dependency-free OpenAI Responses transport.
 * Used by both the production Bot and the controlled fixture evaluator.
 * Provider errors/prompt text are NEVER included in thrown errors.
 */
export interface ResponsesRequest {
  apiKey: string
  model: string
  prompt: string
  systemMessage?: string
  apiBaseUrl?: string
  apiOrg?: string
  maxOutputTokens?: number
  timeoutMs?: number
  retries?: number
  /** Only explicitly opted-in callers retry a completed but empty response. */
  retryEmptyOutput?: boolean
  fetcher?: (url: string, init: RequestInit) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
  }>
  delay?: (ms: number) => Promise<void>
}

function fields(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function responsesEndpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('Unsafe or invalid Responses API base URL')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!((url.protocol === 'https:') || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.hash || url.search) {
    throw new Error('Unsafe or invalid Responses API base URL')
  }
  return url.origin + url.pathname.replace(/\/+$/, '') + '/responses'
}

function readOutput(body: unknown): string {
  const root = fields(body)
  if (root?.status !== 'completed' || !Array.isArray(root.output)) {
    throw new Error('OpenAI response incomplete or unconfirmed')
  }
  const text: string[] = []
  let hasMessage = false
  let hasReasoning = false
  for (const output of root.output) {
    const item = fields(output)
    if (item?.type === 'reasoning') hasReasoning = true
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    hasMessage = true
    for (const rawPart of item.content) {
      const part = fields(rawPart)
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        text.push(part.text)
      }
    }
  }

  // OpenRouter documents response-level output_text in addition to output[].
  // It is used only if no message output_text exists and status is completed.
  const primary = text.join('')
  const result = primary.trim() ? primary :
    (typeof root.output_text === 'string' ? root.output_text : primary)
  if (result.length > 262144) throw new Error('OpenAI response exceeds size limit')
  if (result.trim()) return result

  // Never interpret model reasoning, tool calls or no output as a clean review.
  if (hasReasoning) {
    throw new Error('OpenAI response contains reasoning but no final output text')
  }
  if (root.output.length === 0) {
    throw new Error('OpenAI response contains no output items')
  }
  if (!hasMessage) {
    throw new Error('OpenAI response contains no assistant message')
  }
  throw new Error('OpenAI response missing or empty')
}

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/** Each attempt is stateless: store:false and no previous_response_id. */
export async function requestResponsesText({
  apiKey,
  model,
  prompt,
  systemMessage = '',
  apiBaseUrl = 'https://api.openai.com/v1',
  apiOrg,
  maxOutputTokens = 2048,
  timeoutMs = 120000,
  retries = 2,
  retryEmptyOutput = false,
  fetcher = fetch,
  delay = pause
}: ResponsesRequest): Promise<string> {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Missing OpenAI API key')
  }
  if (typeof model !== 'string' || model.length < 2 || model.length > 90 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/.test(model)) {
    throw new Error('Invalid OpenAI model ID')
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Invalid or empty OpenAI prompt')
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
      maxOutputTokens > 16000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new Error('Invalid retry, timeout or output limit')
  }
  if (typeof retryEmptyOutput !== 'boolean') {
    throw new Error('Invalid empty-output retry setting')
  }
  const endpoint = responsesEndpoint(apiBaseUrl)
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + apiKey,
    'content-type': 'application/json'
  }
  if (apiOrg) headers['openai-organization'] = apiOrg
  const body = JSON.stringify({
    model,
    instructions: systemMessage,
    input: [{role: 'user', content: prompt}],
    max_output_tokens: maxOutputTokens,
    store: false
  })

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: {ok: boolean; status: number; json: () => Promise<unknown>}
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      if (attempt < retries) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw new Error('OpenAI request failed after configured retries')
    }
    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      throw new Error('Invalid OpenAI HTTP response')
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 ||
        (response.status >= 500 && response.status < 600)
      if (retryable && attempt < retries) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw new Error('OpenAI HTTP ' + response.status)
    }
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch {
      throw new Error('Invalid OpenAI response JSON')
    }
    try {
      return readOutput(decoded)
    } catch (error) {
      const empty = error instanceof Error &&
        (error.message === 'OpenAI response contains no output items' ||
         error.message === 'OpenAI response missing or empty')
      if (retryEmptyOutput && empty && attempt < retries) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw error
    }
  }
  throw new Error('OpenAI request failed after configured retries')
}
