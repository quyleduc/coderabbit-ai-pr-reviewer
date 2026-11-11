import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {splitPatch, patchStartEndLine, parsePatch} from '../src/diff-hunks.ts'

test('implicit count defaults to one', () => {
  assert.deepEqual(patchStartEndLine('@@ -1 +1 @@\n-a\n+b\n'), {
    oldHunk: {startLine: 1, endLine: 1},
    newHunk: {startLine: 1, endLine: 1}
  })
})

test('explicit counts remain correct', () => {
  assert.deepEqual(patchStartEndLine('@@ -2,3 +7,5 @@ f()\n'), {
    oldHunk: {startLine: 2, endLine: 4},
    newHunk: {startLine: 7, endLine: 11}
  })
})

test('mixed implicit and explicit counts', () => {
  assert.deepEqual(patchStartEndLine('@@ -12 +14,2 @@\n'), {
    oldHunk: {startLine: 12, endLine: 12},
    newHunk: {startLine: 14, endLine: 15}
  })
  assert.deepEqual(patchStartEndLine('@@ -12,2 +14 @@\n'), {
    oldHunk: {startLine: 12, endLine: 13},
    newHunk: {startLine: 14, endLine: 14}
  })
})

test('zero counts represent empty side', () => {
  assert.deepEqual(patchStartEndLine('@@ -0,0 +1,2 @@\n'), {
    oldHunk: {startLine: 0, endLine: -1},
    newHunk: {startLine: 1, endLine: 2}
  })
  assert.deepEqual(patchStartEndLine('@@ -3,2 +2,0 @@\n'), {
    oldHunk: {startLine: 3, endLine: 4},
    newHunk: {startLine: 2, endLine: 1}
  })
})

test('splitPatch handles multiple mixed headers and function context', () => {
  const patch = '@@ -1 +1 @@ fun\n-old\n+new\n@@ -5,2 +5,3 @@\n a\n+b\n c\n'
  const parts = splitPatch(patch)
  assert.equal(parts.length, 2)
  assert.match(parts[0], /^@@ -1 \+1 @@ fun/)
  assert.match(parts[1], /^@@ -5,2 \+5,3 @@/)
})

test('splitPatch accepts CRLF and no patch', () => {
  assert.equal(splitPatch('@@ -1 +1 @@\r\n-a\r\n+b\r\n').length, 1)
  assert.deepEqual(splitPatch(null), [])
  assert.deepEqual(splitPatch(''), [])
})

test('parsePatch assigns valid added-line numbers', () => {
  const parsed = parsePatch('@@ -4,2 +4,3 @@\n first\n-old\n+new\n+added\n')
  assert.ok(parsed)
  assert.match(parsed.newHunk, /5: new/)
  assert.match(parsed.newHunk, /6: added/)
})

test('parsePatch ignores no-newline sentinel as a line', () => {
  const parsed = parsePatch('@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n')
  assert.ok(parsed)
  assert.equal(parsed.newHunk, '1: after')
})

test('invalid hunk rejected', () => {
  assert.equal(patchStartEndLine('not-a-hunk'), null)
  assert.equal(parsePatch('not-a-hunk'), null)
  assert.deepEqual(splitPatch('not-a-hunk'), [])
})

test('git-generated implicit-count diff is recognized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderabbit-diff-'))
  try {
    const before = join(dir, 'before.txt')
    const after = join(dir, 'after.txt')
    writeFileSync(before, 'alpha\n')
    writeFileSync(after, 'beta\n')
    let diff = ''
    try {
      diff = execFileSync('git', ['diff', '--no-index', '-U0', before, after], {encoding: 'utf8'})
    } catch (e) {
      if (e.status !== 1) throw e
      diff = e.stdout
    }
    assert.match(diff, /@@ -1 \+1 @@/)
    assert.equal(splitPatch(diff).length, 1)
    assert.equal(patchStartEndLine(splitPatch(diff)[0]).newHunk.startLine, 1)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
