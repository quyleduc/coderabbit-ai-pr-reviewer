import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveLlmConnection} from '../src/llm-provider.ts'
import {requestLlmText} from '../src/llm-adapters.ts'

const credentials = {
  OPENAI_API_KEY: 'openai-secret',
  OPENROUTER_API_KEY: 'openrouter-secret',
  FREEMODEL_API_KEY: 'freemodel-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  GEMINI_API_KEY: 'gemini-secret',
  LLM_API_KEY: 'generic-secret'
}

const response = payload => ({
  ok: true,
  status: 200,
  json: async () => payload
})

test('provider profiles select isolated credentials, base URLs, and default wire protocols', () => {
  assert.deepEqual(resolveLlmConnection('openai', credentials), {
    apiKey: 'openai-secret',
    apiBaseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses'
  })
  assert.deepEqual(resolveLlmConnection('openrouter', credentials), {
    apiKey: 'openrouter-secret',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-responses'
  })
  assert.deepEqual(resolveLlmConnection('freemodel', credentials), {
    apiKey: 'freemodel-secret',
    apiBaseUrl: 'https://freemodel.in/v1',
    protocol: 'openai-chat-completions'
  })
  assert.deepEqual(resolveLlmConnection('anthropic', credentials), {
    apiKey: 'anthropic-secret',
    apiBaseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic-messages'
  })
  assert.deepEqual(resolveLlmConnection('gemini', credentials), {
    apiKey: 'gemini-secret',
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'gemini-generate-content'
  })
})

test('OpenAI-compatible custom endpoints require an explicit HTTPS base and generic credential', () => {
  assert.deepEqual(
    resolveLlmConnection(
      'openai-compatible',
      credentials,
      'https://gateway.example/v1',
      'openai-chat-completions'
    ),
    {
      apiKey: 'generic-secret',
      apiBaseUrl: 'https://gateway.example/v1',
      protocol: 'openai-chat-completions'
    }
  )
  assert.throws(
    () => resolveLlmConnection('openai-compatible', credentials),
    /base url/i
  )
  assert.throws(
    () =>
      resolveLlmConnection(
        'openai-compatible',
        credentials,
        'http://gateway.example/v1'
      ),
    /https|base url/i
  )
})

test('provider-specific endpoint override and protocol override are resolved independently', () => {
  assert.deepEqual(
    resolveLlmConnection(
      'freemodel',
      credentials,
      'https://proxy.example/v1',
      'anthropic-messages'
    ),
    {
      apiKey: 'freemodel-secret',
      apiBaseUrl: 'https://proxy.example/v1',
      protocol: 'anthropic-messages'
    }
  )
  assert.throws(
    () =>
      resolveLlmConnection(
        'freemodel',
        credentials,
        undefined,
        'made-up-protocol'
      ),
    /protocol/i
  )
  assert.equal(
    resolveLlmConnection('freemodel', {LLM_API_KEY: 'shared-key'}).apiKey,
    'shared-key'
  )
})

test('OpenAI Responses remains the default transport through the protocol router', async () => {
  const calls = []
  const connection = resolveLlmConnection('openai', credentials)
  const result = await requestLlmText({
    ...connection,
    model: 'gpt-6-luna',
    prompt: 'Review this diff',
    fetcher: async (url, init) => {
      calls.push({url, init})
      return response({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{type: 'output_text', text: '{"ok":true}'}]
          }
        ]
      })
    }
  })
  assert.equal(result, '{"ok":true}')
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(calls[0].init.headers.authorization, 'Bearer openai-secret')
  assert.equal(calls[0].init.redirect, 'error')
})

test('OpenAI Chat Completions sends standard messages, bounded output and parses completion text', async () => {
  const calls = []
  const connection = resolveLlmConnection('freemodel', credentials)
  const result = await requestLlmText({
    ...connection,
    model: 'claude-opus-4.8',
    prompt: 'Review this diff',
    systemMessage: 'Return JSON only',
    maxOutputTokens: 2048,
    fetcher: async (url, init) => {
      calls.push({url, init})
      return response({
        choices: [{finish_reason: 'stop', message: {content: '{"ok":true}'}}]
      })
    }
  })
  assert.equal(result, '{"ok":true}')
  assert.equal(calls[0].url, 'https://freemodel.in/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer freemodel-secret')
  assert.equal(calls[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'claude-opus-4.8',
    messages: [
      {role: 'system', content: 'Return JSON only'},
      {role: 'user', content: 'Review this diff'}
    ],
    max_tokens: 2048,
    stream: false
  })
})

test('OpenAI Chat Completions passes an explicitly selected reasoning effort', async () => {
  let sent
  const connection = resolveLlmConnection('freemodel', credentials)
  await requestLlmText({
    ...connection,
    model: 'reasoning-model',
    prompt: 'Review this diff',
    reasoningEffort: 'low',
    fetcher: async (_url, init) => {
      sent = JSON.parse(init.body)
      return response({
        choices: [{finish_reason: 'stop', message: {content: '{}'}}]
      })
    }
  })
  assert.equal(sent.reasoning_effort, 'low')
})

test('OpenAI Chat Completions fails closed for truncation, tool-only and empty outputs', async () => {
  const connection = resolveLlmConnection('freemodel', credentials)
  for (const payload of [
    {choices: [{finish_reason: 'length', message: {content: 'partial'}}]},
    {choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{}]}}]},
    {choices: [{finish_reason: 'stop', message: {content: ''}}]}
  ]) {
    await assert.rejects(
      requestLlmText({
        ...connection,
        model: 'model-id',
        prompt: 'review',
        retries: 0,
        fetcher: async () => response(payload)
      }),
      /output|incomplete|token|finish|text|empty/i
    )
  }
})

test('Anthropic Messages uses native path, required headers, request shape and end_turn response', async () => {
  const calls = []
  const connection = resolveLlmConnection('anthropic', credentials)
  const result = await requestLlmText({
    ...connection,
    model: 'claude-opus-5-5',
    prompt: 'Review this diff',
    systemMessage: 'Return JSON only',
    maxOutputTokens: 1024,
    fetcher: async (url, init) => {
      calls.push({url, init})
      return response({
        stop_reason: 'end_turn',
        content: [
          {type: 'text', text: '{"ok":'},
          {type: 'text', text: 'true}'}
        ]
      })
    }
  })
  assert.equal(result, '{"ok":true}')
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(calls[0].init.headers['x-api-key'], 'anthropic-secret')
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01')
  assert.equal(calls[0].init.headers.authorization, undefined)
  assert.equal(calls[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'claude-opus-5-5',
    system: 'Return JSON only',
    messages: [{role: 'user', content: 'Review this diff'}],
    max_tokens: 1024
  })
})

test('Anthropic truncation, tool-use and refusal responses never become review text', async () => {
  const connection = resolveLlmConnection('anthropic', credentials)
  for (const stop_reason of [
    'max_tokens',
    'tool_use',
    'refusal',
    'model_context_window_exceeded'
  ]) {
    await assert.rejects(
      requestLlmText({
        ...connection,
        model: 'claude-opus-5-5',
        prompt: 'review',
        retries: 0,
        fetcher: async () =>
          response({stop_reason, content: [{type: 'text', text: 'partial'}]})
      }),
      /output|incomplete|refusal|token|stopped|finish|text/i
    )
  }
})

test('Gemini generateContent uses native model route, API-key header and response shape', async () => {
  const calls = []
  const connection = resolveLlmConnection('gemini', credentials)
  const result = await requestLlmText({
    ...connection,
    model: 'gemini-3.5-flash',
    prompt: 'Review this diff',
    systemMessage: 'Return JSON only',
    maxOutputTokens: 1024,
    fetcher: async (url, init) => {
      calls.push({url, init})
      return response({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {text: 'private reasoning', thought: true},
                {text: '{"ok":true}'}
              ]
            }
          }
        ]
      })
    }
  })
  assert.equal(result, '{"ok":true}')
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
  )
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gemini-secret')
  assert.equal(calls[0].init.headers.authorization, undefined)
  assert.equal(calls[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    systemInstruction: {parts: [{text: 'Return JSON only'}]},
    contents: [{role: 'user', parts: [{text: 'Review this diff'}]}],
    generationConfig: {maxOutputTokens: 1024}
  })
})

test('Gemini blocked, truncated and empty candidates fail closed', async () => {
  const connection = resolveLlmConnection('gemini', credentials)
  for (const payload of [
    {
      candidates: [
        {finishReason: 'MAX_TOKENS', content: {parts: [{text: 'partial'}]}}
      ]
    },
    {candidates: [{finishReason: 'SAFETY', content: {parts: []}}]},
    {candidates: []}
  ]) {
    await assert.rejects(
      requestLlmText({
        ...connection,
        model: 'gemini-test',
        prompt: 'review',
        retries: 0,
        fetcher: async () => response(payload)
      }),
      /output|incomplete|blocked|token|candidate/i
    )
  }
})

test('provider errors, unsafe URLs and missing keys are handled without leaking data', async () => {
  const connection = resolveLlmConnection('freemodel', credentials)
  await assert.rejects(
    requestLlmText({
      ...connection,
      apiBaseUrl: 'http://attacker.example/v1',
      model: 'model-id',
      prompt: 'review',
      fetcher: async () => {
        throw new Error('freemodel-secret leaked')
      }
    }),
    /https|unsafe/i
  )
  let requests = 0
  await assert.rejects(
    requestLlmText({
      ...connection,
      apiKey: '',
      model: 'model-id',
      prompt: 'review',
      fetcher: async () => {
        requests++
        return response({})
      }
    }),
    /credential|key/i
  )
  assert.equal(requests, 0)
  await assert.rejects(
    requestLlmText({
      ...connection,
      model: 'model-id',
      prompt: 'review',
      retries: 0,
      fetcher: async () => ({
        ok: false,
        status: 429,
        json: async () => ({error: 'private upstream body'})
      })
    }),
    error => {
      assert.match(error.message, /HTTP 429/)
      assert.doesNotMatch(
        error.message,
        /private upstream body|freemodel-secret/
      )
      return true
    }
  )
})

test('non-Responses protocol output size is capped before review parsing', async () => {
  const connection = resolveLlmConnection('freemodel', credentials)
  await assert.rejects(
    requestLlmText({
      ...connection,
      model: 'model-id',
      prompt: 'review',
      retries: 0,
      fetcher: async () =>
        response({
          choices: [
            {finish_reason: 'stop', message: {content: 'x'.repeat(262145)}}
          ]
        })
    }),
    /size limit/i
  )
})
