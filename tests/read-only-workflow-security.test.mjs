import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const workflow = readFileSync(
  new URL('../.github/workflows/read-only-pr-review-smoke.yml', import.meta.url),
  'utf8'
)
const script = readFileSync(
  new URL('../scripts/read-only-review-smoke.mjs', import.meta.url),
  'utf8'
)

test('smoke workflow uses pull_request instead of privileged pull_request_target', () => {
  assert.match(workflow, /^\s*pull_request:\s*$/m)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: read/)
  assert.doesNotMatch(workflow, /pull-requests: write/)
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/)
})

test('checkout never persists credentials for synthetic PR review', () => {
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /node-version: '22'/)
  assert.match(workflow, /read-only-review-smoke\.mjs/)
})

test('GitHub remote access in smoke CLI is limited to authenticated GET fetch', () => {
  assert.match(script, /const response = await fetch\(endpoint/)
  assert.doesNotMatch(script, /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/)
  assert.doesNotMatch(script, /octokit\.pulls\.(?:createReview|submitReview|update)/)
  assert.match(script, /realGitHubMutations:\s*0/)
})
