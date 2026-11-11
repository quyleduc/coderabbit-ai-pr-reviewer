import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runEvaluationSuite, scoreFindings, requestModelResponse, buildFixturePrompt} from '../scripts/controlled-model-eval.mjs'

const truth = [{line: 5, rule_id: 'NULL_DEREF'}, {line: 10, rule_id: 'DIV_ZERO'}]

test('strict exact rule/line matching reports TP FP FN and duplicate predictions as FP', () => {
  const actual = scoreFindings([
    {line: 5, rule_id: 'NULL_DEREF'},
    {line: 5, rule_id: 'NULL_DEREF'},
    {line: 15, rule_id: 'UNSAFE_COPY'}
  ], truth)
  assert.deepEqual(actual, {tp: 1, fp: 2, fn: 1})
})

test('empty prediction has no false positives but misses known defects', () => {
  assert.deepEqual(scoreFindings([], truth), {tp: 0, fp: 0, fn: 2})
  assert.deepEqual(scoreFindings([], []), {tp: 0, fp: 0, fn: 0})
})

test('benchmark uses actual production prompt template with named hunk IDs', () => {
  const fixture = {id:'case-1', patch: '@@ -1 +1 @@\n-return value;\n+return *ptr;\n', title: 'Test', description: 'test'}
  const prompt = buildFixturePrompt(fixture)
  assert.match(prompt, /Strict review protocol \(version 1\)/)
  assert.match(prompt, /---review_hunk id=h0---/)
  assert.match(prompt, /return \*ptr;/)
  assert.doesNotMatch(prompt, /\$patches/)
})

test('mock evaluation validates response against source, not just JSON parse', async () => {
  const fixture = {
    id:'ptr-1', title:'Example', description:'Test', filename:'src/p.c',
    patch:'@@ -1 +1 @@\n-return 0;\n+return *ptr;\n',
    expected:[{line:1,rule_id:'NULL_DEREF'}],
    mock_response: {version:1,hunks:[{id:'h0',status:'issues',findings:[
      {line:1,rule_id:'NULL_DEREF',severity:'high',
       message:'Pointer may be null before dereferencing.',
       evidence:'return *ptr;'}
    ]}]}
  }
  const summary = await runEvaluationSuite([fixture], async input => JSON.stringify(input.mock_response))
  assert.equal(summary.cases, 1)
  assert.equal(summary.tp, 1)
  assert.equal(summary.fp, 0)
  assert.equal(summary.fn, 0)
  assert.equal(summary.precision, 1)
  assert.equal(summary.recall, 1)
  assert.equal(summary.invalid, 0)
})

test('hallucinated evidence fails the fixture and cannot count as successful evaluation', async () => {
  const fixture = {
    id:'ptr-1', filename:'src/p.c', patch:'@@ -1 +1 @@\n-return 0;\n+return *ptr;\n',
    expected:[{line:1,rule_id:'NULL_DEREF'}],
    mock_response:{version:1,hunks:[{id:'h0',status:'issues',findings:[
      {line:1,rule_id:'NULL_DEREF',severity:'high',message:'Pointer may be null.',evidence:'invented();'}
    ]}]}
  }
  await assert.rejects(
    runEvaluationSuite([fixture], async input => JSON.stringify(input.mock_response)),
    /evidence/i
  )
})

test('duplicate fixture IDs fail rather than distort aggregate metrics', async () => {
  const a = {id:'same',patch:'@@ -1 +1 @@\n-a\n+b\n',expected:[]}
  await assert.rejects(runEvaluationSuite([a,a], async () => '{"version":1,"hunks":[{"id":"h0","status":"clean","findings":[]}]}'), /duplicate/i)
})

test('OpenAI Responses adapter uses POST, returns completed output and disables storage', async () => {
  const observed = []
  const reply = await requestModelResponse({
    prompt:'hello', apiKey:'test-secret-key', model:'test-model',
    fetcher: async (url, init) => {
      observed.push({url, init})
      return {ok:true,status:200,json:async()=>({status:'completed',output:[
        {type:'message',content:[{type:'output_text',text:'{"version":1,"hunks":[]}'}]}
      ]})}
    }
  })
  assert.equal(reply, '{"version":1,"hunks":[]}')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(observed[0].init.method, 'POST')
  assert.equal(observed[0].init.headers.authorization, 'Bearer test-secret-key')
  assert.equal(JSON.parse(observed[0].init.body).store, false)
})

test('Responses adapter fails closed on HTTP and incomplete outputs without leaking response content', async () => {
  const options={prompt:'hello',apiKey:'private-token',model:'test-model'}
  await assert.rejects(requestModelResponse({...options,fetcher: async()=>({ok:false,status:429})}), /HTTP 429/)
  await assert.rejects(requestModelResponse({...options,fetcher: async()=>({ok:true,status:200,json:async()=>({status:'incomplete',output:[]})})}), /incomplete|completed/i)
  await assert.rejects(requestModelResponse({...options,fetcher: async()=>({ok:true,status:200,json:async()=>({status:'completed',output:[]})})}), /empty|missing/i)
})

test('no API secret means zero outgoing HTTP requests', async () => {
  let requests=0
  await assert.rejects(requestModelResponse({
    prompt:'hello',apiKey:'',model:'test-model',
    fetcher:async()=>{requests++;throw new Error('should not send')}
  }), /API key|credential/i)
  assert.equal(requests, 0)
})

test('bench fixtures contain both positive and clean embedded C examples', () => {
  const entries=JSON.parse(readFileSync(new URL('./fixtures/embedded-c-review.json',import.meta.url),'utf8'))
  assert.ok(entries.length>=3)
  assert.ok(entries.some(x=>x.expected.length===0))
  assert.ok(entries.some(x=>x.expected.some(y=>y.rule_id==='DIV_ZERO')))
  assert.ok(entries.some(x=>x.expected.some(y=>y.rule_id==='NULL_DEREF')))
})
