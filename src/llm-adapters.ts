// eslint-disable-next-line import/extensions
import type {LlmConnection, LlmProtocol} from './llm-provider.ts'
// eslint-disable-next-line import/extensions
import {requestResponsesText} from './responses-client.ts'
// eslint-disable-next-line import/extensions
import type {ResponsesRequest} from './responses-client.ts'

export interface LlmTextRequest extends LlmConnection {
  model: string
  prompt: string
  systemMessage?: string
  maxOutputTokens?: number
  reasoningEffort?: string
  timeoutMs?: number
  retries?: number
  retryRateLimits?: boolean
  retryEmptyOutput?: boolean
  fetcher?: ResponsesRequest['fetcher']
  delay?: ResponsesRequest['delay']
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function baseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Unsafe or invalid LLM API base URL')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Unsafe or invalid LLM API base URL')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function endpoint(base: URL, path: string): string {
  return `${base.origin}${base.pathname}/${path}`
}

function boundedText(text: string, protocol: string): string {
  if (text.length > 262144) {
    throw new Error(`${protocol} response exceeds size limit`)
  }
  return text
}

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: Pick<
    LlmTextRequest,
    'fetcher' | 'delay' | 'timeoutMs' | 'retries' | 'retryRateLimits'
  >
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch
  const delay = options.delay ?? pause
  const timeoutMs = options.timeoutMs ?? 120000
  const retries = options.retries ?? 2
  const retryRateLimits = options.retryRateLimits ?? true

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Awaited<ReturnType<NonNullable<typeof options.fetcher>>>
    try {
      response = await fetcher(url, {
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
      throw new Error('LLM request failed after configured retries')
    }
    if (
      !response ||
      typeof response.status !== 'number' ||
      typeof response.ok !== 'boolean'
    ) {
      throw new Error('Invalid LLM HTTP response')
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
      throw new Error(`LLM HTTP ${response.status}`)
    }
    try {
      return await response.json()
    } catch {
      throw new Error('LLM response contains invalid JSON')
    }
  }
  throw new Error('LLM request failed after configured retries')
}

function validateRequest(request: LlmTextRequest): void {
  if (typeof request.apiKey !== 'string' || !request.apiKey.trim()) {
    throw new Error('Missing LLM API key')
  }
  if (
    typeof request.model !== 'string' ||
    request.model.length < 2 ||
    request.model.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/.test(
      request.model
    )
  ) {
    throw new Error('Invalid LLM model ID')
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new Error('Invalid or empty LLM prompt')
  }
  if (
    !Number.isSafeInteger(request.maxOutputTokens ?? 2048) ||
    (request.maxOutputTokens ?? 2048) < 1 ||
    (request.maxOutputTokens ?? 2048) > 16000 ||
    !Number.isSafeInteger(request.retries ?? 2) ||
    (request.retries ?? 2) < 0 ||
    (request.retries ?? 2) > 5 ||
    !Number.isSafeInteger(request.timeoutMs ?? 120000) ||
    (request.timeoutMs ?? 120000) < 1 ||
    (request.timeoutMs ?? 120000) > 600000
  ) {
    throw new Error('Invalid LLM timeout, retry or output limit')
  }
  if (
    request.reasoningEffort !== undefined &&
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      request.reasoningEffort
    )
  ) {
    throw new Error('Invalid reasoning effort')
  }
  if (
    typeof request.retryRateLimits !== 'undefined' &&
    typeof request.retryRateLimits !== 'boolean'
  ) {
    throw new Error('Invalid rate-limit retry setting')
  }
}

function chatText(body: unknown): string {
  const choices = record(body)?.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Chat Completions response has no choices')
  }
  const choice = record(choices[0])
  if (choice?.finish_reason === 'length') {
    throw new Error('Chat Completions response exceeded output token budget')
  }
  if (
    choice?.finish_reason !== 'stop' &&
    choice?.finish_reason !== 'stop_sequence'
  ) {
    throw new Error('Chat Completions response did not finish with text')
  }
  const content = record(choice.message)?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
      ? content
          .map(part => {
            const item = record(part)
            return item?.type === 'text' && typeof item.text === 'string'
              ? item.text
              : ''
          })
          .join('')
      : ''
  if (!text.trim()) throw new Error('Chat Completions response is empty')
  return boundedText(text, 'Chat Completions')
}

function anthropicText(body: unknown): string {
  const root = record(body)
  const stopReason = root?.stop_reason
  if (
    stopReason === 'max_tokens' ||
    stopReason === 'model_context_window_exceeded'
  ) {
    throw new Error('Anthropic response exceeded output token budget')
  }
  if (stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
    throw new Error('Anthropic response did not finish with text')
  }
  if (!Array.isArray(root?.content)) {
    throw new Error('Anthropic response has no content')
  }
  const text = root.content
    .map(part => {
      const item = record(part)
      return item?.type === 'text' && typeof item.text === 'string'
        ? item.text
        : ''
    })
    .join('')
  if (!text.trim()) throw new Error('Anthropic response is empty')
  return boundedText(text, 'Anthropic')
}

function geminiText(body: unknown): string {
  const candidates = record(body)?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Gemini response has no candidates')
  }
  const candidate = record(candidates[0])
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini response exceeded output token budget')
  }
  if (candidate?.finishReason !== 'STOP') {
    throw new Error('Gemini response was blocked or did not finish')
  }
  const parts = record(candidate.content)?.parts
  if (!Array.isArray(parts)) throw new Error('Gemini response has no content')
  const text = parts
    .map(part => {
      const item = record(part)
      return item?.thought !== true && typeof item?.text === 'string'
        ? item.text
        : ''
    })
    .join('')
  if (!text.trim()) throw new Error('Gemini response is empty')
  return boundedText(text, 'Gemini')
}

async function requestChatCompletions(
  request: LlmTextRequest
): Promise<string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.apiKey}`,
    'content-type': 'application/json'
  }
  if (request.apiOrg) headers['openai-organization'] = request.apiOrg
  const body = {
    model: request.model,
    messages: [
      ...(request.systemMessage
        ? [{role: 'system', content: request.systemMessage}]
        : []),
      {role: 'user', content: request.prompt}
    ],
    // eslint-disable-next-line camelcase
    max_tokens: request.maxOutputTokens ?? 2048,
    ...(request.reasoningEffort === undefined
      ? {}
      : // eslint-disable-next-line camelcase
        {reasoning_effort: request.reasoningEffort}),
    stream: false
  }
  const raw = await postJson(
    endpoint(baseUrl(request.apiBaseUrl), 'chat/completions'),
    headers,
    JSON.stringify(body),
    request
  )
  return chatText(raw)
}

async function requestAnthropicMessages(
  request: LlmTextRequest
): Promise<string> {
  if (request.reasoningEffort !== undefined) {
    throw new Error(
      'Reasoning effort is not portable in Anthropic Messages mode'
    )
  }
  const headers = {
    'x-api-key': request.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  }
  const body = {
    model: request.model,
    ...(request.systemMessage ? {system: request.systemMessage} : {}),
    messages: [{role: 'user', content: request.prompt}],
    // eslint-disable-next-line camelcase
    max_tokens: request.maxOutputTokens ?? 2048
  }
  const raw = await postJson(
    endpoint(baseUrl(request.apiBaseUrl), 'messages'),
    headers,
    JSON.stringify(body),
    request
  )
  return anthropicText(raw)
}

async function requestGeminiGenerateContent(
  request: LlmTextRequest
): Promise<string> {
  if (request.reasoningEffort !== undefined) {
    throw new Error(
      'Reasoning effort is not portable in Gemini generateContent mode'
    )
  }
  const model = request.model.replace(/^models\//, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error('Invalid Gemini model ID')
  }
  const headers = {
    'x-goog-api-key': request.apiKey,
    'content-type': 'application/json'
  }
  const body = {
    ...(request.systemMessage
      ? {systemInstruction: {parts: [{text: request.systemMessage}]}}
      : {}),
    contents: [{role: 'user', parts: [{text: request.prompt}]}],
    generationConfig: {maxOutputTokens: request.maxOutputTokens ?? 2048}
  }
  const raw = await postJson(
    endpoint(
      baseUrl(request.apiBaseUrl),
      `models/${encodeURIComponent(model)}:generateContent`
    ),
    headers,
    JSON.stringify(body),
    request
  )
  return geminiText(raw)
}

/** Routes normalized review text through one of the supported wire protocols. */
export async function requestLlmText(request: LlmTextRequest): Promise<string> {
  validateRequest(request)
  const protocol = request.protocol as LlmProtocol
  if (protocol === 'openai-responses') {
    const responseRequest: ResponsesRequest = {
      apiKey: request.apiKey,
      model: request.model,
      prompt: request.prompt,
      systemMessage: request.systemMessage,
      apiBaseUrl: request.apiBaseUrl,
      apiOrg: request.apiOrg,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: request.reasoningEffort,
      timeoutMs: request.timeoutMs,
      retries: request.retries,
      retryRateLimits: request.retryRateLimits,
      retryEmptyOutput: request.retryEmptyOutput,
      fetcher: request.fetcher,
      delay: request.delay
    }
    return requestResponsesText(responseRequest)
  }
  if (protocol === 'openai-chat-completions') {
    return requestChatCompletions(request)
  }
  if (protocol === 'anthropic-messages') {
    return requestAnthropicMessages(request)
  }
  if (protocol === 'gemini-generate-content') {
    return requestGeminiGenerateContent(request)
  }
  throw new Error('Unsupported LLM API protocol')
}
