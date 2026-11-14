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
    if (this.systemMessage) {
      content = content.replaceAll('$system_message', () => this.systemMessage)
    }
    if (this.title) {
      content = content.replaceAll('$title', () => this.title)
    }
    if (this.description) {
      content = content.replaceAll('$description', () => this.description)
    }
    if (this.rawSummary) {
      content = content.replaceAll('$raw_summary', () => this.rawSummary)
    }
    if (this.shortSummary) {
      content = content.replaceAll('$short_summary', () => this.shortSummary)
    }
    if (this.filename) {
      content = content.replaceAll('$filename', () => this.filename)
    }
    if (this.fileContent) {
      content = content.replaceAll('$file_content', () => this.fileContent)
    }
    if (this.fileDiff) {
      content = content.replaceAll('$file_diff', () => this.fileDiff)
    }
    if (this.patches) {
      content = content.replaceAll('$patches', () => this.patches)
    }
    if (this.diff) {
      content = content.replaceAll('$diff', () => this.diff)
    }
    if (this.commentChain) {
      content = content.replaceAll('$comment_chain', () => this.commentChain)
    }
    if (this.comment) {
      content = content.replaceAll('$comment', () => this.comment)
    }
    content = content.replaceAll('$review_context', () => this.reviewContext)
    return content
  }
}
