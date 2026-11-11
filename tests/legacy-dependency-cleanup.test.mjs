import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const pack = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

test('legacy client and no-longer-used network/retry packages are not direct dependencies',()=>{
  for(const name of ['node-fetch','p-retry']) {
    assert.equal(pack.dependencies?.[name],undefined)
    assert.equal(lock.packages[''].dependencies?.[name],undefined)
  }
  assert.equal(pack.devDependencies?.chatgpt,undefined)
  assert.equal(lock.packages[''].devDependencies?.chatgpt,undefined)
})

test('lockfile root dependency versions match package manifest',()=>{
  assert.deepEqual(lock.packages[''].dependencies,pack.dependencies)
  assert.deepEqual(lock.packages[''].devDependencies,pack.devDependencies)
})
