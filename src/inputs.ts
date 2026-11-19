export class Inputs {
  systemMessage: string
  title: string
  description: string
  rawSummary: string
  shortSummary: string
  filename: string
  fileContent: string
  fileDiff: string
  patches: string
  diff: string
  commentChain: string
  comment: string
  reviewContext: string

  constructor(
    systemMessage = '',
    title = 'no title provided',
    description = 'no description provided',
    rawSummary = '',
    shortSummary = '',
    filename = '',
    fileContent = 'file contents cannot be provided',
    fileDiff = 'file diff cannot be provided',
    patches = '',
    diff = 'no diff',
    commentChain = 'no other comments on this patch',
    comment = 'no comment provided',
    reviewContext = ''
  ) {
    this.systemMessage = systemMessage
    this.title = title
    this.description = description
    this.rawSummary = rawSummary
    this.shortSummary = shortSummary
    this.filename = filename
    this.fileContent = fileContent
    this.fileDiff = fileDiff
    this.patches = patches
    this.diff = diff
    this.commentChain = commentChain
    this.comment = comment
    this.reviewContext = reviewContext
  }

  clone(): Inputs {
    return new Inputs(
      this.systemMessage,
      this.title,
      this.description,
      this.rawSummary,
      this.shortSummary,
      this.filename,
      this.fileContent,
      this.fileDiff,
      this.patches,
      this.diff,
      this.commentChain,
      this.comment,
      this.reviewContext
    )
  }

  render(content: string): string {
    if (!content) {
      return ''
    }
    const values = new Map<string, string>([
      ['system_message', this.systemMessage],
      ['title', this.title],
      ['description', this.description],
      ['raw_summary', this.rawSummary],
      ['short_summary', this.shortSummary],
      ['filename', this.filename],
      ['file_content', this.fileContent],
      ['file_diff', this.fileDiff],
      ['patches', this.patches],
      ['diff', this.diff],
      ['comment_chain', this.commentChain],
      ['comment', this.comment],
      ['review_context', this.reviewContext]
    ])
    // Single-pass replacement prevents untrusted/diff values from expanding later placeholders.
    return content.replace(
      /\$(system_message|title|description|raw_summary|short_summary|filename|file_content|file_diff|patches|diff|comment_chain|comment|review_context)\b/g,
      (match, key: string) => {
        const val = values.get(key)
        if (val) return val
        return key === 'review_context' ? '' : match
      }
    )
  }
}
