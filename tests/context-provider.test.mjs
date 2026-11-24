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

test('resolves multi-relation symbols (EXPANDS_MACRO, ALIASES, READS, WRITES, CALLS) across PlatformIO layout and 2-hop headers', async () => {
  const pioFiles = {
    'firmware/src/worker.cpp': `#include "worker.h"
void tick(cfg_t *cfg) {
  g_ticks += STEP_INC;
  int mode = MODE_ACTIVE;
  int clamped = CLAMP(mode, STEP_INC);
  hal_apply(cfg, clamped);
}
`,
    'firmware/include/worker.h': `#include "hal_types.h"
#define STEP_INC 4
#define CLAMP(x, hi) ((x) > (hi) ? (hi) : (x))
extern int g_ticks;
void hal_apply(cfg_t *cfg, int v);
`,
    'firmware/include/hal_types.h': `typedef struct { int limit; } cfg_t;
enum worker_mode { MODE_IDLE = 0, MODE_ACTIVE = 1 };
`,
    'firmware/src/worker.c': `#include "worker.h"
int g_ticks = 0;
void hal_apply(cfg_t *cfg, int v) {
  if (cfg) cfg->limit = v;
}
`
  }
  const provider = createAstContextProvider({
    parser,
    fetchFile: async path => {
      const text = pioFiles[path]
      return text === undefined ? null : {blobSha: sha(text), text}
    },
    maxFetches: 8
  })
  const res = await retrieveReviewContext(
    provider,
    request({
      changedFile: 'firmware/src/worker.cpp',
      hunks: [{startLine: 2, endLine: 7, patch: '@@ -2,0 +2,6 @@'}]
    })
  )
  assert.equal(res.status, 'available')
  const byKey = Object.fromEntries(
    res.snippets.map(s => [`${s.relation}:${s.symbolId}@${s.path}`, s])
  )
  assert.ok(byKey['CALLS:c:function:hal_apply@firmware/src/worker.c'])
  assert.ok(byKey['WRITES:c:variable:g_ticks@firmware/src/worker.c'])
  assert.ok(byKey['EXPANDS_MACRO:c:macro:STEP_INC@firmware/include/worker.h'])
  assert.ok(byKey['EXPANDS_MACRO:c:macro:CLAMP@firmware/include/worker.h'])
  assert.ok(byKey['ALIASES:c:type:cfg_t@firmware/include/hal_types.h'])
  assert.equal(
    byKey['ALIASES:c:type:cfg_t@firmware/include/hal_types.h'].graphDistance,
    2
  )
  assert.ok(byKey['READS:c:enum:MODE_ACTIVE@firmware/include/hal_types.h'])
})

test('trims trailing blank line at MAX_EXCERPT_LINES cap and avoids wasting fetches on macro-only headers', async () => {
  const bodyLines = Array.from({length: 39}, (_, idx) =>
    idx === 38 ? '' : `  x += ${idx};`
  ).join('\n')
  const files = {
    'timers.c': `#include "FreeRTOS.h"\n#include "list.h"\nstatic int helper(int x) {\n${bodyLines}\n}\nvoid run(void) { helper(1); item_init(); }\n`,
    'include/FreeRTOS.h': '#define traceRUN() ((void)0)\n',
    'include/list.h': 'void item_init(void);\n',
    'list.c': 'void item_init(void) {}\n'
  }
  const fetched = []
  const provider = createAstContextProvider({
    parser,
    maxFetches: 7,
    fetchFile: async path => {
      fetched.push(path)
      const text = files[path]
      return text === undefined ? null : {blobSha: sha(text), text}
    }
  })
  const res = await retrieveReviewContext(
    provider,
    request({
      changedFile: 'timers.c',
      hunks: [{startLine: 44, endLine: 44, patch: '@@ -44 +44 @@'}]
    })
  )
  assert.equal(res.status, 'available')
  const helperSnippet = res.snippets.find(s => s.symbolId === 'c:function:helper')
  assert.ok(helperSnippet)
  assert.equal(helperSnippet.excerpt.endsWith('\n'), false)
  assert.ok(!fetched.some(p => p.includes('FreeRTOS.c') || p.includes('FreeRTOS.cpp')))
  assert.ok(res.snippets.some(s => s.symbolId === 'c:function:item_init' && s.path === 'include/list.h'))
})
