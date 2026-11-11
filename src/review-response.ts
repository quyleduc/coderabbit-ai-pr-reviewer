/**
 * Parse historical CodeRabbit model feedback as untrusted text.
 * Only top-level headings define review coordinates, never fenced code.
 */
export interface ReviewResponseItem {
  startLine: number
  endLine: number
  comment: string
}

const REVIEW_RANGE = /^\s*(\d+)-(\d+):\s*$/
const OPEN_FENCE = /^\s*(\x60{3,}|~{3,})(\S*)[^\n]*$/

export function parseReviewResponse(response: string): ReviewResponseItem[] {
  const reviews: ReviewResponseItem[] = []
  let startLine: number | null = null
  let endLine: number | null = null
  let commentLines: string[] = []
  let fenceChar = ''
  let fenceLength = 0
  let stripCodeLineNumbers = false

  const flush = (): void => {
    if (startLine === null || endLine === null) return
    const comment = commentLines.join('\n').trim()
    if (comment.length === 0) throw new Error('Empty model review comment')
    reviews.push({startLine, endLine, comment})
    startLine = null
    endLine = null
    commentLines = []
  }

  for (const line of response.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()

    if (fenceChar) {
      const candidate = trimmed.match(/^(\x60{3,}|~{3,})\s*$/)
      if (
        candidate &&
        candidate[1][0] === fenceChar &&
        candidate[1].length >= fenceLength
      ) {
        commentLines.push(line)
        fenceChar = ''
        fenceLength = 0
        stripCodeLineNumbers = false
      } else {
        commentLines.push(
          stripCodeLineNumbers ? line.replace(/^\s*\d+: /, '') : line
        )
      }
      continue
    }

    const opening = line.match(OPEN_FENCE)
    if (startLine !== null && opening) {
      fenceChar = opening[1][0]
      fenceLength = opening[1].length
      stripCodeLineNumbers = /^(diff|suggestion)$/i.test(opening[2])
      commentLines.push(line)
      continue
    }

    const match = line.match(REVIEW_RANGE)
    if (match) {
      flush()
      const start = Number(match[1])
      const end = Number(match[2])
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start
      ) {
        throw new Error('Invalid model review line range')
      }
      startLine = start
      endLine = end
      continue
    }

    if (trimmed === '---') {
      flush()
      continue
    }

    if (startLine !== null) commentLines.push(line)
  }

  if (fenceChar) throw new Error('Unterminated Markdown code fence')
  flush()
  return reviews
}
