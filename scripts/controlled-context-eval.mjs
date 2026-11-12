import {performance} from 'node:perf_hooks'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {
  formatReviewContextForPrompt,
  retrieveReviewContext
} from '../src/review-context.ts'
import {getTokenCount} from '../src/tokenizer-core.mjs'
import {processStructuredReview} from '../src/review-protocol.ts'
import {buildFixturePrompt, scoreFindings} from './controlled-model-eval.mjs'

const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const VARIANT_ID = 'offline-fixture-v1'

function makeContextRequest(fixture, index) {
  return {
    repositoryId: 'offline/fixture-suite',
    pullRequestNumber: 1,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    changedFile: fixture.filename || 'src/fixture.c',
    hunks: index.hunks.map(hunk => ({
      startLine: Math.max(1, hunk.startLine),
      endLine: Math.max(Math.max(1, hunk.startLine), hunk.endLine),
      patch: fixture.patch
    }))
  }
}

function emptyMetrics() {
  return {
    cases: 0,
    availableContextCases: 0,
    contextSnippets: 0,
    contextBytes: 0,
    contextTokens: 0,
    promptBytes: 0,
    promptTokens: 0,
    localProcessingMs: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    invalid: 0
  }
}

function finalize(metrics) {
  const precision =
    metrics.tp + metrics.fp === 0
      ? metrics.fn === 0
        ? 1
        : 0
      : metrics.tp / (metrics.tp + metrics.fp)
  const recall =
    metrics.tp + metrics.fn === 0 ? 1 : metrics.tp / (metrics.tp + metrics.fn)
  return {
    ...metrics,
    avgPromptBytes:
      metrics.cases === 0 ? 0 : metrics.promptBytes / metrics.cases,
    avgPromptTokens:
      metrics.cases === 0 ? 0 : metrics.promptTokens / metrics.cases,
    avgLocalProcessingMs:
      metrics.cases === 0 ? 0 : metrics.localProcessingMs / metrics.cases,
    precision,
    recall,
    f1:
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall)
  }
}

/**
 * Runs a paired, offline protocol comparison. `generate` must return a
 * deterministic fixture response; this runner never calls a model provider.
 * Fixture responses are intentionally shared by default, so they measure
 * prompt/retrieval overhead and validator compatibility, not context efficacy.
 */
export async function runContextComparison(fixtures, generate) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('Evaluation fixtures are missing')
  }
  if (typeof generate !== 'function')
    throw new TypeError('Fixture response function is required')

  const arms = {
    'hunk-only': emptyMetrics(),
    'hunk-plus-context': emptyMetrics()
  }
  const seenIds = new Set()
  for (const fixture of fixtures) {
    if (
      typeof fixture?.id !== 'string' ||
      !fixture.id.trim() ||
      seenIds.has(fixture.id)
    ) {
      throw new Error('Invalid or duplicate evaluation fixture id')
    }
    seenIds.add(fixture.id)
    if (!Array.isArray(fixture.expected))
      throw new Error('Fixture has no ground truth labels')
    const index = buildChangedLineIndex(fixture.patch)
    if (!index.valid) throw new Error('Invalid benchmark diff: ' + fixture.id)

    let context
    const retrievalStart = performance.now()
    if (Array.isArray(fixture.contextCandidates)) {
      const provider = {
        variantId: VARIANT_ID,
        collectCandidates: async () => fixture.contextCandidates
      }
      context = await retrieveReviewContext(
        provider,
        makeContextRequest(fixture, index)
      )
    } else {
      context = await retrieveReviewContext(
        undefined,
        makeContextRequest(fixture, index)
      )
    }
    const retrievalMs = performance.now() - retrievalStart

    for (const arm of ['hunk-only', 'hunk-plus-context']) {
      const metrics = arms[arm]
      const buildStart = performance.now()
      const contextText =
        arm === 'hunk-plus-context' ? formatReviewContextForPrompt(context) : ''
      const prompt = buildFixturePrompt(fixture, contextText)
      const promptBuildMs = performance.now() - buildStart
      const promptBytes = Buffer.byteLength(prompt, 'utf8')
      const promptTokens = getTokenCount(prompt)

      const validationStart = performance.now()
      const reply = await generate({fixture, arm, prompt})
      const verified = processStructuredReview(
        reply,
        index,
        fixture.patch,
        index.hunks.length
      )
      const validationMs = performance.now() - validationStart
      const predictions = verified.comments.map(comment => {
        const rule = /^\*\*(?:HIGH|MEDIUM|LOW) \/ ([A-Z][A-Z0-9_]+)\*\*/.exec(
          comment.message
        )
        if (!rule) throw new Error('Invalid normalized review finding')
        return {line: comment.startLine, rule_id: rule[1]}
      })
      const score = scoreFindings(predictions, fixture.expected)
      metrics.cases++
      metrics.promptBytes += promptBytes
      metrics.promptTokens += promptTokens
      metrics.localProcessingMs +=
        promptBuildMs +
        validationMs +
        (arm === 'hunk-plus-context' ? retrievalMs : 0)
      metrics.availableContextCases +=
        arm === 'hunk-plus-context' && context.status === 'available' ? 1 : 0
      if (arm === 'hunk-plus-context') {
        metrics.contextSnippets += context.snippets.length
        metrics.contextBytes += context.estimatedBytes
        metrics.contextTokens += context.estimatedTokens
      }
      for (const key of ['tp', 'fp', 'fn']) metrics[key] += score[key]
    }
  }

  const hunkOnly = finalize(arms['hunk-only'])
  const hunkPlusContext = finalize(arms['hunk-plus-context'])
  const delta = {}
  for (const key of [
    'promptBytes',
    'promptTokens',
    'tp',
    'fp',
    'fn',
    'precision',
    'recall',
    'f1'
  ]) {
    delta[key] = hunkPlusContext[key] - hunkOnly[key]
  }

  return {
    mode: 'offline-fixture-comparison',
    cases: fixtures.length,
    modelCalls: 0,
    latencyMeaning:
      'local prompt construction and protocol validation only; model inference not measured',
    qualityMeaning:
      'fixture responses are replayed across both arms unless a caller supplies arm-specific responses; this does not establish real-model context efficacy',
    arms: {
      'hunk-only': hunkOnly,
      'hunk-plus-context': hunkPlusContext
    },
    contextMinusHunkOnly: delta
  }
}

async function main() {
  const fixtureUrl = new URL(
    '../tests/fixtures/embedded-c-review.json',
    import.meta.url
  )
  const fixtures = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
  const result = await runContextComparison(fixtures, async ({fixture}) =>
    JSON.stringify(fixture.mock_response)
  )
  console.log(JSON.stringify(result, null, 2))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
