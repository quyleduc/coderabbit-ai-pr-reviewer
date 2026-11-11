import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolveLlmConnection} from '../src/llm-provider.ts'
import {requestResponsesText} from '../src/responses-client.ts'
import {requestModelResponse} from '../scripts/controlled-model-eval.mjs'

const env = {
  OPENAI_API_KEY: 'test-openai-only-secret',
  OPENROUTER_API_KEY: 'test-openrouter-only-secret',
  OPENAI_API_ORG: 'org-test'
}
const done = {status: 'completed', output: [
  {type: 'message', content: [{type: 'output_text', text: 'verified'}]}
]}

test('default OpenAI selection is backwards-compatible and isolates provider credentials', () => {
  const selected = resolveLlmConnection('openai', env)
  assert.deepEqual(selected, {
    apiKey: env.OPENAI_API_KEY,
    apiBaseUrl: 'https://api.openai.com/v1',
    apiOrg: env.OPENAI_API_ORG
  })
  assert.ok(!JSON.stringify(selected).includes(env.OPENROUTER_API_KEY))
})

test('OpenRouter selection pins the official Responses URL and never forwards OpenAI credentials or org', () => {
  const selected = resolveLlmConnection('openrouter', env)
  assert.deepEqual(selected, {
    apiKey: env.OPENROUTER_API_KEY,
    apiBaseUrl: 'https://openrouter.ai/api/v1'
  })
  assert.ok(!JSON.stringify(selected).includes(env.OPENAI_API_KEY))
  assert.ok(!JSON.stringify(selected).includes(env.OPENAI_API_ORG))
})

test('wrong or missing provider credentials, unknown provider and custom OpenRouter endpoint fail closed', () => {
  for (const [provider, credentials, url] of [
    ['openrouter', {OPENAI_API_KEY: env.OPENAI_API_KEY}, undefined],
    ['openai', {OPENROUTER_API_KEY: env.OPENROUTER_API_KEY}, undefined],
    ['openrouter', {...env, OPENROUTER_API_KEY: '  '}, undefined],
    ['unknown', env, undefined],
    ['OpenRouter', env, undefined],
    ['openrouter', env, 'https://untrusted.example/v1']
  ]) {
    assert.throws(
      () => resolveLlmConnection(provider, credentials, url),
      /provider|credential|base url|endpoint|key/i
    )
  }
})

test('OpenRouter model slug passes the shared Responses transport without leaking keys', async () => {
  const calls = []
  const connection = resolveLlmConnection('openrouter', env)
  const result = await requestResponsesText({
    ...connection, model: 'anthropic/claude-sonnet-4.6', prompt: 'Review C patch',
    fetcher: async (url, init) => {
      calls.push({url, init})
      return {ok: true, status: 200, json: async () => done}
    }
  })
  assert.equal(result, 'verified')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/responses')
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + env.OPENROUTER_API_KEY)
  assert.equal(calls[0].init.headers['openai-organization'], undefined)
  assert.equal(JSON.parse(calls[0].init.body).store, false)
  assert.equal(JSON.parse(calls[0].init.body).model, 'anthropic/claude-sonnet-4.6')
  assert.ok(!JSON.stringify(calls).includes(env.OPENAI_API_KEY))
})


test('controlled model evaluator uses the same fixed OpenRouter endpoint and selected credential', async () => {
  const calls = []
  const result = await requestModelResponse({
    provider: 'openrouter',
    apiKey: env.OPENROUTER_API_KEY,
    model: 'anthropic/claude-sonnet-4.6',
    prompt: 'Return source-backed JSON review',
    fetcher: async (url, init) => {
      calls.push({url, init})
      return {ok: true, status: 200, json: async () => done}
    }
  })
  assert.equal(result, 'verified')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/responses')
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + env.OPENROUTER_API_KEY)
  assert.equal(calls[0].init.headers['openai-organization'], undefined)
  assert.ok(!JSON.stringify(calls).includes(env.OPENAI_API_KEY))
})

test('invalid slash-model identifiers fail before network access', async () => {
  let calls = 0
  for (const model of ['/claude', 'anthropic/', 'anthropic//model', 'anthropic/model with spaces']) {
    await assert.rejects(requestResponsesText({
      apiKey: env.OPENROUTER_API_KEY, model, prompt: 'test',
      fetcher: async () => { calls++; throw new Error('must not send') }
    }), /model/i)
  }
  assert.equal(calls, 0)
})

test('action, production bot and trusted workflows explicitly wire OpenRouter and retain opt-in gate', () => {
  const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  assert.match(read('action.yml'), /llm_provider:/)
  assert.match(read('src/main.ts'), /getInput\('llm_provider'\)/)
  assert.match(read('src/bot.ts'), /resolveLlmConnection\(/)
  assert.match(read('.github/workflows/openai-review.yml'), /OPENROUTER_API_KEY/)
  assert.match(read('.github/workflows/openai-review.yml'), /vars.LLM_PROVIDER == 'openrouter' && secrets.OPENROUTER_API_KEY/)
  assert.match(read('.github/workflows/openai-review.yml'), /vars.LLM_PROVIDER != 'openrouter' && secrets.OPENAI_API_KEY/)
  assert.match(read('.github/workflows/openai-review.yml'), /ENABLE_AUTOMATED_PR_REVIEWS == 'true'/)
  assert.match(read('.github/workflows/controlled-live-eval.yml'), /OPENROUTER_API_KEY/)
  assert.match(read('.github/workflows/controlled-live-pr-acceptance.yml'), /OPENROUTER_API_KEY/)
  assert.match(read('scripts/controlled-model-eval.mjs'), /LLM_PROVIDER/)
  assert.match(read('scripts/live-pr-acceptance.mjs'), /LLM_PROVIDER/)
})
