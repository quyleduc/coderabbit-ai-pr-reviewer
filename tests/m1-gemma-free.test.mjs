import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {TokenLimits} from '../src/limits.ts'
import {requestModelResponse} from '../scripts/controlled-model-eval.mjs'
import {requestResponsesText} from '../src/responses-client.ts'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {processStructuredReview} from '../src/review-protocol.ts'

const model = 'google/gemma-4-31b-it:free'
const validResponse = {status:'completed',output:[{
  type:'message',content:[{type:'output_text',text:JSON.stringify({version:1,hunks:[
    {id:'h0',status:'issues',findings:[{
      line:2,rule_id:'DIV_ZERO',severity:'high',
      message:'Removing this guard allows a zero divisor and undefined behavior.',
      evidence:'return numerator / divisor;'
    }]}]})}]
}]}
const fixtureDiff='@@ -1,3 +1,3 @@\n int safe_divide(int numerator, int divisor) {\n-  return divisor != 0 ? numerator / divisor : 0;\n+  return numerator / divisor;\n }\n'
const ok = data => ({ok:true,status:200,json:async()=>data})

test('M1 free Gemma model has enough bounded output budget for a structured review',()=>{
  const limits=new TokenLimits(model)
  assert.equal(limits.maxTokens,20000)
  assert.equal(limits.responseTokens,4096)
  assert.ok(limits.requestTokens>12000)
  assert.ok(limits.requestTokens<limits.maxTokens-limits.responseTokens)
  assert.equal(new TokenLimits('gpt-6-luna').responseTokens,3000)
})

test('Gemma free model response can pass the real source-backed review protocol',async()=>{
  const response=await requestModelResponse({
    provider:'openrouter',apiKey:'fixture-only-secret',model,
    prompt:'Review this C patch',reasoningEffort:'omit',
    fetcher:async(url,init)=>{
      assert.equal(url,'https://openrouter.ai/api/v1/responses')
      const payload=JSON.parse(init.body)
      assert.equal(payload.model,model)
      assert.equal(payload.reasoning,undefined)
      assert.equal(payload.store,false)
      return ok(validResponse)
    }
  })
  const changed=buildChangedLineIndex(fixtureDiff)
  const result=processStructuredReview(response,changed,fixtureDiff,1)
  assert.equal(result.comments.length,1)
  assert.equal(result.comments[0].startLine,2)
  assert.match(result.comments[0].message,/DIV_ZERO/)
})

test('the selected OpenRouter model omits reasoning by default only for that non-reasoning M1 preset',async()=>{
  let requests=[]
  for(const selected of [model,'nvidia/nemotron-3-ultra-550b-a55b:free']){
    await requestModelResponse({
      provider:'openrouter',apiKey:'fixture-only-secret',model:selected,
      prompt:'Review one C patch',
      fetcher:async(_url,init)=>{requests.push(JSON.parse(init.body));return ok(validResponse)}
    })
  }
  assert.equal(requests[0].reasoning,undefined)
  assert.deepEqual(requests[1].reasoning,{effort:'low'})
})

test('Gemma free preset leaves the generic OpenAI Responses transport unchanged',async()=>{
  let sent
  await requestResponsesText({apiKey:'fixture-only-secret',model:'gpt-4.1-mini',prompt:'hello',
    fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return ok(validResponse)}
  })
  assert.equal(sent.reasoning,undefined)
  assert.equal(sent.max_output_tokens,2048)
})

test('trusted workflows target the free M1 preset but retain explicit opt-in and never publish automatically',()=>{
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8')
  const workflow=read('.github/workflows/openai-review.yml')
  const evalWorkflow=read('.github/workflows/controlled-live-eval.yml')
  assert.match(workflow,/vars\.ENABLE_AUTOMATED_PR_REVIEWS == 'true'/)
  assert.match(workflow,/google\/gemma-4-31b-it:free/)
  assert.match(workflow,/vars\.LLM_PROVIDER \|\| 'openai'/)
  assert.match(evalWorkflow,/model:[\s\S]*required: true[\s\S]*type: string/)
  assert.doesNotMatch(evalWorkflow,/default: google\/gemma-4-31b-it:free/)
  assert.match(evalWorkflow,/reasoning_effort:/)
  assert.match(evalWorkflow,/options: \[auto, omit, none, low, medium, high\]/)
  assert.match(evalWorkflow,/default: omit/)
  assert.match(read('scripts/controlled-model-eval.mjs'),/['"]omit['"]/)
  const acceptanceWorkflow=read('.github/workflows/controlled-live-pr-acceptance.yml')
  assert.match(acceptanceWorkflow,/model:[\s\S]*required: true[\s\S]*type: string/)
  assert.doesNotMatch(acceptanceWorkflow,/default: google\/gemma-4-31b-it:free/)
  assert.doesNotMatch(read('action.yml'),/trained by OpenAI/)
  assert.match(read('docs/M1_GEMMA_FREE_BASELINE.md'),/LIVE_MODEL_EVAL_ONLY/)
})
