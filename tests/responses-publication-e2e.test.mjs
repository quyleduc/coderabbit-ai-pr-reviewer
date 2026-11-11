import test from 'node:test'
import assert from 'node:assert/strict'
import {requestResponsesText} from '../src/responses-client.ts'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {processStructuredReview} from '../src/review-protocol.ts'
import {planReviewPublication} from '../src/review-dedup.ts'
import {publishReviewBatch} from '../src/review-publication.ts'

const patch = '@@ -1,3 +1,3 @@\n int sensor_read(int *ptr) {\n-  return 0;\n+  return *ptr;\n }\n'
const index = buildChangedLineIndex(patch)
const issue = {
  version: 1,
  hunks: [{
    id: 'h0',
    status: 'issues',
    findings: [{
      line: 2,
      rule_id: 'NULL_DEREF',
      severity: 'high',
      message: 'Input pointer may be null before dereference.',
      evidence: 'return *ptr;'
    }]
  }]
}

async function fakeModel(request) {
  const calls = []
  const text = await requestResponsesText({
    apiKey: 'fake-key',
    model: 'test-model',
    prompt: 'Review sensor code',
    retries: 0,
    fetcher: async (url, options) => {
      calls.push({url, options})
      return {
        status: 200,
        ok: true,
        json: async () => ({
          status: 'completed',
          output: [{
            type: 'message',
            content: [{type: 'output_text', text: JSON.stringify(request)}]
          }]
        })
      }
    }
  })
  return {text, calls}
}

test('complete fake Responses API -> strict source validator -> dedup -> fake GitHub submit', async () => {
  const {text, calls} = await fakeModel(issue)
  const validated = processStructuredReview(text, index, patch, 1)
  const planned = planReviewPublication(
    validated.comments.map(c => ({path: 'src/sensor.c', ...c})), []
  )
  const githubCalls = []
  const result = await publishReviewBatch(planned.pending, 'a'.repeat(40),
    'Test review, no real GitHub writes', {
      createReview: async request => {githubCalls.push({kind:'create',request});return 17},
      submitReview: async (id, body) => {githubCalls.push({kind:'submit',id,body})},
      discardPendingReview: async () => {throw new Error('no cleanup needed')}
    })
  assert.deepEqual(result, {confirmed:true,kind:'submitted'})
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].options.body).store,false)
  assert.equal(githubCalls.length, 2)
  assert.equal(githubCalls[0].request.comments[0].path,'src/sensor.c')
  assert.equal(githubCalls[0].request.comments[0].line,2)
  assert.match(githubCalls[0].request.comments[0].body,/NULL_DEREF/)
  const replay=planReviewPublication(
    validated.comments.map(c => ({path:'src/sensor.c',...c})),
    planned.pending.map(c=>c.message)
  )
  assert.equal(replay.pending.length,0)
})

test('fabricated source evidence never reaches publisher',async()=>{
  const modified=structuredClone(issue)
  modified.hunks[0].findings[0].evidence='return pointer_not_in_diff;'
  let writes=0
  const {text}=await fakeModel(modified)
  await assert.rejects(async()=>{
    const verified=processStructuredReview(text,index,patch,1)
    const planned=planReviewPublication(
      verified.comments.map(c=>({path:'src/sensor.c',...c})),[]
    )
    await publishReviewBatch(planned.pending,'sha','Test',{
      createReview:async()=>{writes++;return 2},
      submitReview:async()=>{writes++},
      discardPendingReview:async()=>{writes++}
    })
  }, /evidence/)
  assert.equal(writes,0)
})
