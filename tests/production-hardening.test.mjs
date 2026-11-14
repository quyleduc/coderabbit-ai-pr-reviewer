import assert from 'node:assert/strict'
import {register} from 'node:module'
import test from 'node:test'

register(
  `data:text/javascript,${encodeURIComponent(`
    import {existsSync} from 'node:fs'
    import {fileURLToPath} from 'node:url'
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        try {
          return await nextResolve(specifier, context)
        } catch (err) {
          if (err.code === 'ERR_MODULE_NOT_FOUND' && !/\\.[a-z]+$/i.test(specifier)) {
            const candidate = specifier + '.ts'
            const resolvedUrl = new URL(candidate, context.parentURL)
            if (existsSync(fileURLToPath(resolvedUrl))) {
              return nextResolve(candidate, context)
            }
          }
          throw err
        }
      }
      return nextResolve(specifier, context)
    }
  `)}`
)

import {parsePatch, buildChangedLineIndex} from '../src/diff-hunks.ts'
import {Inputs} from '../src/inputs.ts'
import {requestLlmText} from '../src/llm-adapters.ts'
import {resolveLlmConnection} from '../src/llm-provider.ts'
import {requestResponsesText} from '../src/responses-client.ts'
import {retrieveReviewContext} from '../src/review-context.ts'
import {
  planReviewPublication
} from '../src/review-dedup.ts'
import {processStructuredReview} from '../src/review-protocol.ts'
import {classifyShadowFailure} from '../src/shadow-errors.ts'

process.env.GITHUB_REPOSITORY ??= 'owner/repo'
process.env.GITHUB_TOKEN ??= 'test-token'
process.env.GITHUB_ACTION ??= 'test-action'

const {context: githubContext} = await import('@actions/github')
const {Commenter, COMMENT_GREETING, COMMENT_TAG} = await import('../src/commenter.ts')
const {octokit} = await import('../src/octokit.ts')

const noopDelay = async () => {}

// 1. Inputs.render
test('Inputs.render preserves $&, $\', $1 and multiple $diff/$patches occurrences verbatim', () => {
  const inputs = new Inputs()
  inputs.diff = "diff --git a/x b/x\n+$& $' $1 $$"
  inputs.patches = "@@ -1 +1 @@\n+$& $' $1"

  const rendered = inputs.render(
    'A:\n$diff\nB:\n$diff\nP1:\n$patches\nP2:\n$patches'
  )

  assert.equal(
    rendered,
    `A:\n${inputs.diff}\nB:\n${inputs.diff}\nP1:\n${inputs.patches}\nP2:\n${inputs.patches}`
  )
})

// 2. parsePatch CRLF
test('parsePatch strips CR from CRLF diffs without leaving trailing \\r', () => {
  const crlfPatch = [
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-old2',
    '+new2',
    ' line3',
    ''
  ].join('\r\n')

  const parsed = parsePatch(crlfPatch)
  assert.ok(parsed !== null)
  assert.equal(parsed.oldHunk.includes('\r'), false)
  assert.equal(parsed.newHunk.includes('\r'), false)
  assert.equal(parsed.oldHunk, ' line1\nold2\n line3')
  assert.equal(parsed.newHunk, ' line1\n2: new2\n line3')
})

// 3. retrieveReviewContext
test('retrieveReviewContext handles AbortError after signal.aborted without unhandled rejection and returns provider_timeout', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)

  try {
    const provider = {
      variantId: 'test-variant',
      collectCandidates(_req, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            },
            {once: true}
          )
        })
      }
    }

    const res = await retrieveReviewContext(
      provider,
      {
        repositoryId: 'owner/repo',
        pullRequestNumber: 1,
        baseSha: '0'.repeat(40),
        headSha: 'a'.repeat(40),
        changedFile: 'src/a.ts',
        hunks: [{startLine: 1, endLine: 2, patch: '@@ -1,1 +1,2 @@\n+x'}]
      },
      {timeoutMs: 15}
    )

    // Allow microtasks from abort listener rejection to settle
    await new Promise(resolve => setTimeout(resolve, 25))

    assert.equal(res.status, 'unavailable')
    assert.deepEqual(res.reasonCodes, ['provider_timeout'])
    assert.equal(unhandled.length, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('retrieveReviewContext maxFiles cap uses continue so later candidates from already-included files are still packed', async () => {
  const sha = 'b'.repeat(40)
  const blobSha = 'c'.repeat(40)
  const provider = {
    variantId: 'v1',
    async collectCandidates() {
      return [
        {
          headSha: sha,
          blobSha,
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          symbolId: 'sym-a1',
          relation: 'CALLS',
          variantId: 'v1',
          status: 'SUPPORTED',
          graphDistance: 1,
          provenance: 'test',
          excerpt: 'first from a'
        },
        {
          headSha: sha,
          blobSha,
          path: 'src/b.ts',
          startLine: 1,
          endLine: 1,
          symbolId: 'sym-b1',
          relation: 'CALLS',
          variantId: 'v1',
          status: 'SUPPORTED',
          graphDistance: 1,
          provenance: 'test',
          excerpt: 'skipped from b'
        },
        {
          headSha: sha,
          blobSha,
          path: 'src/a.ts',
          startLine: 5,
          endLine: 5,
          symbolId: 'sym-a2',
          relation: 'CALLS',
          variantId: 'v1',
          status: 'SUPPORTED',
          graphDistance: 1,
          provenance: 'test',
          excerpt: 'second from a'
        }
      ]
    }
  }

  const res = await retrieveReviewContext(
    provider,
    {
      repositoryId: 'owner/repo',
      pullRequestNumber: 1,
      baseSha: '0'.repeat(40),
      headSha: sha,
      changedFile: 'src/a.ts',
      hunks: [{startLine: 1, endLine: 10, patch: '@@ -1,1 +1,2 @@\n+x'}]
    },
    {maxFiles: 1, maxSnippets: 5, maxBytes: 8192, maxTokens: 2048, timeoutMs: 1000}
  )

  assert.equal(res.status, 'available')
  assert.deepEqual(
    res.snippets.map(s => s.symbolId),
    ['sym-a1', 'sym-a2']
  )
  assert.deepEqual(res.reasonCodes, ['max_files'])
})

// 4. Commenter
test('Commenter.getCommentsWithinRange and getCommentsAtRange match single-line comments with start_line: null', async () => {
  const origListReviewComments = octokit.pulls.listReviewComments
  try {
    octokit.pulls.listReviewComments = async () => ({
      data: [
        {
          id: 1,
          path: 'src/foo.ts',
          line: 42,
          start_line: null,
          body: 'Single line finding'
        },
        {
          id: 2,
          path: 'src/foo.ts',
          line: 99,
          start_line: null,
          body: 'Out of range'
        }
      ]
    })

    const commenter = new Commenter()
    const within = await commenter.getCommentsWithinRange(10, 'src/foo.ts', 40, 45)
    assert.deepEqual(within.map(c => c.id), [1])

    const atExact = await commenter.getCommentsAtRange(10, 'src/foo.ts', 42, 42)
    assert.deepEqual(atExact.map(c => c.id), [1])
  } finally {
    octokit.pulls.listReviewComments = origListReviewComments
  }
})

test('Commenter configurable botLogin works for publishedBotCommentBodies and findCommentWithTag', async () => {
  const origListReviewComments = octokit.pulls.listReviewComments
  const origListComments = octokit.issues.listComments
  const origCreateReview = octokit.pulls.createReview
  const origSubmitReview = octokit.pulls.submitReview
  const origDeletePendingReview = octokit.pulls.deletePendingReview

  try {
    const customLogin = 'custom-reviewer[bot]'
    const rawMessage = 'Check null pointer'
    const candidate = {
      path: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      message: `${COMMENT_GREETING}\n\n${rawMessage}\n\n${COMMENT_TAG}`
    }
    const publishedBody = planReviewPublication([candidate], []).pending[0].message

    octokit.pulls.listReviewComments = async () => ({
      data: [
        {
          id: 101,
          user: {login: customLogin},
          body: publishedBody
        }
      ]
    })

    let createReviewCalls = 0
    octokit.pulls.createReview = async () => {
      createReviewCalls++
      return {data: {id: 1}}
    }
    octokit.pulls.submitReview = async () => ({data: {}})
    octokit.pulls.deletePendingReview = async () => ({data: {}})

    // Custom botLogin recognizes its own published comment and suppresses duplicate
    const customCommenter = new Commenter(customLogin)
    await customCommenter.bufferReviewComment(
      candidate.path,
      candidate.startLine,
      candidate.endLine,
      rawMessage
    )
    const ok = await customCommenter.submitReview(55, 'deadbeef', 'Review done')
    assert.equal(ok, true)
    assert.equal(createReviewCalls, 0)

    // Default botLogin ('github-actions[bot]') does NOT trust customLogin's comment
    const defaultCommenter = new Commenter()
    await defaultCommenter.bufferReviewComment(
      candidate.path,
      candidate.startLine,
      candidate.endLine,
      rawMessage
    )
    const defaultOk = await defaultCommenter.submitReview(55, 'deadbeef', 'Review done')
    assert.equal(defaultOk, true)
    assert.equal(createReviewCalls, 1)

    // findCommentWithTag respects custom botLogin
    const tag = '<!-- custom-tag -->'
    octokit.issues.listComments = async () => ({
      data: [
        {
          id: 201,
          user: {login: customLogin},
          body: `hello ${tag}`
        }
      ]
    })

    const foundCustom = await new Commenter(customLogin).findCommentWithTag(tag, 55)
    assert.equal(foundCustom?.id, 201)

    const foundDefault = await new Commenter().findCommentWithTag(tag, 55)
    assert.equal(foundDefault, null)
  } finally {
    octokit.pulls.listReviewComments = origListReviewComments
    octokit.issues.listComments = origListComments
    octokit.pulls.createReview = origCreateReview
    octokit.pulls.submitReview = origSubmitReview
    octokit.pulls.deletePendingReview = origDeletePendingReview
  }
})

test('Commenter.listReviewComments rethrows errors on page >= 2 instead of returning partial data', async () => {
  const origListReviewComments = octokit.pulls.listReviewComments
  try {
    octokit.pulls.listReviewComments = async ({page}) => {
      if (page === 1) {
        return {
          data: Array.from({length: 100}, (_, i) => ({id: i + 1}))
        }
      }
      throw new Error('GitHub API 502 on page 2')
    }

    const commenter = new Commenter()
    await assert.rejects(
      () => commenter.listReviewComments(77),
      /GitHub API 502 on page 2/
    )
  } finally {
    octokit.pulls.listReviewComments = origListReviewComments
  }
})

test('Commenter.getAllCommitIds stops when data.length < 100 without making an extra page request', async () => {
  const origListCommits = octokit.pulls.listCommits
  const origPr = githubContext.payload.pull_request
  try {
    githubContext.payload.pull_request = {number: 88}
    const requestedPages = []
    octokit.pulls.listCommits = async ({page}) => {
      requestedPages.push(page)
      return {
        data: [{sha: 'sha1'}, {sha: 'sha2'}]
      }
    }

    const commenter = new Commenter()
    const ids = await commenter.getAllCommitIds()
    assert.deepEqual(ids, ['sha1', 'sha2'])
    assert.deepEqual(requestedPages, [1])
  } finally {
    octokit.pulls.listCommits = origListCommits
    githubContext.payload.pull_request = origPr
  }
})

// 5. resolveLlmConnection & safeBaseUrl
test('resolveLlmConnection rejects non-default baseUrl overrides for openai, anthropic, gemini, openrouter and private/link-local IPs', () => {
  const env = {
    OPENAI_API_KEY: 'k1',
    ANTHROPIC_API_KEY: 'k2',
    GEMINI_API_KEY: 'k3',
    OPENROUTER_API_KEY: 'k4',
    LLM_API_KEY: 'k5'
  }

  for (const provider of ['openai', 'anthropic', 'gemini', 'openrouter']) {
    assert.throws(
      () => resolveLlmConnection(provider, env, 'https://custom.example.com/v1'),
      /fixed endpoint/i
    )
  }

  for (const badHost of [
    'https://169.254.169.254/v1',
    'https://10.0.0.1/v1',
    'https://192.168.1.1/v1',
    'https://[::ffff:127.0.0.1]/v1'
  ]) {
    assert.throws(
      () => resolveLlmConnection('openai-compatible', env, badHost),
      /Unsafe or invalid LLM API base URL/
    )
  }
})

// 6. processStructuredReview sanitization
test('processStructuredReview sanitizes HTML tags, external Markdown links/images, and @mentions in finding.message', () => {
  const diff = [
    '@@ -1,1 +1,2 @@',
    ' const a = 1',
    '+const b = eval(input)'
  ].join('\n')
  const changed = buildChangedLineIndex(diff)
  const payload = JSON.stringify({
    version: 1,
    hunks: [
      {
        id: 'h0',
        status: 'issues',
        findings: [
          {
            line: 2,
            rule_id: 'SEC_EVAL',
            severity: 'high',
            message:
              'Avoid <b>eval</b> <script>alert(1)</script> <!-- hidden --> see [docs](https://evil.example/x) ![img](https://evil.example/p.png) cc @octocat',
            evidence: 'const b = eval(input)'
          }
        ]
      }
    ]
  })

  const res = processStructuredReview(payload, changed, diff, 1)
  assert.equal(res.comments.length, 1)
  const msg = res.comments[0].message
  assert.equal(msg.includes('<'), false)
  assert.equal(msg.includes('https://'), false)
  assert.equal(msg.includes('@octocat'), false)
  assert.ok(msg.includes('eval'))
  assert.ok(msg.includes('docs'))
  assert.ok(msg.includes('octocat'))
})

// 7. llm-adapters.ts / responses-client.ts / shadow-errors.ts
test('AbortError during body read is retried while SyntaxError is not', async () => {
  let abortAttempts = 0
  const text = await requestResponsesText({
    apiKey: 'k',
    model: 'gpt-4.1-mini',
    prompt: 'Review',
    retries: 2,
    delay: noopDelay,
    fetcher: async () => {
      abortAttempts++
      if (abortAttempts === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => {
            const err = new Error('body read aborted')
            err.name = 'AbortError'
            throw err
          },
          json: async () => ({})
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'completed',
            output: [{type: 'message', content: [{type: 'output_text', text: 'ok'}]}]
          }),
        json: async () => ({})
      }
    }
  })
  assert.equal(text, 'ok')
  assert.equal(abortAttempts, 2)

  let syntaxAttempts = 0
  await assert.rejects(
    () =>
      requestResponsesText({
        apiKey: 'k',
        model: 'gpt-4.1-mini',
        prompt: 'Review',
        retries: 2,
        delay: noopDelay,
        fetcher: async () => {
          syntaxAttempts++
          return {
            ok: true,
            status: 200,
            text: async () => '{not-json',
            json: async () => {
              throw new SyntaxError('Unexpected token')
            }
          }
        }
      }),
    /Invalid OpenAI response JSON/
  )
  assert.equal(syntaxAttempts, 1)
})

test('Content-Length oversized body fails closed without reading body', async () => {
  let bodyReadCalled = false
  await assert.rejects(
    () =>
      requestResponsesText({
        apiKey: 'k',
        model: 'gpt-4.1-mini',
        prompt: 'Review',
        retries: 0,
        delay: noopDelay,
        fetcher: async () => ({
          ok: true,
          status: 200,
          headers: {get: name => (name.toLowerCase() === 'content-length' ? '9999999' : null)},
          text: async () => {
            bodyReadCalled = true
            return '{}'
          },
          json: async () => {
            bodyReadCalled = true
            return {}
          }
        })
      }),
    /OpenAI response exceeds size limit/
  )
  assert.equal(bodyReadCalled, false)
})

test('retryEmptyOutput retries once on empty output in requestLlmText', async () => {
  let calls = 0
  const result = await requestLlmText({
    apiKey: 'k',
    protocol: 'openai-chat-completions',
    apiBaseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    prompt: 'Review',
    retries: 2,
    retryEmptyOutput: true,
    delay: noopDelay,
    fetcher: async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: {content: calls === 1 ? '   ' : 'non-empty'}
            }
          ]
        })
      }
    }
  })
  assert.equal(result, 'non-empty')
  assert.equal(calls, 2)
})

test('200-char model IDs work in requestResponsesText', async () => {
  const model200 = 'm'.repeat(200)
  const text = await requestResponsesText({
    apiKey: 'k',
    model: model200,
    prompt: 'Review',
    retries: 0,
    delay: noopDelay,
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'completed',
        output: [{type: 'message', content: [{type: 'output_text', text: 'ok'}]}]
      })
    })
  })
  assert.equal(text, 'ok')
})

test('classifyShadowFailure maps OpenAI response errors, size limit, and hunk status/finding message errors', () => {
  const cases = [
    ['OpenAI response exceeded output token budget', 'provider_output_limit'],
    ['OpenAI response incomplete or unconfirmed', 'provider_incomplete_response'],
    ['OpenAI response contains reasoning but no final output text', 'provider_reasoning_only'],
    ['OpenAI response contains no output items', 'provider_empty_output'],
    ['OpenAI response contains no assistant message', 'provider_missing_message'],
    ['OpenAI response missing or empty', 'provider_empty_output'],
    ['Invalid OpenAI response JSON', 'provider_invalid_json_envelope'],
    ['OpenAI response exceeds size limit', 'provider_response_too_large'],
    ['LLM response exceeds size limit', 'provider_response_too_large'],
    ['Invalid hunk status', 'model_output_rejected'],
    ['Invalid finding message', 'model_output_rejected']
  ]

  for (const [message, expected] of cases) {
    assert.equal(classifyShadowFailure(new Error(message)), expected)
  }
})
