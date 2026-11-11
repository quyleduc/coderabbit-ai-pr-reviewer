import test from 'node:test'
import assert from 'node:assert/strict'
import {smokeReadOnlyPullRequest} from '../scripts/read-only-review-smoke.mjs'

const sha = 'a'.repeat(40)
const patchA = '@@ -1,2 +1,2 @@\n-old\n+updated();\n context\n@@ -9 +9 @@\n-before\n+after();\n'
const patchB = '@@ -3 +3 @@\n-a\n+b\n'
const deleteOnly = '@@ -1 +0,0 @@\n-removed\n'

const run = (files, options = {}) => smokeReadOnlyPullRequest({
  expectedHead: sha,
  expectedFileCount: files.length,
  fetchHead: async () => sha,
  fetchPage: async () => files,
  ...options
})

test('all files, all hunks are accounted for, not just the first patch', async () => {
  const result = await run([
    {filename: 'src/a.c', status: 'modified', patch: patchA, additions: 2, deletions: 2},
    {filename: 'src/b.c', status: 'modified', patch: patchB, additions: 1, deletions: 1}
  ])
  assert.equal(result.retrievedFiles, 2)
  assert.equal(result.reviewedFiles, 2)
  assert.equal(result.reviewedHunks, 3)
  assert.equal(result.syntheticFindings, 2)
  assert.equal(result.replayedCandidates, 0)
  assert.equal(result.realGitHubMutations, 0)
  assert.deepEqual(result.coveredFiles.sort(), ['src/a.c', 'src/b.c'])
})

test('deletion-only text diff is accounted as clean, not silently ignored', async () => {
  const result = await run([
    {filename: 'src/removed.c', status: 'removed', patch: deleteOnly, additions: 0, deletions: 1},
    {filename: 'src/changed.c', status: 'modified', patch: patchB, additions: 1, deletions: 1}
  ])
  assert.equal(result.reviewedFiles, 2)
  assert.equal(result.reviewedHunks, 2)
  assert.equal(result.syntheticFindings, 1)
  assert.equal(result.realGitHubMutations, 0)
})

test('missing binary/oversized file patch blocks full coverage', async () => {
  await assert.rejects(run([
    {filename: 'src/ok.c', patch: patchB, additions: 1, deletions: 1},
    {filename: 'firmware.bin', patch: undefined, additions: 0, deletions: 0}
  ]), /missing|unavailable|patch/i)
})

test('GitHub changed_files metadata mismatch blocks completion', async () => {
  await assert.rejects(run([
    {filename: 'src/ok.c', patch: patchB, additions: 1, deletions: 1}
  ], {expectedFileCount: 2}), /file count|mismatch|missing/i)
  await assert.rejects(run([
    {filename: 'src/ok.c', patch: patchB, additions: 1, deletions: 1}
  ], {expectedFileCount: 0}), /file count|mismatch|invalid/i)
})

test('patch counts must match GitHub additions/deletions; truncated hunks cannot count', async () => {
  await assert.rejects(run([
    {filename: 'src/truncated.c', patch: patchB, additions: 3, deletions: 2}
  ]), /truncated|mismatch|line count/i)
})

test('malformed diffs and missing hunk bodies cannot count as covered', async () => {
  await assert.rejects(run([
    {filename: 'src/bad.c', patch: '@@ -1 +1 @@\n-old\n', additions: 0, deletions: 1}
  ]), /invalid|malformed|patch/i)
})

test('duplicate GitHub file entries cannot produce false coverage', async () => {
  await assert.rejects(run([
    {filename: 'src/reused.c', patch: patchB, additions: 1, deletions: 1},
    {filename: 'src/reused.c', patch: patchB, additions: 1, deletions: 1}
  ]), /duplicate|filename/i)
})

test('more than 20 hunks cannot be silently skipped', async () => {
  const patch = Array.from({length: 21}, (_, i) =>
    '@@ -' + (i + 1) + ' +' + (i + 1) + ' @@\n-x\n+y\n').join('')
  await assert.rejects(run([
    {filename: 'src/large.c', patch, additions: 21, deletions: 21}
  ]), /too many|limit|hunks/i)
})

test('changed SHA after page traversal prevents any success', async () => {
  let checks = 0
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: sha,
    expectedFileCount: 1,
    fetchHead: async () => ++checks === 1 ? sha : 'b'.repeat(40),
    fetchPage: async () => [{filename: 'src/a.c', patch: patchB, additions: 1, deletions: 1}]
  }), /stale|head.*changed/i)
})
