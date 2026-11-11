import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const bot = readFileSync(new URL('../src/bot.ts', import.meta.url), 'utf8')
const review = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../.github/workflows/openai-review.yml', import.meta.url), 'utf8')
const options = readFileSync(new URL('../src/options.ts', import.meta.url), 'utf8')

test('do not log raw LLM responses into GitHub Actions logs', () => {
  assert.doesNotMatch(bot, /info\(\x60response:.*JSON\.stringify\(response\)/)
  assert.doesNotMatch(bot, /openai responses:.*responseText/)
})

test('do not log source-containing prompts even when debugging', () => {
  assert.doesNotMatch(review, /prompt so far:/)
})

test('do not let the external ChatGPT client log raw prompts and replies', () => {
  assert.match(bot, /debug:\s*false/)
})

test('privileged review workflow does not enable verbose model tracing by default', () => {
  assert.match(workflow, /debug:\s*false/)
  assert.doesNotMatch(workflow, /debug:\s*true/)
})

test('options diagnostics avoid printing arbitrary user-provided prompt text', () => {
  assert.doesNotMatch(options, /system_message:\s*\$\{this\.systemMessage\}/)
})
