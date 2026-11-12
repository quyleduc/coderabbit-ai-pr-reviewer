import test from 'node:test'
import assert from 'node:assert/strict'
import {smokeReadOnlyPullRequest} from '../scripts/read-only-review-smoke.mjs'

const diff = '@@ -1,2 +1,2 @@\n-old\n+newValue();\n keep\n@@ -8 +8 @@\n-before\n+after();\n'

test('real GitHub-style diff supports a fully offline fake model to fake review submission', async () => {
  const seenPages = []
  const result = await smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async page => {
      seenPages.push(page)
      return page === 1 ? [{filename: 'src/driver.c', patch: diff, additions: 2, deletions: 2}] : []
    }
  })
  assert.deepEqual(seenPages, [1])
  assert.equal(result.headSha, 'a'.repeat(40))
  assert.equal(result.reviewedFiles, 1)
  assert.equal(result.reviewedHunks, 2)
  assert.equal(result.syntheticFindings, 1)
  assert.equal(result.fakeReviewConfirmed, true)
  assert.equal(result.replayedCandidates, 0)
  assert.equal(result.realGitHubMutations, 0)
})

test('real PR file pagination handles 100-file pages without dropping the remaining files', async () => {
  const pages = []
  const result = await smokeReadOnlyPullRequest({
    pageSize: 2,
    expectedHead: 'b'.repeat(40),
    expectedFileCount: 3,
    fetchHead: async () => 'b'.repeat(40),
    fetchPage: async page => {
      pages.push(page)
      if (page === 1) return [
        {filename: 'README.md', patch: '@@ -1 +1 @@\n-before\n+after\n', additions: 1, deletions: 1},
        {filename: 'doc.txt', patch: '@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1}
      ]
      return [{filename: 'src/driver.c', patch: diff, additions: 2, deletions: 2}]
    }
  })
  assert.deepEqual(pages, [1, 2])
  assert.equal(result.reviewedFiles, 3)
  assert.equal(result.reviewedHunks, 4)
  assert.equal(result.skippedNoPatch, 0)
})

test('stale PR HEAD refuses to run even a fake reviewer', async () => {
  let filesFetched = 0
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'b'.repeat(40),
    fetchPage: async () => {filesFetched++; return []}
  }), /head.*changed|stale/i)
  assert.equal(filesFetched, 0)
})

test('API read errors and truncated file lists are never accepted as successful smoke', async () => {
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => {throw new Error('GitHub 429')}
  }), /GitHub 429/)
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'a'.repeat(40),
    pageSize: 1,
    maxPages: 2,
    expectedFileCount: 3,
    fetchPage: async page => [{filename: 'src/x' + page + '.c', patch: diff}]
  }), /pagination|limit/i)
})

test('a PR without a usable text patch is inconclusive, not a successful review', async () => {
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => [{filename: 'binary.bin'}]
  }), /usable|diff|patch/i)
})

test('no live GitHub mutation API is invoked by this smoke test', async () => {
  const result = await smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 1,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => [{filename: 'src/driver.c', patch: diff, additions: 2, deletions: 2}]
  })
  assert.equal(result.realGitHubMutations, 0)
  assert.equal(result.fakeReviewConfirmed, true)
})

test('root npm lockfile with omitted GitHub patch is explicitly excluded but accounted for', async () => {
  const result = await smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40), expectedFileCount: 2,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => [
      {filename: 'src/driver.c', patch: diff, additions: 2, deletions: 2},
      {filename: 'package-lock.json', status: 'modified', additions: 500, deletions: 320}
    ]
  })
  assert.equal(result.retrievedFiles, 2)
  assert.equal(result.reviewedFiles, 1)
  assert.deepEqual(result.ignoredGeneratedFiles, ['package-lock.json'])
  assert.equal(result.realGitHubMutations, 0)
})

test('packaged action bundle artifacts with missing binary patches are explicitly excluded and counted', async () => {
  const result = await smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40),
    expectedFileCount: 3,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => [
      {filename: 'src/driver.c', patch: diff, additions: 2, deletions: 2},
      {filename: 'dist/index.js', status: 'modified', additions: 0, deletions: 0},
      {filename: 'dist/licenses.txt', status: 'modified', additions: 0, deletions: 0}
    ]
  })
  assert.equal(result.retrievedFiles, 3)
  assert.equal(result.reviewedFiles, 1)
  assert.deepEqual(result.ignoredGeneratedFiles, [
    'dist/index.js',
    'dist/licenses.txt'
  ])
  assert.equal(result.realGitHubMutations, 0)
})

test('unreviewable source patch still blocks success even alongside an explicit lockfile exclusion', async () => {
  await assert.rejects(smokeReadOnlyPullRequest({
    expectedHead: 'a'.repeat(40), expectedFileCount: 2,
    fetchHead: async () => 'a'.repeat(40),
    fetchPage: async () => [
      {filename: 'src/broken.c', additions: 1, deletions: 1},
      {filename: 'package-lock.json', additions: 1, deletions: 1}
    ]
  }), /missing|usable|patch/i)
})

test('only exact generated paths are excluded, not arbitrary nested or similarly named files', async () => {
  for (const filename of [
    'src/package-lock.json',
    'package-lock.json.bak',
    'npm-shrinkwrap.json',
    'dist/custom-source.js'
  ]) {
    await assert.rejects(smokeReadOnlyPullRequest({
      expectedHead: 'a'.repeat(40), expectedFileCount: 1,
      fetchHead: async () => 'a'.repeat(40),
      fetchPage: async () => [{filename, additions: 1, deletions: 1}]
    }), /missing|usable|patch/i)
  }
})
