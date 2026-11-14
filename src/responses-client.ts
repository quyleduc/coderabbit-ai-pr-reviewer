/** Shared, dependency-free OpenAI Responses transport.
 * Used by both the production Bot and the controlled fixture evaluator.
 * Provider errors/prompt text are NEVER included in thrown errors.
 */
const MAX_HTTP_BODY_BYTES = 262144 + 65536

export interface FetchResponseLike {
  ok: boolean
  status: number
  headers?: {
    // eslint-disable-next-line no-unused-vars
    get?: (name: string) => string | null
  }
  text?: () => Promise<string>
  body?: ReadableStream<Uint8Array> | null
  json: () => Promise<unknown>
}

export interface ResponsesRequest {
  apiKey: string
  model: string
  prompt: string
  systemMessage?: string
  apiBaseUrl?: string
  apiOrg?: string
  maxOutputTokens?: number
  /** Validated OpenRouter/OpenAI Responses reasoning effort; absent preserves legacy behavior. */
  reasoningEffort?: string
  timeoutMs?: number
  retries?: number
  /** Set false for rate-limited free-model requests to avoid futile quota retries. */
  retryRateLimits?: boolean
  /** Only explicitly opted-in callers retry a completed but empty response. */
  retryEmptyOutput?: boolean
  fetcher?: (
    // eslint-disable-next-line no-unused-vars
    url: string,
    // eslint-disable-next-line no-unused-vars
    init: RequestInit
  ) => Promise<FetchResponseLike>
  delay?: (
    // eslint-disable-next-line no-unused-vars
    ms: number
  ) => Promise<void>
}

function fields(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isPrivateOrLinkLocalIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return false
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '0:0:0:0:0:0:0:0' ||
      host.startsWith('::ffff:') ||
      /^f[cd][0-9a-f]{2}:/.test(host) ||
      /^fe[89ab][0-9a-f]:/.test(host)
    )
  }
  return false
}

export async function readBoundedJson(
  response: FetchResponseLike,
  sizeLimitMessage: string
): Promise<unknown> {
  if (typeof response.headers?.get === 'function') {
    const rawLength = response.headers.get('content-length')
    if (rawLength !== null) {
      const contentLength = Number(rawLength)
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_HTTP_BODY_BYTES
      ) {
        if (response.body && typeof response.body.cancel === 'function') {
          try {
            await response.body.cancel()
          } catch {
            // ignore stream cancel errors on oversized response
          }
        }
        throw new Error(sizeLimitMessage)
      }
    }
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let totalBytes = 0
    let text = ''
    try {
      for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > MAX_HTTP_BODY_BYTES) {
          try {
            await reader.cancel()
          } catch {
            // ignore stream cancel errors on oversized response
          }
          throw new Error(sizeLimitMessage)
        }
        text += decoder.decode(value, {stream: true})
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock()
    }
    return JSON.parse(text)
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (
      text.length > MAX_HTTP_BODY_BYTES ||
      Buffer.byteLength(text, 'utf8') > MAX_HTTP_BODY_BYTES
    ) {
      throw new Error(sizeLimitMessage)
    }
    return JSON.parse(text)
  }
  return response.json()
}

function responsesEndpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('Unsafe or invalid Responses API base URL')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
    isPrivateOrLinkLocalIp(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error('Unsafe or invalid Responses API base URL')
  }
  return `${url.origin + url.pathname.replace(/\/+$/, '')}/responses`
}

type UsageError = Error & {outputTokens?: number; reasoningTokens?: number}

/** Include numeric usage only. Never attach provider body, reasoning or prompt. */
function responseError(
  message: string,
  root: Record<string, unknown>
): UsageError {
  const error: UsageError = new Error(message)
  const usage = fields(root.usage)
  const detail = fields(usage?.output_tokens_details)
  const output = usage?.output_tokens
  const reasoning = detail?.reasoning_tokens
  if (
    typeof output === 'number' &&
    Number.isSafeInteger(output) &&
    output >= 0 &&
    output <= 16000
  ) {
    error.outputTokens = output
  }
  if (
    typeof reasoning === 'number' &&
    Number.isSafeInteger(reasoning) &&
    reasoning >= 0 &&
    reasoning <= 16000
  ) {
    error.reasoningTokens = reasoning
  }
  return error
}

function readOutput(body: unknown): string {
  const root = fields(body)
  if (root?.status !== 'completed' || !Array.isArray(root.output)) {
    if (
      root?.status === 'incomplete' &&
      fields(root.incomplete_details)?.reason === 'max_output_tokens'
    ) {
      throw responseError('OpenAI response exceeded output token budget', root)
    }
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
  const result = primary.trim()
    ? primary
    : typeof root.output_text === 'string'
    ? root.output_text
    : primary
  if (result.length > 262144)
    throw new Error('OpenAI response exceeds size limit')
  if (result.trim()) return result

  // Never interpret model reasoning, tool calls or no output as a clean review.
  if (hasReasoning) {
    throw responseError(
      'OpenAI response contains reasoning but no final output text',
      root
    )
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
  reasoningEffort,
  timeoutMs = 120000,
  retries = 2,
  retryRateLimits = true,
  retryEmptyOutput = false,
  fetcher = fetch,
  delay = pause
}: ResponsesRequest): Promise<string> {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Missing OpenAI API key')
  }
  if (
    typeof model !== 'string' ||
    model.length < 2 ||
    model.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/.test(
      model
    )
  ) {
    throw new Error('Invalid OpenAI model ID')
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Invalid or empty OpenAI prompt')
  }
  if (
    !Number.isSafeInteger(retries) ||
    retries < 0 ||
    retries > 5 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 16000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600000
  ) {
    throw new Error('Invalid retry, timeout or output limit')
  }
  if (typeof retryEmptyOutput !== 'boolean') {
    throw new Error('Invalid empty-output retry setting')
  }
  if (typeof retryRateLimits !== 'boolean') {
    throw new Error('Invalid rate-limit retry setting')
  }
  if (
    reasoningEffort !== undefined &&
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      reasoningEffort
    )
  ) {
    throw new Error('Invalid reasoning effort')
  }
  const endpoint = responsesEndpoint(apiBaseUrl)
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  }
  if (apiOrg) headers['openai-organization'] = apiOrg
  const body = JSON.stringify({
    model,
    instructions: systemMessage,
    input: [{role: 'user', content: prompt}],
    // eslint-disable-next-line camelcase
    max_output_tokens: maxOutputTokens,
    ...(reasoningEffort === undefined
      ? {}
      : {reasoning: {effort: reasoningEffort}}),
    store: false
  })

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: FetchResponseLike
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      if (attempt < retries) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw new Error('OpenAI request failed after configured retries')
    }
    if (
      !response ||
      typeof response.status !== 'number' ||
      typeof response.ok !== 'boolean'
    ) {
      throw new Error('Invalid OpenAI HTTP response')
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        (response.status >= 500 && response.status < 600)
      if (
        retryable &&
        (response.status !== 429 || retryRateLimits) &&
        attempt < retries
      ) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw new Error(`OpenAI HTTP ${response.status}`)
    }
    let decoded: unknown
    try {
      decoded = await readBoundedJson(
        response,
        'OpenAI response exceeds size limit'
      )
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid OpenAI response JSON')
      }
      if (
        error instanceof Error &&
        error.message === 'OpenAI response exceeds size limit'
      ) {
        throw error
      }
      if (attempt < retries) {
        await delay(Math.min(1000 * 2 ** attempt, 10000))
        continue
      }
      throw new Error('OpenAI request failed after configured retries')
    }
    try {
      return readOutput(decoded)
    } catch (error) {
      const empty =
        error instanceof Error &&
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
