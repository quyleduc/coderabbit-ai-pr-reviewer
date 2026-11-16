import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {
  createAstContextProvider,
  createGithubFileFetcher,
  loadCParser,
  C_CONTEXT_VARIANT_ID
} from '../src/context-provider.ts'
import {retrieveReviewContext} from '../src/review-context.ts'

const WASM = new URL('../vendor/tree-sitter-c.wasm', import.meta.url).pathname
const HEAD = 'a'.repeat(40)
const sha = text => createHash('sha1').update(text).digest('hex')

const FILES = {
  'main/app.c': `#include "driver.h"
#include <stdio.h>
static int add(int a, int b) { return a + b; }
void app_main(void) {
  int r = add(1, 2);
  driver_init(&r);
  helper_missing();
}
`,
  'main/driver.h': `#ifdef __cplusplus
extern "C" {
#endif
int driver_init(int *p);
#ifdef __cplusplus
}
#endif
`,
  'main/driver.c': `#include "driver.h"
int driver_init(int *p) {
  *p = 0;
  return 0;
}
`
}

function fakeFetcher(log) {
  return async path => {
    log.push(path)
    const text = FILES[path]
    return text === undefined ? null : {blobSha: sha(text), text}
  }
}

function request(overrides = {}) {
  return {
    repositoryId: 'o/r',
    pullRequestNumber: 1,
    baseSha: 'b'.repeat(40),
    headSha: HEAD,
    changedFile: 'main/app.c',
    hunks: [{startLine: 5, endLine: 7, patch: '@@ -5 +5,3 @@'}],
    ...overrides
  }
}

const parser = await loadCParser(WASM)

test('resolves same-file definition and header->sibling definition; passes real validator', async () => {
  const log = []
  const provider = createAstContextProvider({parser, fetchFile: fakeFetcher(log)})
  const result = await retrieveReviewContext(provider, request())
  assert.equal(result.status, 'available')
  const byName = Object.fromEntries(result.snippets.map(s => [s.symbolId + '@' + s.path, s]))
  assert.ok(byName['c:function:add@main/app.c'])
  assert.equal(byName['c:function:add@main/app.c'].status, 'SUPPORTED')
  assert.ok(byName['c:function:driver_init@main/driver.c'])
  assert.equal(byName['c:function:driver_init@main/driver.c'].status, 'SUPPORTED')
  // prototype is kept but flagged uncertain
  assert.equal(byName['c:function:driver_init@main/driver.h'].status, 'PARTIAL')
  assert.equal(byName['c:function:driver_init@main/driver.h'].isUncertain, true)
  // unresolved call produces nothing
  assert.ok(!result.snippets.some(s => s.symbolId.includes('helper_missing')))
  assert.equal(result.snippets[0].variantId, C_CONTEXT_VARIANT_ID)
})

test('ignores calls outside changed hunks and non-C files', async () => {
  const provider = createAstContextProvider({parser, fetchFile: fakeFetcher([])})
  const outside = await retrieveReviewContext(
    provider,
    request({hunks: [{startLine: 1, endLine: 2, patch: '@@ -1 +1 @@'}]})
  )
  assert.equal(outside.status, 'empty')
  const py = await retrieveReviewContext(provider, request({changedFile: 'x.py'}))
  assert.equal(py.status, 'empty')
})

test('fetch budget bounds API calls and degrades without failing', async () => {
  const log = []
  const provider = createAstContextProvider({
    parser,
    fetchFile: fakeFetcher(log),
    maxFetches: 1
  })
  const result = await retrieveReviewContext(provider, request())
  assert.equal(log.length, 1)
  assert.equal(result.status, 'available') // same-file definition still resolves
})

test('rejects path traversal in includes', async () => {
  const log = []
  FILES['main/evil.c'] = 'void f(void) { g(); }\n#include "../../../etc/x.h"\n'
  const provider = createAstContextProvider({parser, fetchFile: fakeFetcher(log)})
  await retrieveReviewContext(
    provider,
    request({changedFile: 'main/evil.c', hunks: [{startLine: 1, endLine: 1, patch: 'x'}]})
  )
  assert.ok(log.every(p => !p.startsWith('..') && !p.includes('/../')))
  delete FILES['main/evil.c']
})

test('github fetcher: size cap, non-file and errors become null', async () => {
  const body = {type: 'file', encoding: 'base64', sha: 'c'.repeat(40), size: 3, content: Buffer.from('int').toString('base64')}
  const make = impl => createGithubFileFetcher({repos: {getContent: impl}}, 'o', 'r')
  const sig = new AbortController().signal
  assert.deepEqual(await make(async () => ({data: body}))('a.c', HEAD, sig), {blobSha: body.sha, text: 'int'})
  assert.equal(await make(async () => ({data: {...body, size: 999999}}))('a.c', HEAD, sig), null)
  assert.equal(await make(async () => ({data: [body]}))('a.c', HEAD, sig), null)
  assert.equal(await make(async () => { throw new Error('404') })('a.c', HEAD, sig), null)
})

test('vendored wasm matches pinned checksum', () => {
  const digest = createHash('sha256').update(readFileSync(WASM)).digest('hex')
  assert.equal(digest, 'c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9')
})
