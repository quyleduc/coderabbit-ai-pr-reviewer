import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {requestResponsesText} from '../src/responses-client.ts'
import {classifyEvaluationFailure} from '../scripts/controlled-model-eval.mjs'

const base = {apiKey:'sk-test-private', model:'nvidia/nemotron-3-ultra-550b-a55b:free', prompt:'Review one C hunk'}
const success = value => ({ok:true,status:200,json:async()=>value})
const root = output => ({status:'completed', output})

test('accepts documented response-level output_text when output items carry no message text', async()=>{
  const result=await requestResponsesText({...base,fetcher:async()=>success({
    ...root([]), output_text:'{"version":1,"hunks":[]}'
  })})
  assert.equal(result,'{"version":1,"hunks":[]}')
})

test('uses message content over response-level convenience field when both are provided', async()=>{
  const result=await requestResponsesText({...base,fetcher:async()=>success({
    ...root([{type:'message',content:[{type:'output_text',text:'verified'}]}]),
    output_text:'untrusted duplicated content'
  })})
  assert.equal(result,'verified')
})

test('never treats reasoning text, tool calls or blank output as final review',async()=>{
  const cases=[
    [root([{type:'reasoning',summary:[{type:'summary_text',text:'secret prompt and reasoning'}]}]), 'RESPONSE_REASONING_ONLY'],
    [root([]),'RESPONSE_NO_ITEMS'],
    [root([{type:'function_call',name:'unsafe',arguments:'{}'}]),'RESPONSE_NO_MESSAGE'],
    [root([{type:'message',content:[{type:'output_text',text:'   '}]}]),'RESPONSE_EMPTY']
  ]
  for(const [body,code] of cases){
    let calls=0
    await assert.rejects(
      requestResponsesText({...base,retries:0,fetcher:async()=>{calls++;return success(body)}}),
      e=>classifyEvaluationFailure(e,'model_request',1).reason===code &&
        !String(e).includes('secret prompt') && !String(e).includes('sk-test-private')
    )
    assert.equal(calls,1)
  }
})

test('rejects response-level text on non-completed responses and excessively long text',async()=>{
  await assert.rejects(requestResponsesText({...base,fetcher:async()=>success({
    status:'incomplete', output:[], output_text:'{"version":1}'
  })}),/incomplete/i)
  await assert.rejects(requestResponsesText({...base,fetcher:async()=>success({
    ...root([]),output_text:'x'.repeat(262145)
  })}),/size limit/i)
})

test('controlled single retry recovers a transient empty upstream result',async()=>{
  const calls=[]
  const result=await requestResponsesText({
    ...base,retries:1,retryEmptyOutput:true,delay:async ms=>calls.push('delay:'+ms),
    fetcher:async()=>{calls.push('request');return success(calls.filter(x=>x==='request').length===1?
      root([]) : root([{type:'message',content:[{type:'output_text',text:'valid review'}]}]))}
  })
  assert.equal(result,'valid review')
  assert.deepEqual(calls,['request','delay:1000','request'])
})

test('one retry is bounded, and empty outputs still fail closed',async()=>{
  let count=0
  await assert.rejects(requestResponsesText({
    ...base,retries:1,retryEmptyOutput:true,delay:async()=>{},
    fetcher:async()=>{count++;return success(root([]))}
  }),/response/i)
  assert.equal(count,2)
})

test('default transport never retries an empty model response',async()=>{
  let count=0
  await assert.rejects(requestResponsesText({
    ...base,retries:2,delay:async()=>{},fetcher:async()=>{count++;return success(root([]))}
  }),/response/i)
  assert.equal(count,1)
})

test('controlled fixture evaluator is explicitly configured for one bounded empty-output retry',()=>{
  const source=readFileSync(new URL('../scripts/controlled-model-eval.mjs',import.meta.url),'utf8')
  assert.match(source,/retryEmptyOutput:\s*true/)
  assert.match(source,/retries:\s*1/)
})
