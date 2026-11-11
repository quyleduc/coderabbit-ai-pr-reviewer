import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const bot = readFileSync(new URL('../src/bot.ts', import.meta.url), 'utf8')
const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const workflow = () => readFileSync(new URL('../.github/workflows/controlled-live-eval.yml', import.meta.url), 'utf8')

test('production Bot.chat never acknowledges a model error with empty fake success', () => {
  assert.doesNotMatch(bot, /catch \(e: unknown\) \{\s*if \(e instanceof ChatGPTError\)[\s\S]*?return res/)
  assert.match(bot, /throw new Error\('OpenAI request failed after configured retries'\)/)
  assert.match(bot, /throw new Error\('OpenAI model returned an empty response'\)/)
})

test('production summary and summary context must not silently succeed when model output absent', () => {
  assert.match(review, /if \(summarizeFinalResponse === ''\) \{\s*throw new Error/)
  assert.match(review, /if \(summarizeShortResponse === ''\) \{\s*throw new Error/)
  assert.match(review, /if \(summarizeResp === ''\) \{\s*throw new Error\('Missing consolidated summary/)
})

test('live eval workflow is manual, main-only, read-only and never executes PR-head with secrets', () => {
  const yml = workflow()
  assert.match(yml, /workflow_dispatch:/)
  assert.doesNotMatch(yml, /pull_request_target:|pull_request:\s*$/m)
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/)
  assert.match(yml, /repository\.default_branch/)
  assert.match(yml, /persist-credentials: false/)
  assert.match(yml, /contents: read/)
  assert.doesNotMatch(yml, /pull-requests: write/)
  assert.match(yml, /OPENAI_API_KEY:/)
  assert.match(yml, /--live/)
})

test('read-only CI never gives secrets to PR-head mock evaluator', () => {
  const yml = readFileSync(new URL('../.github/workflows/core-regression.yml', import.meta.url), 'utf8')
  assert.match(yml, /controlled-model-eval\.mjs --mock/)
  assert.doesNotMatch(yml, /OPENAI_API_KEY/)
})
