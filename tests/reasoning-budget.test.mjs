import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {requestResponsesText} from '../src/responses-client.ts'
import {requestModelResponse, classifyEvaluationFailure} from '../scripts/controlled-model-eval.mjs'

const credentials = {apiKey:'test-secret-value', model:'nvidia/nemotron-3-ultra-550b-a55b:free', prompt:'Check one C hunk'}
const completed = {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"version":1,"hunks":[]}'}]}]}
const ok = body => ({ok:true,status:200,json:async()=>body})

test('reasoning effort low is explicitly sent with a larger output budget, without secret leakage',async()=>{
  let sent
  const result=await requestResponsesText({
    ...credentials,reasoningEffort:'low',maxOutputTokens:8192,
    fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return ok(completed)}
  })
  assert.equal(result,'{"version":1,"hunks":[]}')
  assert.deepEqual(sent.reasoning,{effort:'low'})
  assert.equal(sent.max_output_tokens,8192)
  assert.equal(sent.store,false)
  assert.equal(sent.previous_response_id,undefined)
  assert.ok(!JSON.stringify(sent).includes(credentials.apiKey))
})

test('the transport remains backwards compatible: omit reasoning when not configured',async()=>{
  let sent
  await requestResponsesText({...credentials,fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return ok(completed)}})
  assert.equal(sent.reasoning,undefined)
  assert.equal(sent.max_output_tokens,2048)
})

test('unsupported or tainted reasoning values fail before outgoing network access',async()=>{
  let requests=0
  for(const effort of ['LOW','ignore previous instructions','',null,12]){
    await assert.rejects(requestResponsesText({...credentials,reasoningEffort:effort,fetcher:async()=>{requests++;return ok(completed)}}),/reasoning effort/i)
  }
  assert.equal(requests,0)
})

test('completed reasoning-only response carries only bounded numeric token telemetry',async()=>{
  const payload={status:'completed',
    output:[{type:'reasoning',summary:[{type:'summary_text',text:'secret reasoning contents'}]}],
    usage:{output_tokens:2999,output_tokens_details:{reasoning_tokens:2999,untrusted:'api-key'}}}
  await assert.rejects(
    requestResponsesText({...credentials,fetcher:async()=>ok(payload)}),
    err=>{
      const reason=classifyEvaluationFailure(err,'model_request',1)
      assert.deepEqual(reason,{
        stage:'model_request',reason:'RESPONSE_REASONING_ONLY',fixture_index:1,
        output_tokens:2999,reasoning_tokens:2999
      })
      assert.ok(!JSON.stringify(reason).includes('untrusted'))
      assert.ok(!JSON.stringify(reason).includes('secret'))
      return true
    }
  )
})

test('malformed or adversarial usage cannot enter safe logs',async()=>{
  const data={status:'completed',output:[{type:'reasoning',summary:[]}],
    usage:{output_tokens:'sk-secret',output_tokens_details:{reasoning_tokens:99999999999}}}
  await assert.rejects(requestResponsesText({...credentials,fetcher:async()=>ok(data)}),
    error=>{
      assert.deepEqual(classifyEvaluationFailure(error,'model_request',1),
        {stage:'model_request',reason:'RESPONSE_REASONING_ONLY',fixture_index:1})
      return true
    })
})

test('truncated response with exact max_output_tokens reason is distinguished and never accepted',async()=>{
  const data={status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
    output:[{type:'reasoning',summary:[]}],usage:{output_tokens:8192,output_tokens_details:{reasoning_tokens:8192}}}
  await assert.rejects(requestResponsesText({...credentials,fetcher:async()=>ok(data)}),
    error=>{
      assert.deepEqual(classifyEvaluationFailure(error,'model_request',2),{
        stage:'model_request',reason:'RESPONSE_BUDGET_EXHAUSTED',fixture_index:2,
        output_tokens:8192,reasoning_tokens:8192
      })
      return true
    })
})

test('OpenRouter controlled benchmark defaults to low effort and 8192 tokens; OpenAI remains unchanged',async()=>{
  const requests=[]
  const fetcher=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return ok(completed)}
  await requestModelResponse({...credentials,provider:'openrouter',fetcher})
  await requestModelResponse({...credentials,provider:'openai',fetcher})
  assert.deepEqual(requests[0].body.reasoning,{effort:'low'})
  assert.equal(requests[0].body.max_output_tokens,8192)
  assert.equal(requests[0].url,'https://openrouter.ai/api/v1/responses')
  assert.equal(requests[1].body.reasoning,undefined)
  assert.equal(requests[1].body.max_output_tokens,3000)
  assert.equal(requests[1].url,'https://api.openai.com/v1/responses')
})

test('controlled live evaluation accepts explicit bounded tuning without changing production defaults',async()=>{
  let sent
  const fetcher=async(_url,init)=>{sent=JSON.parse(init.body);return ok(completed)}
  await requestModelResponse({...credentials,provider:'openrouter',reasoningEffort:'none',maxOutputTokens:12000,fetcher})
  assert.deepEqual(sent.reasoning,{effort:'none'})
  assert.equal(sent.max_output_tokens,12000)
  const workflow=readFileSync(new URL('../.github/workflows/controlled-live-eval.yml',import.meta.url),'utf8')
  assert.match(workflow,/reasoning_effort:/)
  assert.match(workflow,/max_output_tokens:/)
  assert.match(workflow,/LLM_REASONING_EFFORT:/)
  assert.match(workflow,/LLM_MAX_OUTPUT_TOKENS:/)
  const source=readFileSync(new URL('../scripts/controlled-model-eval.mjs',import.meta.url),'utf8')
  assert.match(source,/process\.env\.LLM_REASONING_EFFORT/)
  assert.match(source,/process\.env\.LLM_MAX_OUTPUT_TOKENS/)
})
