import {join} from 'node:path'
import {
  getBooleanInput,
  getInput,
  getMultilineInput,
  setFailed,
  warning
} from '@actions/core'
import {context as githubContext} from '@actions/github'
import {Bot} from './bot'
import {
  createAstContextProvider,
  createGithubFileFetcher,
  loadCParser,
  type ContentApi
} from './context-provider'
import {octokit} from './octokit'
import {OpenAIOptions, Options} from './options'
import {Prompts} from './prompts'
import {codeReview} from './review'
import type {ReviewContextProvider} from './review-context'
import {handleReviewComment} from './review-comment'

/** Opt-in; any failure degrades to hunk-only review instead of failing it. */
async function buildContextProvider(): Promise<
  ReviewContextProvider | undefined
> {
  if (getInput('context_provider') !== 'ast') return undefined
  try {
    const {owner, repo} = githubContext.repo
    return createAstContextProvider({
      parser: await loadCParser(join(__dirname, 'tree-sitter-c.wasm')),
      fetchFile: createGithubFileFetcher(
        octokit as unknown as ContentApi,
        owner,
        repo
      )
    })
  } catch {
    warning('AST context unavailable; continuing with hunk-only review')
    return undefined
  }
}

async function run(): Promise<void> {
  const options: Options = new Options(
    getBooleanInput('debug'),
    getBooleanInput('disable_review'),
    getBooleanInput('disable_release_notes'),
    getInput('max_files'),
    getBooleanInput('review_simple_changes'),
    getBooleanInput('review_comment_lgtm'),
    getMultilineInput('path_filters'),
    getInput('system_message'),
    getInput('openai_light_model'),
    getInput('openai_heavy_model'),
    getInput('openai_model_temperature'),
    getInput('openai_retries'),
    getInput('openai_timeout_ms'),
    getInput('openai_concurrency_limit'),
    getInput('github_concurrency_limit'),
    getInput('llm_base_url') || getInput('openai_base_url'),
    getInput('language'),
    getInput('llm_provider'),
    getInput('llm_api_protocol')
  )

  // print options
  options.print()

  const prompts: Prompts = new Prompts(
    getInput('summarize'),
    getInput('summarize_release_notes')
  )

  // Create two bots, one for summary and one for review

  let lightBot: Bot | null = null
  try {
    lightBot = new Bot(
      options,
      new OpenAIOptions(options.openaiLightModel, options.lightTokenLimits)
    )
  } catch {
    setFailed(
      'Unable to create summary bot: verify provider credentials and model configuration'
    )
    return
  }

  let heavyBot: Bot | null = null
  try {
    heavyBot = new Bot(
      options,
      new OpenAIOptions(options.openaiHeavyModel, options.heavyTokenLimits)
    )
  } catch {
    setFailed(
      'Unable to create review bot: verify provider credentials and model configuration'
    )
    return
  }

  try {
    // check if the event is pull_request
    if (
      process.env.GITHUB_EVENT_NAME === 'pull_request' ||
      process.env.GITHUB_EVENT_NAME === 'pull_request_target'
    ) {
      await codeReview(
        lightBot,
        heavyBot,
        options,
        prompts,
        await buildContextProvider()
      )
    } else if (
      process.env.GITHUB_EVENT_NAME === 'pull_request_review_comment'
    ) {
      await handleReviewComment(heavyBot, options, prompts)
    } else {
      warning('Skipped: this action only works on push events or pull_request')
    }
  } catch {
    // Provider errors can contain raw source and secrets. Never log them.
    setFailed('Failed to run reviewer: protected error details withheld')
  }
}

process
  .on('unhandledRejection', () => {
    setFailed('Unhandled reviewer rejection (details withheld)')
  })
  .on('uncaughtException', () => {
    setFailed('Unhandled reviewer exception (details withheld)')
  })

await run()
