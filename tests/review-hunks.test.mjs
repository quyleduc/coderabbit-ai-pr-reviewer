import test from 'node:test'
import assert from 'node:assert/strict'
import {HunkCoverage, hunkIndexForRange, hunkUnitId} from '../src/review-hunks.ts'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {assessReviewCompletion} from '../src/review-integrity.ts'

const assess = (units, acknowledged) => {
  const snapshot = units.snapshot()
  return assessReviewCompletion(snapshot.expectedIds, snapshot.entries, acknowledged)
}

test('two hunks need two explicit acknowledgments, even within one file', () => {
  const units = new HunkCoverage()
  units.registerFile('main.c', 2)
  units.mark('main.c', 0, 'reviewed')
  assert.equal(assess(units,true).complete, false)
  assert.equal(assess(units,true).blockers.length, 1)
  units.mark('main.c', 1, 'reviewed')
  assert.equal(assess(units,true).complete, true)
  assert.equal(assess(units,false).complete, false)
})

test('every packed but unacknowledged hunk is a hard analysis failure', () => {
  const units = new HunkCoverage()
  units.registerFile('driver.c', 3)
  units.markPacked('driver.c', 2)
  units.mark('driver.c', 0, 'reviewed')
  units.markUnacknowledged('driver.c', 2)
  assert.equal(units.get('driver.c', 0), 'reviewed')
  assert.equal(units.get('driver.c', 1), 'failed_analysis')
  assert.equal(units.get('driver.c', 2), 'blocked_by_budget')
  assert.equal(assess(units,true).complete, false)
})

test('trivial/file exclusions have explicit per-hunk coverage', () => {
  const units = new HunkCoverage()
  units.registerFile('doc.c', 2)
  units.markFile('doc.c', 'triaged_trivial')
  assert.equal(assess(units,true).complete, true)
})

test('failed analysis cannot be overwritten by a late success', () => {
  const units = new HunkCoverage()
  units.registerFile('x.c', 1)
  units.mark('x.c', 0, 'failed_analysis')
  units.mark('x.c', 0, 'reviewed')
  assert.equal(units.get('x.c', 0), 'failed_analysis')
})

test('invalid hunk ids and missing registration fail closed', () => {
  const units = new HunkCoverage()
  assert.throws(() => units.registerFile('x.c', 0))
  assert.throws(() => units.mark('x.c', 0, 'reviewed'))
  assert.throws(() => units.markPacked('x.c', 1))
  units.registerFile('x.c', 2)
  assert.throws(() => units.markPacked('x.c', 3))
  assert.throws(() => units.registerFile('x.c', 2))
  assert.equal(units.size, 2)
  assert.equal(hunkUnitId('x.c', 1), '["x.c",1]')
})

test('model result can acknowledge only its original changed hunk', () => {
  const idx = buildChangedLineIndex(
    '@@ -1 +1 @@\n-a\n+b\n@@ -8 +8 @@\n-c\n+d\n'
  )
  assert.equal(hunkIndexForRange(idx, 1, 1), 0)
  assert.equal(hunkIndexForRange(idx, 8, 8), 1)
  assert.equal(hunkIndexForRange(idx, 1, 8), null)
  assert.equal(hunkIndexForRange(idx, 3, 3), null)
  assert.equal(hunkIndexForRange(idx, -1, 1), null)
})
