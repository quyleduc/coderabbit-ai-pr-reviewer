export class TokenLimits {
  maxTokens: number
  requestTokens: number
  responseTokens: number
  knowledgeCutOff: string

  constructor(model = 'gpt-3.5-turbo') {
    this.knowledgeCutOff = '2021-09-01'
    // M1 free OpenRouter preset: conservative operational cap (model context is
    // much larger), enough room for evidence-backed JSON review output.
    if (model === 'google/gemma-4-31b-it:free') {
      this.maxTokens = 20000
      this.responseTokens = 4096
    } else if (model === 'gpt-6.1-sol') {
      this.maxTokens = 14000
      this.responseTokens = 5000
    } else if (model === 'gpt-6-luna') {
      this.maxTokens = 10000
      this.responseTokens = 3000
    } else if (model === 'gpt-4-32k') {
      this.maxTokens = 32600
      this.responseTokens = 4000
    } else if (model === 'gpt-3.5-turbo-16k') {
      this.maxTokens = 16300
      this.responseTokens = 3000
    } else if (model === 'gpt-4') {
      this.maxTokens = 8000
      this.responseTokens = 2000
    } else {
      this.maxTokens = 4000
      this.responseTokens = 1000
    }
    // provide some margin for the request tokens
    this.requestTokens = this.maxTokens - this.responseTokens - 100
  }

  string(): string {
    return `max_tokens=${this.maxTokens}, request_tokens=${this.requestTokens}, response_tokens=${this.responseTokens}`
  }
}
