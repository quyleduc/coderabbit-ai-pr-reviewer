import test from 'node:test'
import assert from 'node:assert/strict'

const apiPromise = import('../src/review-context.ts').catch(() => null)

async function getApi() {
  const api = await apiPromise
  assert.ok(
    api,
    'review-context module should expose the bounded retrieval contract'
  )
  assert.equal(typeof api.retrieveReviewContext, 'function')
  return api
}

const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const VARIANT_ID = 'gcc-arm-v1'

function request(overrides = {}) {
  return {
    repositoryId: 'owner/repo',
    pullRequestNumber: 21,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    changedFile: 'src/entry.c',
    hunks: [
      {
        startLine: 10,
        endLine: 10,
        patch: '@@ -9 +10 @@\n-old_call();\n+new_call();'
      }
    ],
    ...overrides
  }
}

function candidate(overrides = {}) {
  return {
    headSha: HEAD_SHA,
    blobSha: 'c'.repeat(40),
    path: 'src/callee.c',
    startLine: 40,
    endLine: 41,
    symbolId: 'symbol:callee',
    relation: 'CALLS',
    variantId: VARIANT_ID,
    status: 'SUPPORTED',
    graphDistance: 1,
    provenance: 'fixture:fact-17',
    excerpt: 'int callee(void) {\n  return 1;}',
    ...overrides
  }
}

function provider(candidates, overrides = {}) {
  return {
    variantId: VARIANT_ID,
    collectCandidates: async () => candidates,
    ...overrides
  }
}

test('selects valid facts in graph-distance and fixed relation order, independent of provider order', async () => {
  const {retrieveReviewContext} = await getApi()
  const facts = [
    candidate({path: 'src/z.c', symbolId: 'symbol:read', relation: 'READS'}),
    candidate({path: 'src/z.c', symbolId: 'symbol:call', relation: 'CALLS'}),
    candidate({path: 'src/a.c', symbolId: 'symbol:alias', relation: 'ALIASES'}),
    candidate({
      path: 'src/near.c',
      symbolId: 'symbol:near',
      relation: 'ALIASES',
      graphDistance: 0
    })
  ]
  const first = await retrieveReviewContext(provider(facts), request())
  const second = await retrieveReviewContext(
    provider([...facts].reverse()),
    request()
  )

  assert.equal(first.status, 'available')
  assert.deepEqual(
    first.snippets.map(item => item.symbolId),
    ['symbol:near', 'symbol:call', 'symbol:read', 'symbol:alias']
  )
  assert.deepEqual(second.snippets, first.snippets)
})

test('retrieves embedded-C declaration, definition, and caller facts for a changed call site', async () => {
  const {retrieveReviewContext} = await getApi()
  const fixtureRequest = request({
    changedFile: 'src/temperature_controller.c',
    hunks: [
      {
        startLine: 41,
        endLine: 41,
        patch: '@@ -40,0 +41 @@\n+  return sensor_read(&controller->sensor);'
      }
    ]
  })
  const facts = [
    candidate({
      path: 'src/control_loop.c',
      startLine: 75,
      endLine: 77,
      symbolId: 'symbol:control_loop_read_sensor',
      graphDistance: 2,
      provenance: 'fixture:caller-edge-3',
      excerpt: 'void control_loop(void) {\n  sensor_read(&sensor);\n}'
    }),
    candidate({
      path: 'src/temperature_sensor.c',
      startLine: 29,
      endLine: 32,
      symbolId: 'symbol:sensor_read_definition',
      graphDistance: 1,
      provenance: 'fixture:definition-edge-2',
      excerpt:
        'int sensor_read(TemperatureSensor *sensor) {\n  if (sensor == NULL) return -1;\n  return read_adc(sensor->channel);\n}'
    }),
    candidate({
      path: 'include/temperature_sensor.h',
      startLine: 12,
      endLine: 12,
      symbolId: 'symbol:sensor_read_declaration',
      graphDistance: 1,
      provenance: 'fixture:declaration-edge-1',
      excerpt: 'int sensor_read(TemperatureSensor *sensor);'
    })
  ]
  const result = await retrieveReviewContext(
    {
      variantId: VARIANT_ID,
      collectCandidates: async (received, _signal, maxCandidates) => {
        assert.equal(received.changedFile, fixtureRequest.changedFile)
        assert.equal(maxCandidates, 256)
        assert.match(
          received.hunks[0].patch,
          /sensor_read\(&controller->sensor\)/
        )
        return facts
      }
    },
    fixtureRequest,
    {maxSnippets: 3}
  )

  assert.equal(result.status, 'available')
  assert.deepEqual(
    result.snippets.map(({path, symbolId}) => [path, symbolId]),
    [
      ['include/temperature_sensor.h', 'symbol:sensor_read_declaration'],
      ['src/temperature_sensor.c', 'symbol:sensor_read_definition'],
      ['src/control_loop.c', 'symbol:control_loop_read_sensor']
    ]
  )
})

test('uses path, symbol, and line as stable tie breakers after graph and relation rank', async () => {
  const {retrieveReviewContext} = await getApi()
  const facts = [
    candidate({
      path: 'src/b.c',
      symbolId: 'symbol:a',
      startLine: 12,
      endLine: 13
    }),
    candidate({
      path: 'src/a.c',
      symbolId: 'symbol:z',
      startLine: 12,
      endLine: 13
    }),
    candidate({
      path: 'src/a.c',
      symbolId: 'symbol:a',
      startLine: 20,
      endLine: 21
    }),
    candidate({
      path: 'src/a.c',
      symbolId: 'symbol:a',
      startLine: 11,
      endLine: 12
    })
  ]

  const result = await retrieveReviewContext(provider(facts), request())
  assert.deepEqual(
    result.snippets.map(({path, symbolId, startLine}) => [
      path,
      symbolId,
      startLine
    ]),
    [
      ['src/a.c', 'symbol:a', 11],
      ['src/a.c', 'symbol:a', 20],
      ['src/a.c', 'symbol:z', 12],
      ['src/b.c', 'symbol:a', 12]
    ]
  )
})

test('rejects a stale head or a different requested build variant as a whole response', async () => {
  const {retrieveReviewContext} = await getApi()
  const stale = await retrieveReviewContext(
    provider([candidate({headSha: 'd'.repeat(40)})]),
    request()
  )
  assert.equal(stale.status, 'unavailable')
  assert.deepEqual(stale.snippets, [])
  assert.deepEqual(stale.reasonCodes, ['stale_head'])

  const variantMismatch = await retrieveReviewContext(
    provider([candidate()], {variantId: 'clang-arm-v2'}),
    request()
  )
  assert.equal(variantMismatch.status, 'unavailable')
  assert.deepEqual(variantMismatch.snippets, [])
  assert.deepEqual(variantMismatch.reasonCodes, ['variant_mismatch'])
})

test('rejects malformed identity, path, range, relation, status, provenance, distance, or excerpt length', async () => {
  const {retrieveReviewContext} = await getApi()
  const malformed = [
    {path: '../outside.c'},
    {path: '/absolute.c'},
    {path: 'src\\outside.c'},
    {path: 'src/unsafe\nname.c'},
    {blobSha: 'not-a-git-sha'},
    {startLine: 0},
    {endLine: 39},
    {relation: 'INVOKES'},
    {status: 'MAYBE'},
    {symbolId: 'symbol\nother'},
    {provenance: ''},
    {graphDistance: -1},
    {excerpt: 'only one line'}
  ]

  for (const override of malformed) {
    const result = await retrieveReviewContext(
      provider([candidate(override)]),
      request()
    )
    assert.equal(result.status, 'unavailable', JSON.stringify(override))
    assert.deepEqual(result.snippets, [], JSON.stringify(override))
    assert.deepEqual(
      result.reasonCodes,
      ['malformed_candidate'],
      JSON.stringify(override)
    )
  }
})

test('any malformed fact rejects the complete provider response instead of keeping valid neighbors', async () => {
  const {retrieveReviewContext} = await getApi()
  const result = await retrieveReviewContext(
    provider([candidate(), candidate({variantId: 'wrong-variant'})]),
    request()
  )

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.snippets, [])
  assert.deepEqual(result.reasonCodes, ['variant_mismatch'])
})

test('rejects excessive provider candidate counts before validating or sorting them', async () => {
  const {retrieveReviewContext} = await getApi()
  const result = await retrieveReviewContext(
    provider(
      Array.from({length: 257}, (_, index) =>
        candidate({symbolId: `symbol:${index}`})
      )
    ),
    request()
  )

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.snippets, [])
  assert.deepEqual(result.reasonCodes, ['max_candidates'])
})

test('deduplicates the same path, range, symbol, relation, and variant deterministically', async () => {
  const {retrieveReviewContext} = await getApi()
  const one = candidate({provenance: 'fixture:fact-a'})
  const duplicate = candidate({provenance: 'fixture:fact-z', graphDistance: 2})
  const first = await retrieveReviewContext(
    provider([duplicate, one]),
    request()
  )
  const second = await retrieveReviewContext(
    provider([one, duplicate]),
    request()
  )

  assert.equal(first.snippets.length, 1)
  assert.equal(first.snippets[0].provenance, 'fixture:fact-a')
  assert.deepEqual(second.snippets, first.snippets)
})

test('preserves uncertain fact labels and marks them as uncertain reference context', async () => {
  const {retrieveReviewContext} = await getApi()
  const statuses = [
    'SUPPORTED',
    'PARTIAL',
    'UNKNOWN',
    'UNSUPPORTED',
    'UNMATCHED'
  ]
  const result = await retrieveReviewContext(
    provider(
      statuses.map((status, index) =>
        candidate({
          status,
          graphDistance: index,
          symbolId: `symbol:${status}`
        })
      )
    ),
    request()
  )

  assert.deepEqual(
    result.snippets.map(({status, isUncertain}) => [status, isUncertain]),
    [
      ['SUPPORTED', false],
      ['PARTIAL', true],
      ['UNKNOWN', true],
      ['UNSUPPORTED', true],
      ['UNMATCHED', true]
    ]
  )
})

test('applies file and snippet caps to a deterministic prefix and records the stop reason', async () => {
  const {retrieveReviewContext} = await getApi()
  const result = await retrieveReviewContext(
    provider([
      candidate({path: 'src/a.c', symbolId: 'symbol:first'}),
      candidate({path: 'src/b.c', symbolId: 'symbol:second'}),
      candidate({path: 'src/a.c', symbolId: 'symbol:third'})
    ]),
    request(),
    {maxFiles: 1, maxSnippets: 3}
  )

  assert.deepEqual(
    result.snippets.map(item => item.symbolId),
    ['symbol:first', 'symbol:third']
  )
  assert.deepEqual(result.reasonCodes, ['max_files'])

  const snippetLimited = await retrieveReviewContext(
    provider([
      candidate({path: 'src/a.c', symbolId: 'symbol:first'}),
      candidate({path: 'src/a.c', symbolId: 'symbol:second'})
    ]),
    request(),
    {maxFiles: 8, maxSnippets: 1}
  )
  assert.deepEqual(
    snippetLimited.snippets.map(item => item.symbolId),
    ['symbol:first']
  )
  assert.deepEqual(snippetLimited.reasonCodes, ['max_snippets'])
})

test('does not truncate snippets and returns no context when one snippet exceeds byte or token budget', async () => {
  const {retrieveReviewContext} = await getApi()
  const oversizedByBytes = await retrieveReviewContext(
    provider([candidate()]),
    request(),
    {maxBytes: 2}
  )
  assert.equal(oversizedByBytes.status, 'unavailable')
  assert.deepEqual(oversizedByBytes.snippets, [])
  assert.deepEqual(oversizedByBytes.reasonCodes, [
    'snippet_exceeds_byte_budget'
  ])

  const oversizedByTokens = await retrieveReviewContext(
    provider([candidate()]),
    request(),
    {maxTokens: 1}
  )
  assert.equal(oversizedByTokens.status, 'unavailable')
  assert.deepEqual(oversizedByTokens.snippets, [])
  assert.deepEqual(oversizedByTokens.reasonCodes, [
    'snippet_exceeds_token_budget'
  ])
})

test('budgets the complete serialized prompt context, including metadata and JSON formatting', async () => {
  const {retrieveReviewContext, formatReviewContextForPrompt} = await getApi()
  const {getTokenCount} = await import('../src/tokenizer.ts')
  const fact = candidate({
    symbolId: `symbol:${'x'.repeat(400)}`,
    endLine: 40,
    excerpt: 'a();'
  })
  const available = await retrieveReviewContext(provider([fact]), request(), {
    maxSnippets: 1
  })
  const formatted = formatReviewContextForPrompt(available)

  assert.equal(available.status, 'available')
  assert.equal(available.estimatedBytes, Buffer.byteLength(formatted, 'utf8'))
  assert.equal(available.estimatedTokens, getTokenCount(formatted))

  const metadataOverBudget = await retrieveReviewContext(
    provider([fact]),
    request(),
    {maxBytes: Buffer.byteLength(fact.excerpt, 'utf8') + 1}
  )
  assert.equal(metadataOverBudget.status, 'unavailable')
  assert.deepEqual(metadataOverBudget.reasonCodes, [
    'snippet_exceeds_byte_budget'
  ])

  const tokenOverBudget = await retrieveReviewContext(
    provider([fact]),
    request(),
    {maxTokens: available.estimatedTokens - 1}
  )
  assert.equal(tokenOverBudget.status, 'unavailable')
  assert.deepEqual(tokenOverBudget.reasonCodes, [
    'snippet_exceeds_token_budget'
  ])
})

test('stops at aggregate byte and token budgets with a measured, untruncated prefix', async () => {
  const {retrieveReviewContext} = await getApi()
  const firstOnly = await retrieveReviewContext(
    provider([
      candidate({
        path: 'src/a.c',
        symbolId: 'symbol:first',
        endLine: 40,
        excerpt: 'a();'
      })
    ]),
    request(),
    {maxSnippets: 1}
  )
  const first = candidate({
    path: 'src/a.c',
    symbolId: 'symbol:first',
    endLine: 40,
    excerpt: 'a();'
  })
  const second = candidate({
    path: 'src/b.c',
    symbolId: 'symbol:second',
    endLine: 40,
    excerpt: 'b();'
  })

  const byBytes = await retrieveReviewContext(
    provider([first, second]),
    request(),
    {maxBytes: firstOnly.estimatedBytes}
  )
  assert.deepEqual(
    byBytes.snippets.map(item => item.symbolId),
    ['symbol:first']
  )
  assert.equal(byBytes.estimatedBytes, firstOnly.estimatedBytes)
  assert.deepEqual(byBytes.reasonCodes, ['max_bytes'])

  const byTokens = await retrieveReviewContext(
    provider([first, second]),
    request(),
    {maxTokens: firstOnly.estimatedTokens}
  )
  assert.equal(byTokens.status, 'available')
  assert.ok(byTokens.estimatedTokens <= firstOnly.estimatedTokens)
  assert.ok(byTokens.snippets.length < 2)
  assert.deepEqual(byTokens.reasonCodes, ['max_tokens'])
})

test('reports stable hunk-only status when provider is absent, fails, or returns malformed data', async () => {
  const {retrieveReviewContext} = await getApi()
  const absent = await retrieveReviewContext(undefined, request())
  assert.equal(absent.status, 'unavailable')
  assert.deepEqual(absent.reasonCodes, ['provider_unavailable'])

  const failed = await retrieveReviewContext(
    {
      variantId: VARIANT_ID,
      collectCandidates: async () => {
        throw new Error('sensitive provider detail')
      }
    },
    request()
  )
  assert.equal(failed.status, 'unavailable')
  assert.deepEqual(failed.reasonCodes, ['provider_error'])
  assert.equal(
    JSON.stringify(failed).includes('sensitive provider detail'),
    false
  )

  const malformed = await retrieveReviewContext(
    provider({not: 'an array'}),
    request()
  )
  assert.equal(malformed.status, 'unavailable')
  assert.deepEqual(malformed.reasonCodes, ['malformed_response'])
})

test('passes a frozen review-scope snapshot so provider code cannot change the pinned head or hunks', async () => {
  const {retrieveReviewContext} = await getApi()
  const scope = request()
  let observedScope
  const result = await retrieveReviewContext(
    {
      variantId: VARIANT_ID,
      collectCandidates: async (received, _signal, maxCandidates) => {
        observedScope = received
        assert.equal(maxCandidates, 256)
        assert.equal(Object.isFrozen(received), true)
        assert.equal(Object.isFrozen(received.hunks), true)
        assert.equal(Object.isFrozen(received.hunks[0]), true)
        assert.throws(() => {
          received.headSha = 'd'.repeat(40)
        }, TypeError)
        return [candidate()]
      }
    },
    scope
  )

  assert.equal(result.status, 'available')
  assert.equal(scope.headSha, HEAD_SHA)
  assert.equal(observedScope.headSha, HEAD_SHA)
})

test('times out a non-cooperative provider, aborts its signal, and resolves without throwing', async () => {
  const {retrieveReviewContext} = await getApi()
  let observedSignal
  const result = await retrieveReviewContext(
    {
      variantId: VARIANT_ID,
      collectCandidates: async (_request, signal) => {
        observedSignal = signal
        return await new Promise(() => {})
      }
    },
    request(),
    {timeoutMs: 10}
  )

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.reasonCodes, ['provider_timeout'])
  assert.equal(observedSignal.aborted, true)
})

test('applies the retrieval deadline to validation after the provider resolves', async () => {
  const {retrieveReviewContext} = await getApi()
  const slowCandidate = new Proxy(candidate(), {
    get(target, property, receiver) {
      if (property === 'excerpt') {
        const deadline = Date.now() + 60
        while (Date.now() < deadline) {
          // Simulate synchronous provider data access that exceeds the deadline.
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const result = await retrieveReviewContext(
    provider([slowCandidate]),
    request(),
    {timeoutMs: 50}
  )

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.reasonCodes, ['provider_timeout'])
})

test('returns explicit empty status for a valid provider response with no candidates', async () => {
  const {retrieveReviewContext} = await getApi()
  const result = await retrieveReviewContext(provider([]), request())
  assert.equal(result.status, 'empty')
  assert.deepEqual(result.snippets, [])
  assert.deepEqual(result.reasonCodes, ['no_candidates'])
  assert.equal(result.estimatedBytes, 0)
  assert.equal(result.estimatedTokens, 0)
})
