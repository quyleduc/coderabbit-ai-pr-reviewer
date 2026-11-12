import {info, setFailed, warning} from '@actions/core'
// eslint-disable-next-line camelcase
import {context as github_context} from '@actions/github'
import pLimit from 'p-limit'
import {type Bot} from './bot'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  RAW_SUMMARY_END_TAG,
  RAW_SUMMARY_START_TAG,
  SHORT_SUMMARY_END_TAG,
  SHORT_SUMMARY_START_TAG,
  SUMMARIZE_TAG
} from './commenter'
import {Inputs} from './inputs'
import {octokit} from './octokit'
import {type Options} from './options'
import {type Prompts} from './prompts'
import {
  buildChangedLineIndex,
  parsePatch,
  patchStartEndLine,
  splitPatch
} from './diff-hunks'
import {getTokenCount} from './tokenizer'
import {processStructuredReview} from './review-protocol'
import {loadCompletePullRequestFiles, verifyPullRequestPatch} from './pr-files'
import {assessReviewCompletion, type CoverageStatus} from './review-integrity'
import {HunkCoverage} from './review-hunks'
import {
  formatReviewContextForPrompt,
  retrieveReviewContext,
  summarizeReviewContextStatus,
  type ReviewContextProvider,
  type ReviewContextResult
} from './review-context'

// eslint-disable-next-line camelcase
const context = github_context
const repo = context.repo

const ignoreKeyword = '@coderabbitai: ignore'
const REVIEW_COMPLETE_TAG = '<!-- coderabbit:review-complete-v1 -->'
interface ReviewPatch {
  startLine: number
  endLine: number
  promptPatch: string
  sourcePatch: string
}
type FileChanges = [string, string, ReviewPatch[]]

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts,
  contextProvider?: ReviewContextProvider
): Promise<void> => {
  const commenter: Commenter = new Commenter()

  const openaiConcurrencyLimit = pLimit(options.openaiConcurrencyLimit)

  if (
    context.eventName !== 'pull_request' &&
    context.eventName !== 'pull_request_target'
  ) {
    warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return
  }
  if (context.payload.pull_request == null) {
    warning('Skipped: context.payload.pull_request is null')
    return
  }

  const inputs: Inputs = new Inputs()
  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body != null) {
    inputs.description = commenter.getDescription(
      context.payload.pull_request.body
    )
  }

  // if the description contains ignore_keyword, skip
  if (inputs.description.includes(ignoreKeyword)) {
    info('Skipped: description contains ignore_keyword')
    return
  }

  // as gpt-3.5-turbo isn't paying attention to system message, add to inputs for now
  inputs.systemMessage = options.systemMessage

  // get SUMMARIZE_TAG message
  const existingSummarizeCmt = await commenter.findCommentWithTag(
    SUMMARIZE_TAG,
    context.payload.pull_request.number
  )
  let existingCommitIdsBlock = ''
  let existingSummarizeCmtBody = ''
  if (existingSummarizeCmt != null) {
    existingSummarizeCmtBody = existingSummarizeCmt.body
    inputs.rawSummary = commenter.getRawSummary(existingSummarizeCmtBody)
    inputs.shortSummary = commenter.getShortSummary(existingSummarizeCmtBody)
    existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(
      existingSummarizeCmtBody
    )
  }

  // Review full PR diff for each new head SHA. Compare API's first-page
  // 300-file cap cannot prove an incremental subset is complete, so we
  // deliberately trade extra model cost for auditable full-PR coverage.
  // Bind replay suppression to BOTH base/head SHAs: base can be retargeted.
  const currentScopeMarker = `<!-- coderabbit:review-scope-v1:${context.payload.pull_request.base.sha}:${context.payload.pull_request.head.sha} -->`

  let currentPR
  try {
    currentPR = await octokit.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      // eslint-disable-next-line camelcase
      pull_number: context.payload.pull_request.number
    })
  } catch (error) {
    setFailed('Cannot acquire complete PR files: unable to verify PR metadata')
    return
  }
  if (
    currentPR.data.head.sha !== context.payload.pull_request.head.sha ||
    currentPR.data.base.sha !== context.payload.pull_request.base.sha
  ) {
    setFailed('Cannot acquire complete PR files: stale PR head/base scope')
    return
  }

  if (
    existingSummarizeCmtBody.includes(REVIEW_COMPLETE_TAG) &&
    existingSummarizeCmtBody.includes(currentScopeMarker) &&
    commenter
      .getReviewedCommitIds(existingCommitIdsBlock)
      .includes(context.payload.pull_request.head.sha)
  ) {
    info(
      'Review already completed for this base/head SHA scope, skipping duplicate run'
    )
    return
  }

  // Rebuild summaries for the new immutable PR scope. Reusing old model
  // summaries here could cause incorrect conclusions about untouched files.
  inputs.rawSummary = ''
  inputs.shortSummary = ''

  let files
  try {
    files = await loadCompletePullRequestFiles(
      currentPR.data.changed_files,
      async (page, perPage) => {
        const response = await octokit.pulls.listFiles({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: context.payload.pull_request!.number,
          // eslint-disable-next-line camelcase
          per_page: perPage,
          page
        })
        return response.data
      }
    )
  } catch (error) {
    setFailed(`Cannot acquire complete PR files: ${String(error)}`)
    return
  }

  // skip files if they are filtered out
  const filterSelectedFiles = []
  const filterIgnoredFiles = []
  for (const file of files) {
    if (!options.checkPath(file.filename)) {
      info(`skip for excluded path: ${file.filename}`)
      filterIgnoredFiles.push(file)
    } else {
      filterSelectedFiles.push(file)
    }
  }

  const fileCoverage = new Map<string, CoverageStatus>(
    files.map(file => [file.filename, 'pending'])
  )
  for (const file of filterIgnoredFiles) {
    fileCoverage.set(file.filename, 'ignored_by_policy')
  }

  if (filterSelectedFiles.length === 0) {
    warning('Skipped: filterSelectedFiles is null')
    return
  }

  try {
    for (const file of filterSelectedFiles) verifyPullRequestPatch(file)
  } catch (error) {
    setFailed(`Cannot acquire complete PR files: ${String(error)}`)
    return
  }

  // find hunks to review
  const filteredFiles: Array<FileChanges | null> = filterSelectedFiles.map(
    file => {
      const fileDiff = file.patch ?? ''
      const patches: ReviewPatch[] = []
      for (const patch of splitPatch(file.patch)) {
        const patchLines = patchStartEndLine(patch)
        if (patchLines == null) continue
        const hunks = parsePatch(patch)
        if (hunks == null) continue
        const hunksStr = `
---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`
        patches.push({
          startLine: patchLines.newHunk.startLine,
          endLine: patchLines.newHunk.endLine,
          promptPatch: hunksStr,
          sourcePatch: patch
        })
      }
      if (patches.length > 0) {
        return [file.filename, fileDiff, patches]
      } else {
        return null
      }
    }
  )

  // Filter out any null results
  const filesAndChanges = filteredFiles.filter(
    (file): file is FileChanges => file !== null
  )

  if (filesAndChanges.length === 0) {
    setFailed('Cannot complete review: eligible file patches unavailable')
    return
  }

  const hunkCoverage = new HunkCoverage()
  for (const [filename, , patches] of filesAndChanges) {
    hunkCoverage.registerFile(filename, patches.length)
  }

  let statusMsg = `<details>
<summary>Commits</summary>
Complete current PR diff between base ${
    context.payload.pull_request.base.sha
  } and head ${
    context.payload.pull_request.head.sha
  } (all changed files; no Compare API sampling)
</details>
${
  filesAndChanges.length > 0
    ? `
<details>
<summary>Files selected (${filesAndChanges.length})</summary>

* ${filesAndChanges
        .map(([filename, , patches]) => `${filename} (${patches.length})`)
        .join('\n* ')}
</details>
`
    : ''
}
${
  filterIgnoredFiles.length > 0
    ? `
<details>
<summary>Files ignored due to filter (${filterIgnoredFiles.length})</summary>

* ${filterIgnoredFiles.map(file => file.filename).join('\n* ')}

</details>
`
    : ''
}
`

  // update the existing comment with in progress status
  const inProgressSummarizeCmt = commenter.addInProgressStatus(
    existingSummarizeCmtBody,
    statusMsg
  )

  // add in progress status to the summarize comment
  await commenter.comment(`${inProgressSummarizeCmt}`, SUMMARIZE_TAG, 'replace')

  const summariesFailed: string[] = []

  const doSummary = async (
    filename: string,

    fileDiff: string
  ): Promise<[string, string, boolean] | null> => {
    info(`summarize: ${filename}`)
    const ins = inputs.clone()
    if (fileDiff.length === 0) {
      warning(`summarize: file_diff is empty, skip ${filename}`)
      summariesFailed.push(`${filename} (empty diff)`)
      return null
    }

    ins.filename = filename
    ins.fileDiff = fileDiff

    // render prompt based on inputs so far
    const summarizePrompt = prompts.renderSummarizeFileDiff(
      ins,
      options.reviewSimpleChanges
    )
    const tokens = getTokenCount(summarizePrompt)

    if (tokens > options.lightTokenLimits.requestTokens) {
      info(`summarize: diff tokens exceeds limit, skip ${filename}`)
      summariesFailed.push(`${filename} (diff tokens exceeds limit)`)
      return null
    }

    // summarize content
    try {
      const [summarizeResp] = await lightBot.chat(summarizePrompt, {})

      if (summarizeResp === '') {
        info('summarize: nothing obtained from openai')
        summariesFailed.push(`${filename} (nothing obtained from openai)`)
        return null
      } else {
        if (options.reviewSimpleChanges === false) {
          // parse the comment to look for triage classification
          // Format is : [TRIAGE]: <NEEDS_REVIEW or APPROVED>
          // if the change needs review return true, else false
          const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/
          const triageMatch = summarizeResp.match(triageRegex)

          if (triageMatch != null) {
            const triage = triageMatch[1]
            const needsReview = triage === 'NEEDS_REVIEW'

            // remove this line from the comment
            const summary = summarizeResp.replace(triageRegex, '').trim()
            info(`filename: ${filename}, triage: ${triage}`)
            return [filename, summary, needsReview]
          }
        }
        return [filename, summarizeResp, true]
      }
    } catch (e: any) {
      warning('Summarize failed (details withheld)')
      summariesFailed.push(`${filename} (summarize failed)`)
      return null
    }
  }

  const summaryPromises = []
  const skippedFiles = []
  for (const [filename, fileDiff] of filesAndChanges) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiConcurrencyLimit(async () => await doSummary(filename, fileDiff))
      )
    } else {
      skippedFiles.push(filename)
    }
  }

  const summaries = (await Promise.all(summaryPromises)).filter(
    summary => summary !== null
  ) as Array<[string, string, boolean]>
  const summarized = new Set(summaries.map(([filename]) => filename))
  for (const [filename] of filesAndChanges) {
    if (!summarized.has(filename)) fileCoverage.set(filename, 'failed_analysis')
  }

  if (summaries.length > 0) {
    const batchSize = 10
    // join summaries into one in the batches of batchSize
    // and ask the bot to summarize the summaries
    for (let i = 0; i < summaries.length; i += batchSize) {
      const summariesBatch = summaries.slice(i, i + batchSize)
      for (const [filename, summary] of summariesBatch) {
        inputs.rawSummary += `---
${filename}: ${summary}
`
      }
      // ask chatgpt to summarize the summaries
      const [summarizeResp] = await heavyBot.chat(
        prompts.renderSummarizeChangesets(inputs),
        {}
      )
      if (summarizeResp === '') {
        throw new Error('Missing consolidated summary response')
      }
      inputs.rawSummary = summarizeResp
    }
  }

  // final summary
  const [summarizeFinalResponse] = await heavyBot.chat(
    prompts.renderSummarize(inputs),
    {}
  )
  if (summarizeFinalResponse === '') {
    throw new Error('Missing final summary response')
  }

  if (options.disableReleaseNotes === false) {
    // final release notes
    const [releaseNotesResponse] = await heavyBot.chat(
      prompts.renderSummarizeReleaseNotes(inputs),
      {}
    )
    if (releaseNotesResponse === '') {
      info('release notes: nothing obtained from openai')
    } else {
      let message = '### Summary by CodeRabbit\n\n'
      message += releaseNotesResponse
      try {
        await commenter.updateDescription(
          context.payload.pull_request.number,
          message
        )
      } catch (e: any) {
        warning('Release notes update failed (details withheld)')
      }
    }
  }

  // generate a short summary as well
  const [summarizeShortResponse] = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs),
    {}
  )
  if (summarizeShortResponse === '') {
    throw new Error('Missing short summary response')
  }
  inputs.shortSummary = summarizeShortResponse

  let summarizeComment = `${summarizeFinalResponse}
${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}

---

<details>
<summary>Uplevel your code reviews with CodeRabbit Pro</summary>

### CodeRabbit Pro

If you like this project, please support us by purchasing the [Pro version](https://coderabbit.ai). The Pro version has advanced context, superior noise reduction and several proprietary improvements compared to the open source version. Moreover, CodeRabbit Pro is free for open source projects.

</details>
`

  statusMsg += `
${
  skippedFiles.length > 0
    ? `
<details>
<summary>Files not processed due to max files limit (${
        skippedFiles.length
      })</summary>

* ${skippedFiles.join('\n* ')}

</details>
`
    : ''
}
${
  summariesFailed.length > 0
    ? `
<details>
<summary>Files not summarized due to errors (${
        summariesFailed.length
      })</summary>

* ${summariesFailed.join('\n* ')}

</details>
`
    : ''
}
`

  if (!options.disableReview) {
    const filesAndChangesReview = filesAndChanges.filter(([filename]) => {
      const needsReview =
        summaries.find(
          ([summaryFilename]) => summaryFilename === filename
        )?.[2] ?? true
      return needsReview
    })

    const reviewsSkipped = filesAndChanges
      .filter(
        ([filename]) =>
          !filesAndChangesReview.some(
            ([reviewFilename]) => reviewFilename === filename
          )
      )
      .map(([filename]) => filename)

    for (const filename of reviewsSkipped) {
      if (fileCoverage.get(filename) === 'pending') {
        fileCoverage.set(filename, 'triaged_trivial')
        hunkCoverage.markFile(filename, 'triaged_trivial')
      }
    }

    // A file may be only partially packed when exceeding the model budget.
    const budgetSkipped = new Set<string>()
    // failed reviews array
    const reviewsFailed: string[] = []
    const contextResults: ReviewContextResult[] = []
    let lgtmCount = 0
    let reviewCount = 0
    const doReview = async (
      filename: string,

      fileDiff: string,
      patches: ReviewPatch[]
    ): Promise<void> => {
      info(`reviewing ${filename}`)
      // make a copy of inputs
      const ins: Inputs = inputs.clone()
      ins.filename = filename
      const changedLineIndex = buildChangedLineIndex(fileDiff)
      const hunkRangesMatch =
        changedLineIndex.valid &&
        changedLineIndex.hunks.length === patches.length &&
        patches.every((patch, index) => {
          const validatedHunk = changedLineIndex.hunks[index]
          return (
            validatedHunk.startLine === patch.startLine &&
            validatedHunk.endLine === patch.endLine
          )
        })
      if (!hunkRangesMatch) {
        reviewsFailed.push(`${filename} (invalid or incomplete diff)`)
        hunkCoverage.markFile(filename, 'failed_analysis')
        return
      }

      const contextResult = await retrieveReviewContext(contextProvider, {
        repositoryId: `${repo.owner}/${repo.repo}`,
        pullRequestNumber: context.payload.pull_request!.number,
        baseSha: context.payload.pull_request!.base.sha,
        headSha: context.payload.pull_request!.head.sha,
        changedFile: filename,
        hunks: patches.map(patch => ({
          startLine: patch.startLine,
          endLine: patch.endLine,
          patch: patch.sourcePatch
        }))
      })
      contextResults.push(contextResult)
      ins.reviewContext = formatReviewContextForPrompt(contextResult)

      // calculate tokens based on inputs so far
      let tokens = getTokenCount(prompts.renderReviewFileDiff(ins))
      // loop to calculate total patch tokens
      let patchesToPack = 0
      for (const [index, patch] of patches.entries()) {
        const patchTokens = getTokenCount(
          `---review_hunk id=h${index}---\n${patch.promptPatch}\n---end_change_section---`
        )
        if (tokens + patchTokens > options.heavyTokenLimits.requestTokens) {
          info(
            `only packing ${patchesToPack} / ${patches.length} patches, tokens: ${tokens} / ${options.heavyTokenLimits.requestTokens}`
          )
          break
        }
        tokens += patchTokens
        patchesToPack += 1
      }

      if (patchesToPack < patches.length) budgetSkipped.add(filename)
      hunkCoverage.markPacked(filename, patchesToPack)

      let patchesPacked = 0
      for (const patch of patches) {
        const {startLine, endLine, promptPatch} = patch
        if (context.payload.pull_request == null) {
          warning('No pull request found, skipping.')
          continue
        }
        // see if we can pack more patches into this request
        if (patchesPacked >= patchesToPack) {
          info(
            `unable to pack more patches into this request, packed: ${patchesPacked}, total patches: ${patches.length}, skipping.`
          )
          if (options.debug) info('Review prompt exceeds token budget')
          break
        }
        patchesPacked += 1

        let commentChain = ''
        try {
          const allChains = await commenter.getCommentChainsWithinRange(
            context.payload.pull_request.number,
            filename,
            startLine,
            endLine,
            COMMENT_REPLY_TAG
          )

          if (allChains.length > 0) {
            info(`Found existing comment chains for ${filename}`)
            commentChain = allChains
          }
        } catch (e: any) {
          warning('Failed to retrieve review comment chain (details withheld)')
        }
        // try packing comment_chain into this request
        const commentChainTokens = getTokenCount(commentChain)
        if (
          tokens + commentChainTokens >
          options.heavyTokenLimits.requestTokens
        ) {
          commentChain = ''
        } else {
          tokens += commentChainTokens
        }

        ins.patches += `
---review_hunk id=h${patchesPacked - 1}---
${promptPatch}
`
        if (commentChain !== '') {
          ins.patches += `
---comment_chains---
\`\`\`
${commentChain}
\`\`\`
`
        }

        ins.patches += `
---end_change_section---
`
      }

      if (patchesPacked > 0) {
        // perform review
        try {
          const [response] = await heavyBot.chat(
            prompts.renderReviewFileDiff(ins),
            {}
          )
          if (response === '') {
            info('review: nothing obtained from openai')
            reviewsFailed.push(`${filename} (no response)`)
            hunkCoverage.markFile(filename, 'failed_analysis')
            return
          }
          // Fail the entire file before publishing anything if the model
          // omits a hunk, invents a location or cites non-existent source.
          const structured = processStructuredReview(
            response,
            changedLineIndex,
            fileDiff,
            patchesPacked
          )
          for (const finding of structured.comments) {
            await commenter.bufferReviewComment(
              filename,
              finding.startLine,
              finding.endLine,
              finding.message
            )
            reviewCount += 1
          }
          for (const cleanHunk of structured.cleanHunks) {
            lgtmCount += 1
            // Preserve the legacy opt-in LGTM inline comment behavior
            // when GitHub has an added/right-side anchor available.
            if (options.reviewCommentLGTM) {
              const line = changedLineIndex.hunks[cleanHunk].addedLines[0]
              if (line !== undefined) {
                await commenter.bufferReviewComment(
                  filename,
                  line,
                  line,
                  'LGTM!'
                )
                reviewCount += 1
              }
            }
          }
          for (const hunkIndex of structured.reviewedHunks) {
            hunkCoverage.mark(filename, hunkIndex, 'reviewed')
          }
        } catch (e: any) {
          warning('Failed to validate review response (details withheld)')
          reviewsFailed.push(`${filename} (review failed)`)
          hunkCoverage.markFile(filename, 'failed_analysis')
        }
        hunkCoverage.markUnacknowledged(filename, patchesPacked)
      } else {
        reviewsSkipped.push(`${filename} (diff too large)`)
      }
    }

    const reviewPromises = []
    for (const [filename, fileDiff, patches] of filesAndChangesReview) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiConcurrencyLimit(async () => {
            await doReview(filename, fileDiff, patches)
          })
        )
      } else {
        skippedFiles.push(filename)
      }
    }

    await Promise.all(reviewPromises)
    statusMsg += `\n${summarizeReviewContextStatus(contextResults)}\n`

    for (const [filename] of filesAndChangesReview) {
      if (fileCoverage.get(filename) === 'failed_analysis') continue
      if (
        reviewsFailed.some(
          problem =>
            problem.startsWith(`${filename} (`) ||
            problem.startsWith(`${filename} comment failed`)
        )
      ) {
        fileCoverage.set(filename, 'failed_analysis')
      } else if (
        skippedFiles.includes(filename) ||
        budgetSkipped.has(filename)
      ) {
        fileCoverage.set(filename, 'blocked_by_budget')
      } else if (fileCoverage.get(filename) === 'pending') {
        fileCoverage.set(filename, 'reviewed')
      }
    }
    for (const filename of skippedFiles) {
      if (fileCoverage.get(filename) === 'pending') {
        fileCoverage.set(filename, 'blocked_by_budget')
        hunkCoverage.markFile(filename, 'blocked_by_budget')
      }
    }

    statusMsg += `
${
  reviewsFailed.length > 0
    ? `<details>
<summary>Files not reviewed due to errors (${reviewsFailed.length})</summary>

* ${reviewsFailed.join('\n* ')}

</details>
`
    : ''
}
${
  reviewsSkipped.length > 0
    ? `<details>
<summary>Files skipped from review due to trivial changes (${
        reviewsSkipped.length
      })</summary>

* ${reviewsSkipped.join('\n* ')}

</details>
`
    : ''
}
<details>
<summary>Review comments generated (${reviewCount + lgtmCount})</summary>

* Review: ${reviewCount}
* LGTM: ${lgtmCount}

</details>

---

<details>
<summary>Tips</summary>

### Chat with <img src="https://avatars.githubusercontent.com/in/347564?s=41&u=fad245b8b4c7254fe63dd4dcd4d662ace122757e&v=4" alt="Image description" width="20" height="20">  CodeRabbit Bot (\`@coderabbitai\`)
- Reply on review comments left by this bot to ask follow-up questions. A review comment is a comment on a diff or a file.
- Invite the bot into a review comment chain by tagging \`@coderabbitai\` in a reply.

### Code suggestions
- The bot may make code suggestions, but please review them carefully before committing since the line number ranges may be misaligned. 
- You can edit the comment made by the bot and manually tweak the suggestion if it is slightly off.

### Pausing incremental reviews
- Add \`@coderabbitai: ignore\` anywhere in the PR description to pause further reviews from the bot.

</details>
`
    // Publishing is part of the transaction: a model response alone does
    // not constitute a completed review. Never checkpoint partial coverage.
    // Recheck immutable PR scope immediately before any inline publishing.
    // If the PR changed while the LLM was running, its comments are stale.
    let scopeFresh = false
    try {
      const current = await octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: context.payload.pull_request.number
      })
      scopeFresh =
        current.data.head.sha === context.payload.pull_request.head.sha &&
        current.data.base.sha === context.payload.pull_request.base.sha
    } catch (e: any) {
      warning('Cannot verify current PR head (details withheld)')
    }
    if (!scopeFresh) {
      setFailed(
        'PR head/base changed or cannot be verified; refusing stale review publication'
      )
      return
    }

    const published = await commenter.submitReview(
      context.payload.pull_request.number,
      context.payload.pull_request.head.sha,
      statusMsg
    )
    const publishConfirmed =
      published && summariesFailed.length === 0 && reviewsFailed.length === 0
    const fileCompletion = assessReviewCompletion(
      files.map(file => file.filename),
      files.map(file => ({
        id: file.filename,
        status: fileCoverage.get(file.filename) ?? 'pending'
      })),
      publishConfirmed
    )
    const hunkSnapshot = hunkCoverage.snapshot()
    const hunkCompletion = assessReviewCompletion(
      hunkSnapshot.expectedIds,
      hunkSnapshot.entries,
      publishConfirmed
    )
    const completion = {
      complete: fileCompletion.complete && hunkCompletion.complete,
      blockers: [...fileCompletion.blockers, ...hunkCompletion.blockers]
    }

    if (completion.complete) {
      summarizeComment += `\n${commenter.addReviewedCommitId(
        existingCommitIdsBlock,
        context.payload.pull_request.head.sha
      )}\n${REVIEW_COMPLETE_TAG}\n${currentScopeMarker}`
    } else {
      // Keep only earlier successful checkpoint IDs, never add the new head.
      if (existingCommitIdsBlock) {
        summarizeComment += `\n${existingCommitIdsBlock}`
        if (existingSummarizeCmtBody.includes(REVIEW_COMPLETE_TAG)) {
          summarizeComment += `\n${REVIEW_COMPLETE_TAG}`
        }
      }
      summarizeComment += `\n> Partial review: latest head SHA not checkpointed
      (unprocessed or failed units: ${completion.blockers.length}).`
      warning(`Partial review: ${completion.blockers.join(', ')}`)
      setFailed('Review incomplete; no latest-head checkpoint recorded')
    }
  }

  // post the final summary comment
  await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, 'replace')
}
