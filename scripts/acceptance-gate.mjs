import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {verifyPullRequestPatch} from '../src/pr-files.ts'

/**
 * Constrain live GitHub writes to one manually-authorized acceptance PR.
 * This is a target authorization check, not an LLM quality assessment.
 */

export const ACCEPTANCE_MARKER = '<!-- coderabbit:acceptance-target-v1 -->'

export function validateAcceptanceTarget(
  request,
  target,
  files
) {
  const sha = /^[a-f0-9]{40}$/i
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(request.repository) ||
      request.defaultBranch !== 'main' ||
      !Number.isSafeInteger(request.pullNumber) || request.pullNumber < 1 ||
      !sha.test(request.expectedHead) || !sha.test(request.expectedBase) ||
      request.expectedHead === request.expectedBase) {
    throw new Error('Invalid acceptance repository or immutable SHA scope')
  }
  if (target.number !== request.pullNumber || target.state !== 'open' ||
      target.draft !== true || !target.body?.includes(ACCEPTANCE_MARKER) ||
      target.head.sha !== request.expectedHead ||
      target.base.sha !== request.expectedBase ||
      !target.head.ref.startsWith('acceptance/') ||
      target.base.ref !== request.defaultBranch ||
      target.head.repo?.full_name !== request.repository ||
      target.base.repo?.full_name !== request.repository) {
    throw new Error('Acceptance target or PR head/base scope not authorized')
  }
  if (!Array.isArray(files) || files.length !== 1 ||
      target.changed_files !== 1) {
    throw new Error('Acceptance PR must change exactly one file')
  }
  const file = files[0]
  if (!/^tests\/acceptance\/[a-z0-9_-]+\.c$/i.test(file.filename) ||
      !['added', 'modified'].includes(file.status)) {
    throw new Error('Acceptance file path/status not allowed')
  }
  verifyPullRequestPatch(file)
  const parsed = buildChangedLineIndex(file.patch)
  if (!parsed.valid || parsed.hunks.length !== 1) {
    throw new Error('Acceptance diff needs exactly one valid hunk')
  }
  const addedLines = parsed.hunks[0].addedLines
  if (addedLines.length === 0) {
    throw new Error('Acceptance diff requires a new/right-side line')
  }
  return {
    repository: request.repository,
    pullNumber: target.number,
    headSha: request.expectedHead,
    baseSha: request.expectedBase,
    path: file.filename,
    diff: file.patch,
    addedLines
  }
}

/** Scope marker allows replay detection even if a model paraphrases a finding. */
export function acceptanceScopeMarker(scope) {
  return '<!-- coderabbit:acceptance-live-v1:' +
    scope.baseSha + ':' + scope.headSha + ':' + scope.path + ' -->'
}

/** No state/checkpoint mutation is allowed unless publishing was confirmed. */
export async function commitAcceptanceCheckpoint(publisherAcknowledged,write) {
  if (!publisherAcknowledged) {
    throw new Error('Publication unconfirmed: cannot commit acceptance checkpoint')
  }
  return write()
}
