import test from 'node:test'
import assert from 'node:assert/strict'
import {validateAcceptanceTarget, acceptanceScopeMarker, commitAcceptanceCheckpoint} from '../scripts/acceptance-gate.mjs'

const SHA_A='a'.repeat(40), SHA_B='b'.repeat(40)
const PATCH='@@ -1,3 +1,3 @@\n int sensor(const int *ptr) {\n-  return 0;\n+  return *ptr;\n }\n'
const pull = (override={}) => ({
  number: 42,
  state:'open',
  draft:true,
  body:'<!-- coderabbit:acceptance-target-v1 -->',
  head:{sha:SHA_A,ref:'acceptance/null-pointer',repo:{full_name:'quyleduc/coderabbit-ai-pr-reviewer'}},
  base:{sha:SHA_B,ref:'main',repo:{full_name:'quyleduc/coderabbit-ai-pr-reviewer'}},
  changed_files:1,
  ...override
})
const options={
  repository:'quyleduc/coderabbit-ai-pr-reviewer',
  defaultBranch:'main',
  pullNumber:42,
  expectedHead:SHA_A,
  expectedBase:SHA_B
}
const file={filename:'tests/acceptance/known-defect.c',status:'modified',patch:PATCH,additions:1,deletions:1}

test('allows exactly one dedicated C acceptance change at pinned head/base in same repo',()=>{
  const value=validateAcceptanceTarget(options,pull(),[file])
  assert.equal(value.path,file.filename)
  assert.equal(value.headSha,SHA_A)
  assert.equal(value.baseSha,SHA_B)
  assert.equal(value.addedLines.length,1)
  assert.deepEqual(value.addedLines,[2])
  assert.match(acceptanceScopeMarker(value),/coderabbit:acceptance-live-v1/)
})

test('rejects wrong repository, fork, branch prefix or base before LLM and publishing',()=>{
  const variants=[
    [ {...options,repository:'quyleduc/different'} ,pull(),[file]],
    [ options,pull({number:43}),[file]],
    [ options,pull({head:{sha:SHA_A,ref:'feature/pr',repo:{full_name:options.repository}}}),[file]],
    [ options,pull({head:{sha:SHA_A,ref:'acceptance/defect',repo:{full_name:'attacker/fork'}}}),[file]],
    [ options,pull({base:{sha:SHA_B,ref:'stable',repo:{full_name:options.repository}}}),[file]],
    [ options,pull({head:{sha:SHA_B,ref:'acceptance/defect',repo:{full_name:options.repository}}}),[file]],
    [ options,pull({base:{sha:SHA_A,ref:'main',repo:{full_name:options.repository}}}),[file]],
    [ options,pull({state:'closed'}),[file]],
    [ options,pull({draft:false}),[file]],
    [ options,pull({body:'no acceptance marker'}),[file]]
  ]
  for(const [args,meta,files] of variants){
    assert.throws(()=>validateAcceptanceTarget(args,meta,files),/acceptance|scope|repository|SHA|branch|marker|target|draft|open/i)
  }
})

test('fails closed on multiple files, binary, outside acceptance folder, metadata gaps, malformed diff',()=>{
  for(const files of [
    [],
    [file,{...file,filename:'tests/acceptance/other.c'}],
    [{...file,filename:'src/production.c'}],
    [{...file,filename:'tests/acceptance/exploit.sh'}],
    [{...file,patch:undefined}],
    [{...file,additions:2}],
    [{...file,patch:'@@ -1 +1 @@\n-old\n'}],
    [{...file,status:'renamed'}]
  ]){
    assert.throws(()=>validateAcceptanceTarget(options,pull(),files),/file|patch|diff|scope|accepted|metadata|changed|missing|status|count/i)
  }
})

test('acceptance scope marker changes on either head or base to block stale replays',()=>{
  const a=validateAcceptanceTarget(options,pull(),[file])
  const newHead='c'.repeat(40)
  const b=validateAcceptanceTarget({...options,expectedHead:newHead},pull({
    head:{sha:newHead,ref:'acceptance/null-pointer',repo:{full_name:options.repository}}
  }),[file])
  assert.notEqual(acceptanceScopeMarker(a),acceptanceScopeMarker(b))
})

test('acceptance checkpoint is never written before publisher acknowledgement',async()=>{
  let writes=0
  const record=async()=>{writes++;return {id:5}}
  await assert.rejects(commitAcceptanceCheckpoint(false,record),/publication|unconfirmed/i)
  assert.equal(writes,0)
  await commitAcceptanceCheckpoint(true,record)
  assert.equal(writes,1)
})
