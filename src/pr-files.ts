/**
 * Trusted production acquisition of every file in the CURRENT PR diff.
 * Unlike repos.compareCommits, pulls.listFiles supports pagination up to
 * GitHub's documented limit of 3,000 files. Strict count checks prevent
 * a partial response from ever advancing the reviewed-head checkpoint.
 */
export interface PullRequestDiffFile {
  filename: string
  patch?: string | null
  additions: number
  deletions: number
  status: string
}

export async function loadCompletePullRequestFiles<T extends {filename: string}>(
  expectedFileCount: number,
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>,
  {pageSize = 100}: {pageSize?: number} = {}
): Promise<T[]> {
  if (!Number.isSafeInteger(expectedFileCount) ||
      expectedFileCount < 1 || expectedFileCount > 3000) {
    throw new RangeError('Invalid or unsupported PR changed_files count (limit 3000)')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('Invalid PR files page size')
  }

  const files: T[] = []
  const seen = new Set<string>()
  for (let page = 1; files.length < expectedFileCount; page++) {
    if (page > Math.ceil(3000 / pageSize)) {
      throw new Error('PR files pagination safety limit exceeded')
    }
    const data = await fetchPage(page, pageSize)
    if (!Array.isArray(data) || data.length === 0 ||
        data.length > pageSize || files.length + data.length > expectedFileCount) {
      throw new Error('Incomplete or inconsistent PR file count/page')
    }
    for (const file of data) {
      if (typeof file?.filename !== 'string' || !file.filename.trim()) {
        throw new Error('Missing GitHub PR filename')
      }
      if (seen.has(file.filename)) throw new Error('Duplicate PR filename: ' + file.filename)
      seen.add(file.filename)
      files.push(file)
    }
    if (data.length < pageSize && files.length !== expectedFileCount) {
      throw new Error('Incomplete PR file count from short page')
    }
  }
  return files
}

/**
 * Some GitHub pull files have no patch (binary, oversized or pure rename);
 * these cannot be passed to the model as complete text. For eligible files
 * reject them instead of silently claiming they were reviewed.
 *
 * This cross-check is independent of buildChangedLineIndex(): it detects
 * missing WHOLE hunks when the remaining hunk text is individually valid.
 */
export function verifyPullRequestPatch(
  file: Pick<PullRequestDiffFile, 'filename' | 'patch' | 'additions' | 'deletions'>
): void {
  if (typeof file.patch !== 'string' || !file.patch.trim()) {
    throw new Error('Missing usable patch: ' + file.filename)
  }
  if (!Number.isSafeInteger(file.additions) || file.additions < 0 ||
      !Number.isSafeInteger(file.deletions) || file.deletions < 0) {
    throw new Error('Missing/invalid additions/deletions metadata: ' + file.filename)
  }

  const lines = file.patch.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  let hunkSeen = false
  let oldLeft = 0
  let newLeft = 0
  let added = 0
  let deleted = 0

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line)
    if (header) {
      if (hunkSeen && (oldLeft !== 0 || newLeft !== 0)) {
        throw new Error('Truncated patch hunk: ' + file.filename)
      }
      oldLeft = Number(header[2] ?? '1')
      newLeft = Number(header[4] ?? '1')
      if (!Number.isSafeInteger(oldLeft) || !Number.isSafeInteger(newLeft)) {
        throw new Error('Invalid patch hunk count: ' + file.filename)
      }
      hunkSeen = true
    } else if (!hunkSeen) {
      throw new Error('Invalid patch without unified diff header: ' + file.filename)
    } else if (line.startsWith('+')) {
      added++
      newLeft--
    } else if (line.startsWith('-')) {
      deleted++
      oldLeft--
    } else if (line.startsWith(' ')) {
      oldLeft--
      newLeft--
    } else if (line === '\\ No newline at end of file') {
      continue
    } else {
      throw new Error('Invalid patch body: ' + file.filename)
    }
    if (oldLeft < 0 || newLeft < 0) {
      throw new Error('Invalid patch hunk line count: ' + file.filename)
    }
  }
  if (!hunkSeen || oldLeft !== 0 || newLeft !== 0 ||
      added !== file.additions || deleted !== file.deletions) {
    throw new Error('Truncated patch metadata/line count mismatch: ' + file.filename)
  }
}
