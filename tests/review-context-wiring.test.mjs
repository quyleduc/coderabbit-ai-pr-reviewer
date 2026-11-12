import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {processStructuredReview} from '../src/review-protocol.ts'

const reviewSource = readFileSync(
  new URL('../src/review.ts', import.meta.url),
  'utf8'
)
const mainSource = readFileSync(
  new URL('../src/main.ts', import.meta.url),
  'utf8'
)
const contextApi = import('../src/review-context.ts').catch(() => null)

async function getContextApi() {
  const api = await contextApi
  assert.ok(api, 'review-context module should load')
  assert.equal(typeof api.retrieveReviewContext, 'function')
  assert.equal(typeof api.formatReviewContextForPrompt, 'function')
  assert.equal(typeof api.summarizeReviewContextStatus, 'function')
  return api
}

function request() {
  return {
    repositoryId: 'owner/repo',
    pullRequestNumber: 21,
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    changedFile: 'src/entry.c',
    hunks: [
      {startLine: 10, endLine: 10, patch: '@@ -9 +10 @@\n-old();\n+new();'}
    ]
  }
}

test('retrieves context only after the PR scope and file hunk index have been validated', () => {
  const shaValidation = reviewSource.indexOf(
    'currentPR.data.head.sha !== context.payload.pull_request.head.sha'
  )
  const hunkValidation = reviewSource.search(
    /const hunkRangesMatch =\s*changedLineIndex\.valid/
  )
  const retrieve = reviewSource.indexOf(
    'await retrieveReviewContext(contextProvider',
    hunkValidation
  )
  const tokenCount = reviewSource.indexOf(
    'getTokenCount(prompts.renderReviewFileDiff(ins))',
    hunkValidation
  )

  assert.ok(shaValidation >= 0)
  assert.ok(hunkValidation > shaValidation)
  assert.ok(retrieve > hunkValidation)
  assert.ok(tokenCount > retrieve)
  assert.match(
    reviewSource,
    /repositoryId: `\$\{repo\.owner\}\/\$\{repo\.repo\}`/
  )
  assert.match(
    reviewSource,
    /baseSha: context\.payload\.pull_request!?\.base\.sha/
  )
  assert.match(
    reviewSource,
    /headSha: context\.payload\.pull_request!?\.head\.sha/
  )
  assert.match(reviewSource, /changedFile: filename/)
  assert.match(reviewSource, /hunks: patches\.map\(/)
})

test('formatted context is included in the prompt before request counting and model invocation', () => {
  const retrieval = reviewSource.indexOf(
    'await retrieveReviewContext(contextProvider'
  )
  const renderedContext = reviewSource.indexOf(
    'ins.reviewContext = formatReviewContextForPrompt(',
    retrieval
  )
  const tokenCount = reviewSource.indexOf(
    'getTokenCount(prompts.renderReviewFileDiff(ins))',
    renderedContext
  )
  const modelCall = reviewSource.indexOf('await heavyBot.chat(', tokenCount)

  assert.ok(retrieval >= 0)
  assert.ok(renderedContext > retrieval)
  assert.ok(tokenCount > renderedContext)
  assert.ok(modelCall > tokenCount)
  assert.match(reviewSource, /summarizeReviewContextStatus\(contextResults\)/)
})

test('missing providers and provider errors produce explicit hunk-only prompt status', async () => {
  const {
    retrieveReviewContext,
    formatReviewContextForPrompt,
    summarizeReviewContextStatus
  } = await getContextApi()
  const unavailable = await retrieveReviewContext(undefined, request())
  const unavailablePrompt = formatReviewContextForPrompt(unavailable)
  assert.match(unavailablePrompt, /hunk-only/i)
  assert.match(unavailablePrompt, /provider_unavailable/)
  assert.match(
    summarizeReviewContextStatus([unavailable]),
    /provider_unavailable: 1/
  )

  const failed = await retrieveReviewContext(
    {
      variantId: 'gcc-arm-v1',
      collectCandidates: async () => {
        throw new Error('private provider payload')
      }
    },
    request()
  )
  const failedPrompt = formatReviewContextForPrompt(failed)
  assert.match(failedPrompt, /hunk-only/i)
  assert.match(failedPrompt, /provider_error/)
  assert.doesNotMatch(failedPrompt, /private provider payload/)
  assert.match(summarizeReviewContextStatus([failed]), /provider_error: 1/)

  const candidate = {
    headSha: request().headSha,
    blobSha: 'c'.repeat(40),
    path: 'src/callee.c',
    startLine: 40,
    endLine: 41,
    symbolId: 'symbol:callee',
    relation: 'CALLS',
    variantId: 'gcc-arm-v1',
    status: 'SUPPORTED',
    graphDistance: 1,
    provenance: 'fixture:fact-17',
    excerpt: 'int callee(void) {\n  return 1;}'
  }
  const available = await retrieveReviewContext(
    {
      variantId: 'gcc-arm-v1',
      collectCandidates: async () => [candidate]
    },
    request()
  )
  assert.match(
    summarizeReviewContextStatus([available, unavailable]),
    /1 snippets in 1 file\(s\), \d+ bytes and \d+ estimated tokens; hunk-only for 1 file\(s\).*provider_unavailable: 1/
  )
})

test('the ordinary Action entry point continues to run without a production ECA provider', () => {
  assert.match(mainSource, /codeReview\(lightBot, heavyBot, options, prompts\)/)
  assert.doesNotMatch(mainSource, /ECA|contextProvider|ReviewContextProvider/)
})

test('context-only source lines still cannot pass the original changed-line validator', () => {
  const diff = '@@ -1 +1 @@\n-old();\n+new();\n'
  const changed = buildChangedLineIndex(diff)
  const response = JSON.stringify({
    version: 1,
    hunks: [
      {
        id: 'h0',
        status: 'issues',
        findings: [
          {
            line: 40,
            rule_id: 'NULL_DEREF',
            severity: 'high',
            message: 'This reference context line is unsafe.',
            evidence: 'callee();'
          }
        ]
      }
    ]
  })

  assert.throws(
    () => processStructuredReview(response, changed, diff, 1),
    /added line|hunk/i
  )
  assert.match(
    reviewSource,
    /processStructuredReview\(\s*response,\s*changedLineIndex,\s*fileDiff,\s*patchesPacked\s*\)/
  )
})
