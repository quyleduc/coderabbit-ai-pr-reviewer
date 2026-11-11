import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const workflow = readFileSync(new URL('../.github/workflows/openai-review.yml', import.meta.url), 'utf8')
const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8')

test('privileged PR review runs only trusted repository source', () => {
  assert.match(workflow, /pull_request_target:/)
  assert.match(workflow, /repository:\s*\$\{\{\s*github\.repository\s*\}\}/)
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/)
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(?:repo|ref|sha)/)
})

test('checkout does not persist GitHub token', () => {
  assert.match(workflow, /persist-credentials:\s*false/)
})

test('trusted source is rebuilt before executing the local action', () => {
  const checkout = workflow.indexOf('actions/checkout@v4')
  const build = workflow.indexOf('npm run package')
  const localAction = workflow.indexOf('uses: ./')
  assert.ok(checkout >= 0 && checkout < build && build < localAction)
})

test('JavaScript Action uses supported Node 20 runtime', () => {
  assert.match(action, /using:\s*'node20'/)
})
