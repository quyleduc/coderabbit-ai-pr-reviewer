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
