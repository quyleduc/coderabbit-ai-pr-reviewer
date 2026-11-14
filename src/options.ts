import {info} from '@actions/core'
import {minimatch} from 'minimatch'
import {TokenLimits} from './limits'

function parseIntWithFallback(raw: string, fallback: number, min = 1): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback
}

function parseFloatWithFallback(
  raw: string,
  fallback: number,
  min = 0
): number {
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

export class Options {
  debug: boolean
  disableReview: boolean
  disableReleaseNotes: boolean
  maxFiles: number
  reviewSimpleChanges: boolean
  reviewCommentLGTM: boolean
  pathFilters: PathFilter
  systemMessage: string
  openaiLightModel: string
  openaiHeavyModel: string
  openaiModelTemperature: number
  openaiRetries: number
  openaiTimeoutMS: number
  openaiConcurrencyLimit: number
  githubConcurrencyLimit: number
  lightTokenLimits: TokenLimits
  heavyTokenLimits: TokenLimits
  apiBaseUrl: string
  language: string
  llmProvider: string
  llmProtocol: string

  constructor(
    debug: boolean,
    disableReview: boolean,
    disableReleaseNotes: boolean,
    maxFiles = '0',
    reviewSimpleChanges = false,
    reviewCommentLGTM = false,
    pathFilters: string[] | null = null,
    systemMessage = '',
    openaiLightModel = 'gpt-6-luna',
    openaiHeavyModel = 'gpt-6.1-sol',
    openaiModelTemperature = '0.0',
    openaiRetries = '3',
    openaiTimeoutMS = '120000',
    openaiConcurrencyLimit = '6',
    githubConcurrencyLimit = '6',
    apiBaseUrl = '',
    language = 'en-US',
    llmProvider = 'openai',
    llmProtocol = 'auto'
  ) {
    this.debug = debug
    this.disableReview = disableReview
    this.disableReleaseNotes = disableReleaseNotes
    this.maxFiles = parseIntWithFallback(maxFiles, 0, 0)
    this.reviewSimpleChanges = reviewSimpleChanges
    this.reviewCommentLGTM = reviewCommentLGTM
    this.pathFilters = new PathFilter(pathFilters)
    this.systemMessage = systemMessage
    this.openaiLightModel = openaiLightModel
    this.openaiHeavyModel = openaiHeavyModel
    this.openaiModelTemperature = parseFloatWithFallback(
      openaiModelTemperature,
      0.0,
      0
    )
    this.openaiRetries = parseIntWithFallback(openaiRetries, 3, 0)
    this.openaiTimeoutMS = parseIntWithFallback(openaiTimeoutMS, 120000, 1)
    this.openaiConcurrencyLimit = parseIntWithFallback(
      openaiConcurrencyLimit,
      6,
      1
    )
    this.githubConcurrencyLimit = parseIntWithFallback(
      githubConcurrencyLimit,
      6,
      1
    )
    this.lightTokenLimits = new TokenLimits(openaiLightModel)
    this.heavyTokenLimits = new TokenLimits(openaiHeavyModel)
    this.apiBaseUrl = apiBaseUrl
    this.language = language
    this.llmProvider = llmProvider
    this.llmProtocol = llmProtocol
  }

  // print all options using core.info
  print(): void {
    info(`debug: ${this.debug}`)
    info(`disable_review: ${this.disableReview}`)
    info(`disable_release_notes: ${this.disableReleaseNotes}`)
    info(`max_files: ${this.maxFiles}`)
    info(`review_simple_changes: ${this.reviewSimpleChanges}`)
    info(`review_comment_lgtm: ${this.reviewCommentLGTM}`)
    info(`path_filters: ${this.pathFilters}`)
    info('system_message: [configured]')
    info(`openai_light_model: ${this.openaiLightModel}`)
    info(`openai_heavy_model: ${this.openaiHeavyModel}`)
    info('openai_model_temperature: ignored by current LLM adapters')
    info(`openai_retries: ${this.openaiRetries}`)
    info(`openai_timeout_ms: ${this.openaiTimeoutMS}`)
    info(`openai_concurrency_limit: ${this.openaiConcurrencyLimit}`)
    info(`github_concurrency_limit: ${this.githubConcurrencyLimit}`)
    info(`summary_token_limits: ${this.lightTokenLimits.string()}`)
    info(`review_token_limits: ${this.heavyTokenLimits.string()}`)
    info('api_base_url: [configured]')
    info(`llm_provider: ${this.llmProvider}`)
    info(`llm_protocol: ${this.llmProtocol}`)
    info(`language: ${this.language}`)
  }

  checkPath(path: string): boolean {
    return this.pathFilters.check(path)
  }
}

export class PathFilter {
  private readonly rules: Array<[string /* rule */, boolean /* exclude */]>

  constructor(rules: string[] | null = null) {
    this.rules = []
    if (rules != null) {
      for (const rule of rules) {
        const trimmed = rule?.trim()
        if (trimmed) {
          if (trimmed.startsWith('!')) {
            this.rules.push([trimmed.substring(1).trim(), true])
          } else {
            this.rules.push([trimmed, false])
          }
        }
      }
    }
  }

  toString(): string {
    if (this.rules.length === 0) {
      return '(none)'
    }
    return this.rules
      .map(([rule, exclude]) => `${exclude ? '!' : ''}${rule}`)
      .join(', ')
  }

  check(path: string): boolean {
    if (this.rules.length === 0) {
      return true
    }

    let included = false
    let excluded = false
    let inclusionRuleExists = false

    for (const [rule, exclude] of this.rules) {
      if (minimatch(path, rule)) {
        if (exclude) {
          excluded = true
        } else {
          included = true
        }
      }
      if (!exclude) {
        inclusionRuleExists = true
      }
    }

    return (!inclusionRuleExists || included) && !excluded
  }
}

export class OpenAIOptions {
  model: string
  tokenLimits: TokenLimits

  constructor(model = 'gpt-3.5-turbo', tokenLimits: TokenLimits | null = null) {
    this.model = model
    if (tokenLimits != null) {
      this.tokenLimits = tokenLimits
    } else {
      this.tokenLimits = new TokenLimits(model)
    }
  }
}
