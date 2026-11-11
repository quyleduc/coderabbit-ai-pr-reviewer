import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {requestResponsesText} from '../src/responses-client.ts'

const done = (text='Review complete.') => ({
  status: 'completed',
  output: [{type: 'message', status: 'completed',
    content: [{type: 'output_text', text}]}]
})
const mockResponse = (body, status=200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body
})

const base = {
  apiKey: 'test-secret-value',
  model: 'gpt-4.1-mini',
  prompt: 'Review this C patch',
  systemMessage: 'Follow JSON protocol'
}

test('production Responses adapter uses stateless POST with privacy and bounded output', async () => {
  const calls = []
  const text = await requestResponsesText({
    ...base, maxOutputTokens: 2048,
    fetcher: async (url, init) => {
      calls.push({url, init})
      return mockResponse(done('{"version":1,"hunks":[]}'))
    }
  })
  assert.equal(text, '{"version":1,"hunks":[]}')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-secret-value')
  const payload = JSON.parse(calls[0].init.body)
  assert.equal(payload.store, false)
  assert.equal(payload.max_output_tokens, 2048)
  assert.equal(payload.model, base.model)
  assert.equal(payload.instructions, base.systemMessage)
  assert.equal(payload.input[0].content, base.prompt)
  assert.equal(payload.previous_response_id, undefined)
  assert.equal(payload.temperature, undefined)
})

test('extracts all text blocks and does not print provider response on errors', async () => {
  const result = await requestResponsesText({
    ...base,
    fetcher: async () => mockResponse({status:'completed',output:[
      {type:'reasoning',summary:[]},
      {type:'message',content:[{type:'output_text',text:'first'}, {type:'output_text',text:' second'}]}
    ]})
  })
  assert.equal(result, 'first second')
  for (const body of [
    {status:'incomplete', output: []},
    {status:'failed', output: []},
    {status:'completed', output: []},
    {status:'completed', output: [{type:'message',content:[{type:'refusal',refusal:'No'}]}]}
  ]) {
    await assert.rejects(
      requestResponsesText({...base,fetcher:async()=>mockResponse(body)}),
      /response|incomplete|empty|refusal/i
    )
  }
})

test('retries 429 and 5xx with bounded delay, never sends more than configured attempts', async () => {
  const statuses = [429,503,200]
  const delays=[]
  const attempts=[]
  const out=await requestResponsesText({
    ...base,retries:2,
    delay:async ms=>{delays.push(ms)},
    fetcher:async()=> {
      attempts.push(1)
      const status=statuses.shift()
      return mockResponse(status===200?done('OK'):{error:{message:'untrusted API error',secret:base.apiKey}},status)
    }
  })
  assert.equal(out,'OK')
  assert.equal(attempts.length,3)
  assert.equal(delays.length,2)
  assert.ok(delays.every(x=>x>0 && x<=10000))
})

test('authentication and invalid request errors fail immediately, never retry or leak body', async () => {
  for(const status of [400,401,403,404,422]){
    let calls=0
    await assert.rejects(
      requestResponsesText({...base,retries:4,fetcher:async()=>{
        calls++
        return mockResponse({error:{message:'PROMPT_TEST_KEY_secret must never be echoed'}},status)
      }}),
      error=> !String(error).includes('PROMPT_TEST_KEY_secret') && /HTTP/.test(String(error))
    )
    assert.equal(calls,1)
  }
})

test('retry budget exhaustion returns safe error instead of leaking model source', async () => {
  let calls=0
  await assert.rejects(
    requestResponsesText({...base,retries:2,delay:async()=>{},fetcher:async()=>{
      calls++
      throw new Error('provider error leaked content: '+base.apiKey+' review this source')
    }}),
    error => /request failed/i.test(String(error)) && !String(error).includes(base.apiKey) &&
      !String(error).includes('review this source')
  )
  assert.equal(calls,3)
})

test('rejects empty prompt, missing key, invalid model and insecure remote URL before any request', async () => {
  let calls=0
  const fetcher=async()=>{calls++;return mockResponse(done())}
  for (const invalid of [
    {...base,apiKey:''},
    {...base,prompt:' '},
    {...base,model:''},
    {...base,apiBaseUrl:'http://attacker.example/v1'},
    {...base,apiBaseUrl:'https://safe.example/v1#fragment'},
    {...base,retries:-1},
    {...base,maxOutputTokens:0},
    {...base,timeoutMs:0}
  ]) {
    await assert.rejects(requestResponsesText({...invalid,fetcher}), /invalid|missing|unsafe|key|prompt|model|retry|timeout|output/i)
  }
  assert.equal(calls,0)
})

test('preserves configurable HTTPS proxy and optional OpenAI org header', async () => {
  const calls=[]
  await requestResponsesText({
    ...base,apiBaseUrl:'https://compatible.example/v1/',
    apiOrg:'org-example',
    fetcher:async(url,init)=>{calls.push({url,init});return mockResponse(done())}
  })
  assert.equal(calls[0].url,'https://compatible.example/v1/responses')
  assert.equal(calls[0].init.headers['openai-organization'],'org-example')
})

test('benchmark and production both use one Responses API core rather than separate request implementations',()=>{
  const evaluator=readFileSync(new URL('../scripts/controlled-model-eval.mjs',import.meta.url),'utf8')
  const bot=readFileSync(new URL('../src/bot.ts',import.meta.url),'utf8')
  assert.match(evaluator,/requestResponsesText\(/)
  assert.match(bot,/requestResponsesText\(/)
  assert.doesNotMatch(bot,/from 'chatgpt'/)
  assert.doesNotMatch(bot,/new ChatGPTAPI\(/)
  assert.match(bot,/return \[responseText, \{\}\]/)
})
