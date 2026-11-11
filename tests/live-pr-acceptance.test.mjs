import test from 'node:test'
import assert from 'node:assert/strict'
import {runControlledAcceptance} from '../scripts/live-pr-acceptance.mjs'

const a='a'.repeat(40), b='b'.repeat(40)
const repo='quyleduc/coderabbit-ai-pr-reviewer'
const patch='@@ -1,3 +1,3 @@\n int sensor(const int *ptr) {\n-  return 0;\n+  return *ptr;\n }\n'
const request={repository:repo,defaultBranch:'main',pullNumber:42,expectedHead:a,expectedBase:b}
const pr={number:42,state:'open',draft:true,body:'<!-- coderabbit:acceptance-target-v1 -->',
  head:{sha:a,ref:'acceptance/null-pointer',repo:{full_name:repo}},
  base:{sha:b,ref:'main',repo:{full_name:repo}},changed_files:1}
const files=[{filename:'tests/acceptance/known-defect.c',status:'modified',patch,additions:1,deletions:1}]
const modelResponse=JSON.stringify({version:1,hunks:[{id:'h0',status:'issues',findings:[{
  line:2,rule_id:'NULL_DEREF',severity:'high',
  message:'The pointer may be null before dereference.',
  evidence:'return *ptr;'
}]}]})
const base=()=>({request,pr,files,expectedLine:2,expectedRuleId:'NULL_DEREF'})
test('preflight mode makes zero model calls and zero GitHub writes',async()=>{
  let calls=0
  const result=await runControlledAcceptance({...base(),mode:'preflight',
    model:async()=>{calls++;throw Error('model should not run')},
    writeReview:async()=>{calls++;throw Error('GitHub should not write')}
  })
  assert.equal(result.status,'preflight_ok')
  assert.equal(calls,0)
})
test('model-only validates real added source and makes zero writes',async()=>{
  let model=0,writes=0
  const result=await runControlledAcceptance({...base(),mode:'model-only',
    model:async()=>{model++;return modelResponse},
    writeReview:async()=>{writes++;throw Error('no writes')}
  })
  assert.equal(result.status,'model_validated')
  assert.equal(result.findings,1)
  assert.equal(model,1)
  assert.equal(writes,0)
})
test('publish requires confirmed GitHub review and a fresh pinned PR before checkpoint',async()=>{
  const events=[]
  const result=await runControlledAcceptance({...base(),mode:'publish',
    model:async()=>modelResponse,
    isPublished:async()=>false,
    hasPendingReview:async()=>false,
    fetchCurrent:async()=>pr,
    writeReview:async()=>{events.push('publish');return true},
    verifyPublished:async()=>{events.push('verify');return true},
    writeCheckpoint:async()=>{events.push('checkpoint');return 44}
  })
  assert.equal(result.status,'published_and_checkpointed')
  assert.deepEqual(events,['publish','verify','checkpoint'])
})
test('ambiguous publication failure does not advance checkpoint or blindly retry',async()=>{
  let count=0, checkpoints=0
  await assert.rejects(runControlledAcceptance({...base(),mode:'publish',
    model:async()=>modelResponse,
    isPublished:async()=>false,
    hasPendingReview:async()=>false,
    fetchCurrent:async()=>pr,
    writeReview:async()=>{count++;return false},
    verifyPublished:async()=>false,
    writeCheckpoint:async()=>{checkpoints++}
  }),/publication|unconfirmed/i)
  assert.equal(count,1)
  assert.equal(checkpoints,0)
})
test('unknown/changed scope after model blocks all writes',async()=>{
  let writes=0
  await assert.rejects(runControlledAcceptance({...base(),mode:'publish',
    model:async()=>modelResponse,
    isPublished:async()=>false,
    hasPendingReview:async()=>false,
    verifyPublished:async()=>false,
    fetchCurrent:async()=>({...pr,head:{...pr.head,sha:'c'.repeat(40)}}),
    writeReview:async()=>{writes++},writeCheckpoint:async()=>{writes++}
  }),/stale|scope|changed/i)
  assert.equal(writes,0)
})
test('wrong or missing findings cannot post or checkpoint',async()=>{
  let writes=0
  const clean=JSON.stringify({version:1,hunks:[{id:'h0',status:'clean',findings:[]}]})
  await assert.rejects(runControlledAcceptance({...base(),mode:'publish',
    model:async()=>clean,
    isPublished:async()=>false,
    hasPendingReview:async()=>false,
    verifyPublished:async()=>false,
    fetchCurrent:async()=>pr,
    writeReview:async()=>{writes++},writeCheckpoint:async()=>{writes++}
  }),/expected|finding|match/i)
  assert.equal(writes,0)
})
test('already published bot review does not duplicate but reconciles missing checkpoint',async()=>{
  let reviewWrites=0,checkpointWrites=0
  const result=await runControlledAcceptance({...base(),mode:'publish',
    isPublished:async()=>true,hasPendingReview:async()=>false,
    verifyPublished:async()=>true,
    model:async()=>{throw Error('no duplicate model call')},
    fetchCurrent:async()=>pr,
    writeReview:async()=>{reviewWrites++},
    writeCheckpoint:async()=>{checkpointWrites++}
  })
  assert.equal(result.status,'already_published_checkpoint_reconciled')
  assert.equal(reviewWrites,0)
  assert.equal(checkpointWrites,1)
})

test('an unverified remote review marker cannot authorize checkpoint repair',async()=>{
  let checkpointWrites=0
  await assert.rejects(runControlledAcceptance({...base(),mode:'publish',
    isPublished:async()=>true,hasPendingReview:async()=>false,
    verifyPublished:async()=>false,
    model:async()=>{throw Error('no model')},fetchCurrent:async()=>pr,
    writeReview:async()=>{throw Error('no new review')},
    writeCheckpoint:async()=>{checkpointWrites++}
  }),/verification|unconfirmed|remote/i)
  assert.equal(checkpointWrites,0)
})
test('pending bot review blocks duplicate publication',async()=>{
  let writes=0
  await assert.rejects(runControlledAcceptance({...base(),mode:'publish',
    hasPendingReview:async()=>true,isPublished:async()=>false,
    verifyPublished:async()=>false,
    model:async()=>modelResponse,
    fetchCurrent:async()=>pr,
    writeReview:async()=>{writes++},
    writeCheckpoint:async()=>{writes++}
  }),/pending/i)
  assert.equal(writes,0)
})
