import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {TokenLimits} from '../src/limits.ts'

const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../.github/workflows/openai-review.yml', import.meta.url), 'utf8')
const options = readFileSync(new URL('../src/options.ts', import.meta.url), 'utf8')

test('new Responses defaults use supported current API models, not retired legacy GPT-3.5/4', () => {
  assert.match(action, /openai_light_model:[\s\S]*?default: 'gpt-6-luna'/)
  assert.match(action, /openai_heavy_model:[\s\S]*?default: 'gpt-6\.1-sol'/)
  assert.match(workflow, /openai_light_model: gpt-6-luna/)
  assert.match(workflow, /openai_heavy_model: gpt-6\.1-sol/)
  assert.doesNotMatch(workflow, /openai_heavy_model: gpt-4\b/)
})

test('model token budgets cover both summary and JSON review output conservatively', () => {
  const light = new TokenLimits('gpt-6-luna')
  const heavy = new TokenLimits('gpt-6.1-sol')
  assert.ok(light.responseTokens >= 3000)
  assert.ok(heavy.responseTokens >= 5000)
  assert.ok(heavy.requestTokens >= 7000)
  assert.ok(light.requestTokens >= 5000)
  assert.ok(light.maxTokens >= light.responseTokens + light.requestTokens)
  assert.ok(heavy.maxTokens >= heavy.responseTokens + heavy.requestTokens)
})

test('legacy temperature is clearly labelled ignored by Responses transport', () => {
  assert.match(action, /openai_model_temperature:[\s\S]*?Ignored by Responses API adapter/)
  assert.match(options, /openai_model_temperature: ignored by Responses transport/)
})
