import type {ChangedLineIndex} from './diff-hunks'

export interface StructuredReviewComment {
  startLine: number
  endLine: number
  message: string
}

export interface StructuredReviewResult {
  reviewedHunks: number[]
  cleanHunks: number[]
  comments: StructuredReviewComment[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireFields(
  value: unknown,
  fields: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every(field => Object.prototype.hasOwnProperty.call(value, field))
  ) {
    throw new Error(`Invalid ${label} schema fields`)
  }
}

function parseJsonResponse(text: string): unknown {
  if (text.length > 262144)
    throw new Error('Review protocol exceeds response size limit')
  let raw = text.trim()
  const fenced = /^\x60{3}json\s*\n([\s\S]*?)\n\x60{3}$/i.exec(raw)
  if (fenced) raw = fenced[1]
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Review protocol requires one valid JSON object')
  }
}

function addedSourceLines(diff: string): {
  texts: Map<number, string>
  hunks: number
} {
  const texts = new Map<number, string>()
  let cursor = 0
  let hunks = 0
  for (const source of diff.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(source)
    if (header) {
      cursor = Number(header[1])
      hunks++
    } else if (hunks > 0 && source.startsWith('+')) {
      if (texts.has(cursor)) throw new Error('Overlapping diff hunks')
      texts.set(cursor, source.slice(1).trim())
      cursor++
    } else if (hunks > 0 && source.startsWith(' ')) {
      cursor++
    }
  }
  return {texts, hunks}
}

function sanitizeFindingMessage(raw: string): string {
  return raw
    .trim()
    .replace(
      /!?\[([^\]]*)\]\(\s*(?:https?:|\/\/|data:|javascript:)[^)]*\)/gi,
      '$1'
    )
    .replace(/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g, '')
    .replace(/@([a-zA-Z0-9_-]+)/g, '$1')
}

/**
 * Strict model-to-publisher contract:
 * - exactly one verdict per packed hunk (no silent missing coverage)
 * - every proposed finding is on an added line of its own hunk
 * - evidence must match the corresponding source line in the supplied diff
 * - no dependency on model verbosity, Markdown headings or extra properties
 */
export function processStructuredReview(
  response: string,
  changed: ChangedLineIndex,
  diff: string,
  packedHunks: number
): StructuredReviewResult {
  if (
    !changed.valid ||
    !Number.isSafeInteger(packedHunks) ||
    packedHunks < 1 ||
    packedHunks > changed.hunks.length ||
    !diff.trim()
  ) {
    throw new Error('Invalid diff or expected hunk count')
  }
  const root = parseJsonResponse(response)
  requireFields(root, ['version', 'hunks'], 'review root')
  if (root.version !== 1) throw new Error('Unsupported review protocol version')
  if (!Array.isArray(root.hunks)) throw new Error('Invalid hunks array')
  if (root.hunks.length !== packedHunks) {
    throw new Error('Missing or excess hunk verdicts')
  }

  const added = addedSourceLines(diff)
  if (added.hunks !== changed.hunks.length) {
    throw new Error('Diff hunk count mismatch')
  }
  const seen = new Set<number>()
  const cleanHunks: number[] = []
  const comments: StructuredReviewComment[] = []
  for (const rawHunk of root.hunks) {
    requireFields(rawHunk, ['id', 'status', 'findings'], 'hunk')
    if (
      typeof rawHunk.id !== 'string' ||
      !/^h(?:0|[1-9]\d*)$/.test(rawHunk.id)
    ) {
      throw new Error('Invalid hunk id')
    }
    const hunkIndex = Number(rawHunk.id.slice(1))
    if (!Number.isSafeInteger(hunkIndex) || hunkIndex >= packedHunks) {
      throw new Error('Unexpected hunk id')
    }
    if (seen.has(hunkIndex)) throw new Error('Duplicate hunk id')
    seen.add(hunkIndex)
    if (rawHunk.status !== 'clean' && rawHunk.status !== 'issues') {
      throw new Error('Invalid hunk status')
    }
    if (!Array.isArray(rawHunk.findings) || rawHunk.findings.length > 20) {
      throw new Error('Invalid findings array')
    }
    if (
      (rawHunk.status === 'clean' && rawHunk.findings.length > 0) ||
      (rawHunk.status === 'issues' && rawHunk.findings.length === 0)
    ) {
      throw new Error('Hunk status and findings disagree')
    }
    if (rawHunk.status === 'clean') cleanHunks.push(hunkIndex)
    for (const finding of rawHunk.findings) {
      requireFields(
        finding,
        ['line', 'rule_id', 'severity', 'message', 'evidence'],
        'finding'
      )
      if (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1) {
        throw new Error('Invalid finding line')
      }
      const line = finding.line as number
      if (!changed.hunks[hunkIndex].addedLines.includes(line)) {
        throw new Error('Finding line is not an added line in its hunk')
      }
      if (
        typeof finding.evidence !== 'string' ||
        !finding.evidence.trim() ||
        finding.evidence.trim() !== added.texts.get(line)
      ) {
        throw new Error('Finding evidence does not match added source line')
      }
      if (
        typeof finding.rule_id !== 'string' ||
        !/^[A-Z][A-Z0-9_]{2,63}$/.test(finding.rule_id)
      ) {
        throw new Error('Invalid rule_id')
      }
      if (
        finding.severity !== 'high' &&
        finding.severity !== 'medium' &&
        finding.severity !== 'low'
      ) {
        throw new Error('Invalid severity')
      }
      if (
        typeof finding.message !== 'string' ||
        finding.message.trim().length < 8 ||
        finding.message.length > 1200
      ) {
        throw new Error('Invalid finding message')
      }
      const sanitizedMessage = sanitizeFindingMessage(finding.message)
      if (sanitizedMessage.length < 8) {
        throw new Error('Invalid finding message')
      }
      comments.push({
        startLine: line,
        endLine: line,
        message: `**${String(finding.severity).toUpperCase()} / ${
          finding.rule_id
        }**\n\n${sanitizedMessage}`
      })
    }
  }
  return {
    reviewedHunks: [...seen].sort((a, b) => a - b),
    cleanHunks: cleanHunks.sort((a, b) => a - b),
    comments
  }
}
