import test from 'node:test'
import assert from 'node:assert/strict'
import {loadCompletePullRequestFiles, verifyPullRequestPatch} from '../src/pr-files.ts'

const validPatch = '@@ -1 +1 @@\n-old\n+new\n'
const file = (i, overrides={}) => ({
  filename: 'src/file-' + i + '.c', status: 'modified',
  patch: validPatch, additions: 1, deletions: 1, ...overrides
})

test('retrieves every file through exact expected count with GitHub pages', async () => {
  const data = [file(0), file(1), file(2), file(3), file(4)]
  const pages = []
  const actual = await loadCompletePullRequestFiles(5, async (page, perPage) => {
    pages.push([page, perPage])
    return data.slice((page - 1) * perPage, page * perPage)
  }, {pageSize: 2})
  assert.deepEqual(pages, [[1, 2], [2, 2], [3, 2]])
  assert.deepEqual(actual, data)
})

test('single page can contain all 300 files without Compare API cap failure', async () => {
  const all = Array.from({length: 300}, (_, i) => file(i))
  const result = await loadCompletePullRequestFiles(300, async page =>
    all.slice((page - 1) * 100, page * 100))
  assert.equal(result.length, 300)
})

test('GitHub 3000 limit supported, 3001 rejected before fetching', async () => {
  let calls = 0
  const result = await loadCompletePullRequestFiles(3000, async (page, perPage) => {
    calls++
    return Array.from({length: perPage}, (_, i) => file((page - 1) * perPage + i))
  })
  assert.equal(result.length, 3000)
  assert.equal(calls, 30)
  await assert.rejects(loadCompletePullRequestFiles(3001, async () => {
    throw new Error('must not fetch')
  }), /limit|3000|unsupported/i)
})

test('changed_files count cannot be silently underfilled by empty or short page', async () => {
  await assert.rejects(loadCompletePullRequestFiles(3, async () => [file(1)]), /count|missing|incomplete/i)
  await assert.rejects(loadCompletePullRequestFiles(2, async () => []), /count|missing|incomplete/i)
})

test('duplicate filenames across pages are hard failures', async () => {
  await assert.rejects(loadCompletePullRequestFiles(3, async page =>
    page === 1 ? [file(1), file(2)] : [file(2)], {pageSize: 2}), /duplicate/i)
})

test('overfilled pages, malformed metadata and invalid count are rejected', async () => {
  await assert.rejects(loadCompletePullRequestFiles(1, async () => [file(1),file(2)] , {pageSize: 1}), /page|length/i)
  await assert.rejects(loadCompletePullRequestFiles(1, async () => [file(1,{filename:''})]), /filename/i)
  await assert.rejects(loadCompletePullRequestFiles(0, async () => [file(1)]), /count/i)
  await assert.rejects(loadCompletePullRequestFiles(NaN, async () => [file(1)]), /count/i)
})

test('read failure must propagate, never interpret as an empty page', async () => {
  await assert.rejects(loadCompletePullRequestFiles(1, async () => {
    throw new Error('GitHub 403 secondary rate-limit')
  }), /403/)
})

test('only a complete text patch can enter the model reviewer', () => {
  assert.doesNotThrow(() => verifyPullRequestPatch(file(1)))
  assert.throws(() => verifyPullRequestPatch(file(1, {patch: undefined})), /missing|patch/i)
  assert.throws(() => verifyPullRequestPatch(file(1, {patch: validPatch, additions: 2})), /truncat|mismatch/i)
  assert.throws(() => verifyPullRequestPatch(file(1, {patch: '@@ -1 +1 @@\n-old\n', deletions:1, additions:1})), /patch|truncat|mismatch/i)
})

test('missing additions/deletions metadata, invalid hunk or extra diff data fails closed', () => {
  assert.throws(() => verifyPullRequestPatch(file(1, {additions: undefined})), /metadata|counts/i)
  assert.throws(() => verifyPullRequestPatch(file(1, {patch: '@@ -1 +1 @@\n-old\n+new\nGARBAGE\n'})), /invalid|patch|hunk/i)
})

test('pure rename/empty patch cannot silently count as reviewed', () => {
  assert.throws(() => verifyPullRequestPatch(file(1, {status: 'renamed', patch: null, additions:0, deletions:0})), /patch/i)
})
