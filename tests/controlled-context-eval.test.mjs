import test from 'node:test'
import assert from 'node:assert/strict'
import {runContextComparison} from '../scripts/controlled-context-eval.mjs'

const finding = {line: 1, rule_id: 'NULL_DEREF'}
const response = {
  version: 1,
  hunks: [
    {
      id: 'h0',
      status: 'issues',
      findings: [
        {
          line: 1,
          rule_id: 'NULL_DEREF',
          severity: 'high',
          message: 'Possible null dereference.',
          evidence: 'return *ptr;'
        }
      ]
    }
  ]
}

function fixture(overrides = {}) {
  return {
    id: 'ptr',
    filename: 'src/entry.c',
    patch: '@@ -1 +1 @@\n-return 0;\n+return *ptr;\n',
    expected: [finding],
    mock_response: response,
    ...overrides
  }
}

test('offline comparison validates both arms and reports prompt cost without claiming model latency', async () => {
  const result = await runContextComparison(
    [fixture()],
    async ({fixture: input}) => JSON.stringify(input.mock_response)
  )
  assert.equal(result.mode, 'offline-fixture-comparison')
  assert.equal(result.modelCalls, 0)
  assert.equal(result.arms['hunk-only'].cases, 1)
  assert.equal(result.arms['hunk-plus-context'].cases, 1)
  assert.equal(result.arms['hunk-plus-context'].availableContextCases, 0)
  assert.ok(
    result.arms['hunk-plus-context'].promptTokens >=
      result.arms['hunk-only'].promptTokens
  )
  assert.equal(result.arms['hunk-only'].tp, 1)
  assert.equal(result.arms['hunk-plus-context'].tp, 1)
  assert.equal(
    result.latencyMeaning,
    'local prompt construction and protocol validation only; model inference not measured'
  )
})

test('fixture context uses bounded production retrieval and is included in context arm only', async () => {
  const observed = []
  const result = await runContextComparison(
    [
      fixture({
        contextCandidates: [
          {
            headSha: 'a'.repeat(40),
            blobSha: 'c'.repeat(40),
            path: 'src/pointer.c',
            startLine: 1,
            endLine: 1,
            symbolId: 'symbol:ptr',
            relation: 'READS',
            variantId: 'offline-fixture-v1',
            status: 'SUPPORTED',
            graphDistance: 1,
            provenance: 'fixture:ptr',
            excerpt: 'int is_valid(const void *ptr);'
          }
        ]
      })
    ],
    async ({arm, prompt, fixture: input}) => {
      observed.push({arm, prompt})
      return JSON.stringify(input.mock_response)
    }
  )
  assert.equal(result.arms['hunk-plus-context'].availableContextCases, 1)
  assert.ok(
    result.arms['hunk-plus-context'].promptTokens >
      result.arms['hunk-only'].promptTokens
  )
  assert.doesNotMatch(
    observed.find(x => x.arm === 'hunk-only').prompt,
    /## Cross-file context status/
  )
  assert.match(
    observed.find(x => x.arm === 'hunk-plus-context').prompt,
    /## Cross-file reference context/
  )
})
