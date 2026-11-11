import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {requestResponsesText} from '../src/responses-client.ts'
import {requestModelResponse} from '../scripts/controlled-model-eval.mjs'

const base = {apiKey:'sensitive-test-token',model:'google/gemma-4-31b-it:free',prompt:'Review C patch'}
const rejected = status => ({ok:false,status,json:async()=>({error:{message:'secret model response'}})})
const success = {ok:true,status:200,json:async()=>({status:'completed',output:[
  {type:'message',content:[{type:'output_text',text:'{"version":1,"hunks":[]}'}]}
]})}

test('quota-protected free requests never retry HTTP 429 even with retry budget',async()=>{
  let count=0
  await assert.rejects(requestResponsesText({
    ...base,retries:3,retryRateLimits:false,delay:async()=>{throw new Error('No delay expected')},
    fetcher:async()=>{count++;return rejected(429)}
  }),error=>{
    assert.equal(error.message,'OpenAI HTTP 429')
    assert.ok(!String(error).includes(base.apiKey))
    assert.ok(!String(error).includes('secret model response'))
    return true
  })
  assert.equal(count,1)
})

test('quota guard leaves retry for transient server errors unaffected',async()=>{
  let count=0
  const actual=await requestResponsesText({
    ...base,retries:1,retryRateLimits:false,delay:async()=>{},
    fetcher:async()=>{count++;return count===1?rejected(503):success}
  })
  assert.equal(count,2)
  assert.match(actual,/"hunks"/)
})

test('non-free existing transport 429 behavior remains backward compatible',async()=>{
  let count=0
  const actual=await requestResponsesText({
    ...base,retries:1,delay:async()=>{},
    fetcher:async()=>{count++;return count===1?rejected(429):success}
  })
  assert.equal(count,2)
  assert.match(actual,/"hunks"/)
})

test('invalid retryRateLimits value is rejected without a network call',async()=>{
  let count=0
  await assert.rejects(requestResponsesText({
    ...base,retryRateLimits:'false',fetcher:async()=>{count++;return success}
  }),/rate-limit retry/i)
  assert.equal(count,0)
})

test('controlled fixture evaluator avoids spending free quota on futile 429 retries',async()=>{
  let requests=0
  await assert.rejects(requestModelResponse({
    apiKey:base.apiKey,provider:'openrouter',model:base.model,prompt:base.prompt,
    fetcher:async()=>{requests++;return rejected(429)}
  }),/HTTP 429/)
  assert.equal(requests,1)
})

test('production Bot and controlled evaluator use same free-model-aware retry protection',()=>{
  const evaluator=readFileSync(new URL('../scripts/controlled-model-eval.mjs',import.meta.url),'utf8')
  const bot=readFileSync(new URL('../src/bot.ts',import.meta.url),'utf8')
  assert.match(evaluator,/retryRateLimits:\s*!model\.endsWith\(':free'\)/)
  assert.match(bot,/retryRateLimits:\s*!this\.openaiOptions\.model\.endsWith\(':free'\)/)
})
