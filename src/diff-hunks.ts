/**
 * Pure unified-diff helpers. No GitHub Actions or OpenAI dependencies, so
 * PR coordinate handling can be regression-tested without external services.
 */
export interface HunkRange {
  startLine: number
  endLine: number
}

export interface HunkLines {
  oldHunk: HunkRange
  newHunk: HunkRange
}

// Unified-diff counts default to one when omitted: "@@ -5 +5 @@" is valid.
// Counts of zero are also valid, for additions/deletions.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const HUNK_HEADER_GLOBAL = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\n]*$/gm

export const splitPatch = (patch: string | null | undefined): string[] => {
  if (!patch) return []

  const starts: number[] = []
  // RegExp must be fresh for each call: avoid lastIndex state leakage.
  const matcher = new RegExp(HUNK_HEADER_GLOBAL.source, HUNK_HEADER_GLOBAL.flags)
  let match: RegExpExecArray | null
  while ((match = matcher.exec(patch)) !== null) {
    starts.push(match.index)
  }
  return starts.map((start, i) =>
    patch.substring(start, i + 1 < starts.length ? starts[i + 1] : patch.length)
  )
}

export const patchStartEndLine = (patch: string): HunkLines | null => {
  const match = HUNK_HEADER.exec(patch)
  if (!match) return null

  const oldStart = Number(match[1])
  const oldCount = Number(match[2] ?? '1')
  const newStart = Number(match[3])
  const newCount = Number(match[4] ?? '1')

  return {
    oldHunk: {startLine: oldStart, endLine: oldStart + oldCount - 1},
    newHunk: {startLine: newStart, endLine: newStart + newCount - 1}
  }
}

export const parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const hunkInfo = patchStartEndLine(patch)
  if (!hunkInfo) return null

  const oldHunkLines: string[] = []
  const newHunkLines: string[] = []
  let newLine = hunkInfo.newHunk.startLine

  const lines = patch.split('\n').slice(1)
  if (lines[lines.length - 1] === '') lines.pop()

  // This marker is metadata about the preceding line, not a source line.
  const contentLines = lines.filter(line => !line.startsWith('\\'))
  const skipStart = 3
  const skipEnd = 3
  const removalOnly = !contentLines.some(line => line.startsWith('+'))

  for (const [index, line] of contentLines.entries()) {
    const currentLine = index + 1
    if (line.startsWith('-')) {
      oldHunkLines.push(line.substring(1))
    } else if (line.startsWith('+')) {
      newHunkLines.push(newLine + ': ' + line.substring(1))
      newLine++
    } else if (line.startsWith(' ')) {
      oldHunkLines.push(line)
      if (
        removalOnly ||
        (currentLine > skipStart && currentLine <= contentLines.length - skipEnd)
      ) {
        newHunkLines.push(newLine + ': ' + line)
      } else {
        newHunkLines.push(line)
      }
      newLine++
    }
  }

  return {oldHunk: oldHunkLines.join('\n'), newHunk: newHunkLines.join('\n')}
}


/**
 * Exact changed-line index for GitHub PR review anchors, inspired by
 * reviewdog's diff-filter. All coordinates refer to the new/right side.
 *
 * A malformed, truncated or binary patch is invalid, never silently treated
 * as complete. Consumers must not publish unvalidated inline coordinates.
 */
export interface ChangedHunk {
  startLine: number
  endLine: number
  addedLines: number[]
}

export type ChangedLineIndex =
  | {valid: true; hunks: ChangedHunk[]}
  | {valid: false; reason: string; hunks: []}

export const buildChangedLineIndex = (patch: string): ChangedLineIndex => {
  const hunks = splitPatch(patch)
  if (hunks.length === 0) {
    return {valid: false, reason: 'no_hunks', hunks: []}
  }

  const indexed: ChangedHunk[] = []
  for (const hunk of hunks) {
    const range = patchStartEndLine(hunk)
    if (!range) return {valid: false, reason: 'invalid_header', hunks: []}

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk)
    if (!header) return {valid: false, reason: 'invalid_header', hunks: []}
    const oldCount = Number(header[2] ?? '1')
    const newCount = Number(header[4] ?? '1')
    let oldSeen = 0
    let newSeen = 0
    let newCursor = range.newHunk.startLine
    const addedLines: number[] = []

    const lines = hunk.split(/\r?\n/).slice(1)
    if (lines[lines.length - 1] === '') lines.pop()

    for (const line of lines) {
      if (line.startsWith('\\')) {
        // Only Git's no-newline sentinel is accepted as diff metadata.
        if (!/^\\ No newline at end of file$/.test(line)) {
          return {valid: false, reason: 'invalid_metadata', hunks: []}
        }
      } else if (line.startsWith('+')) {
        addedLines.push(newCursor)
        newCursor++
        newSeen++
      } else if (line.startsWith('-')) {
        oldSeen++
      } else if (line.startsWith(' ')) {
        oldSeen++
        newSeen++
        newCursor++
      } else {
        return {valid: false, reason: 'invalid_hunk_body', hunks: []}
      }
    }
    if (
      oldSeen !== oldCount ||
      newSeen !== newCount ||
      !Number.isSafeInteger(newCursor)
    ) {
      return {valid: false, reason: 'hunk_count_mismatch', hunks: []}
    }
    indexed.push({
      startLine: range.newHunk.startLine,
      endLine: range.newHunk.endLine,
      addedLines
    })
  }
  return {valid: true, hunks: indexed}
}

export type ReviewAnchor =
  | {valid: true; startLine: number; endLine: number; adjusted: boolean}
  | {valid: false; reason: string}

/**
 * Require the model's original range to be within ONE hunk and contain a
 * changed line. When it includes context, conservatively anchor a single
 * changed line WITHIN the original requested range, never a distant hunk.
 */
export const resolveReviewAnchor = (
  index: ChangedLineIndex,
  startLine: number,
  endLine: number
): ReviewAnchor => {
  if (!index.valid) return {valid: false, reason: 'invalid_diff'}
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return {valid: false, reason: 'invalid_line_range'}
  }
  const hunk = index.hunks.find(
    h => startLine >= h.startLine && endLine <= h.endLine
  )
  if (!hunk) return {valid: false, reason: 'outside_hunk'}
  const changed = hunk.addedLines.filter(
    line => line >= startLine && line <= endLine
  )
  if (!changed.length) return {valid: false, reason: 'unchanged_line'}
  if (changed.length === endLine - startLine + 1) {
    return {valid: true, startLine, endLine, adjusted: false}
  }
  const anchor = changed[changed.length - 1]
  return {valid: true, startLine: anchor, endLine: anchor, adjusted: true}
}
