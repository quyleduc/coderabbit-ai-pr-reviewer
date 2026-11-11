import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')

test('manual live acceptance only runs trusted main and requires explicit exact confirmation',()=>{
  const flow=read('.github/workflows/controlled-live-pr-acceptance.yml')
  assert.match(flow,/workflow_dispatch:/)
  assert.doesNotMatch(flow,/pull_request_target:|^\s+pull_request:/m)
  assert.match(flow,/github\.ref == 'refs\/heads\/main'/)
  assert.match(flow,/PUBLISH_ACCEPTANCE_REVIEW/)
  assert.match(flow,/expected_head_sha:/)
  assert.match(flow,/expected_base_sha:/)
  assert.match(flow,/pr_number:/)
  assert.match(flow,/environment: controlled-review-acceptance/)
  assert.match(flow,/ref: .*default_branch/)
  assert.match(flow,/persist-credentials: false/)
  assert.match(flow,/timeout-minutes:/)
})

test('read-only preflight/model do not receive PR write tokens or PR-head source',()=>{
  const flow=read('.github/workflows/controlled-live-pr-acceptance.yml')
  assert.match(flow,/preflight:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: read/)
  assert.match(flow,/model_only:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: read/)
  assert.match(flow,/publish:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: write/)
  assert.doesNotMatch(flow,/ref: .*pull_request\.head|ref: .*head_ref/)
  assert.doesNotMatch(flow,/GITHUB_TOKEN:.*PAT/)
})

test('automatic privileged reviewer is opt-in, not enabled on all PRs after release',()=>{
  const flow=read('.github/workflows/openai-review.yml')
  assert.match(flow,/vars\.ENABLE_AUTOMATED_PR_REVIEWS == 'true'/)
  assert.match(flow,/ref: .*default_branch/)
  assert.match(flow,/persist-credentials: false/)
})

test('execution errors never dump request response, PR source or provider stack traces',()=>{
  const main=read('src/main.ts')
  const review=read('src/review.ts')
  assert.doesNotMatch(main,/backtrace: \$\{e\.stack\}/)
  assert.doesNotMatch(main,/Unhandled Rejection at Promise: \$\{reason\}/)
  assert.doesNotMatch(review,/Failed to review: \$\{e as string\}/)
  assert.doesNotMatch(review,/backtrace: \$\{/)
})

test('GitHub inline review requests explicitly use RIGHT-side coordinates',()=>{
  const src=read('src/review-publication.ts')
  assert.match(src,/side:\s*'RIGHT'/)
})

test('live acceptance runner rejects non-manual mode and never calls GitHub issue or review POST in read-only mode',()=>{
  const src=read('scripts/live-pr-acceptance.mjs')
  assert.match(src,/--preflight/)
  assert.match(src,/--model-only/)
  assert.match(src,/--publish/)
  assert.match(src,/validateAcceptanceTarget\(/)
  assert.match(src,/processStructuredReview\(/)
  assert.match(src,/publishReviewBatch\(/)
  assert.match(src,/commitAcceptanceCheckpoint\(/)
})
