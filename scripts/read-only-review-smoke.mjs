import {readFileSync, appendFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {buildChangedLineIndex} from '../src/diff-hunks.ts'
import {processStructuredReview} from '../src/review-protocol.ts'
import {planReviewPublication} from '../src/review-dedup.ts'
import {publishReviewBatch} from '../src/review-publication.ts'

/**
 * Actual GitHub PR file acquisition, fake model, fake publisher.
 * NO remote write operation is supported by this file.
 *
 * This is a transport/coordinate smoke test, NOT a code-review accuracy test.
 */
/**
 * Evaluate every changed GitHub PR file, never silently sample one.
 * Verdicts here are synthetic; this tests transport and coverage, not bugs.
 */
export async function smokeReadOnlyPullRequest({
  expectedHead,
  expectedFileCount,
  fetchHead,
  fetchPage,
  pageSize = 100,
  maxPages = 30
}) {
  if (!/^[0-9a-f]{40}$/i.test(expectedHead) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new TypeError('Invalid PR smoke scope')
  }
  if (expectedFileCount !== undefined &&
      (!Number.isSafeInteger(expectedFileCount) ||
       expectedFileCount < 1 || expectedFileCount > 3000)) {
    throw new Error('Invalid or unsupported GitHub PR file count')
  }

  if (await fetchHead() !== expectedHead) {
    throw new Error('Stale PR: head changed before smoke acquisition')
  }

  const files = []
  const filenames = new Set()
  let complete = false
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page, pageSize)
    if (!Array.isArray(batch) || batch.length > pageSize) {
      throw new Error('Invalid GitHub PR files page')
    }
    for (const file of batch) {
      if (typeof file?.filename !== 'string' || !file.filename) {
        throw new Error('GitHub PR files response missing filename')
      }
      if (filenames.has(file.filename)) {
        throw new Error('Duplicate GitHub PR filename: ' + file.filename)
      }
      filenames.add(file.filename)
      files.push(file)
    }
    if (batch.length < pageSize) {
      complete = true
      break
    }
  }
  if (!complete) throw new Error('GitHub PR files pagination exceeded safety limit')
  if (files.length === 0 ||
      (expectedFileCount !== undefined && files.length !== expectedFileCount)) {
    throw new Error('GitHub PR changed file count mismatch or empty PR')
  }

  // Build and verify EVERY file's complete local diff before invoking even
  // the fake publisher. Missing binary/oversized patches are hard blockers.
  let totalHunks = 0
  const candidateComments = []
  const coveredFiles = []
  for (const file of files) {
    if (typeof file.patch !== 'string' || file.patch.length === 0) {
      throw new Error('Missing or unavailable GitHub patch: ' + file.filename)
    }
    const index = buildChangedLineIndex(file.patch)
    if (!index.valid) {
      throw new Error('Invalid or malformed diff patch: ' + file.filename +
        ' (' + index.reason + ')')
    }
    if (index.hunks.length > 20) {
      throw new Error('Too many hunks in file, exceeds smoke safety limit: ' + file.filename)
    }

    const source = file.patch.split(/\r?\n/)
    const addedCount = source.filter(line => line.startsWith('+')).length
    const deletedCount = source.filter(line => line.startsWith('-')).length
    // The REST file metadata is our independent check against a diff whose
    // individual hunks look valid but one or more complete hunks are missing.
    if ((Number.isSafeInteger(file.additions) && file.additions !== addedCount) ||
        (Number.isSafeInteger(file.deletions) && file.deletions !== deletedCount)) {
      throw new Error('Truncated patch line count mismatch: ' + file.filename)
    }
    // In live Actions, both counts must be present for every file.
    if (expectedFileCount !== undefined &&
        (!Number.isSafeInteger(file.additions) ||
         !Number.isSafeInteger(file.deletions))) {
      throw new Error('GitHub file metadata missing additions/deletions: ' + file.filename)
    }

    let cursor = 0
    let evidence
    let addedLine
    let selectedHunk
    for (const raw of source) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (header) {
        cursor = Number(header[1])
      } else if (raw.startsWith('+')) {
        const candidate = raw.slice(1).trim()
        const hunk = index.hunks.findIndex(h => h.addedLines.includes(cursor))
        if (candidate && hunk !== -1 && evidence === undefined) {
          evidence = candidate
          addedLine = cursor
          selectedHunk = hunk
        }
        cursor++
      } else if (raw.startsWith(' ')) {
        cursor++
      }
    }

    // One synthetic test-only finding per file with an added code line.
    // Deletion-only diffs receive explicit clean verdicts for all hunks.
    const modeled = index.hunks.map((_, h) => {
      if (selectedHunk === h && addedLine !== undefined) {
        return {
          id: 'h' + h,
          status: 'issues',
          findings: [{
            line: addedLine,
            rule_id: 'SMOKE_ONLY',
            severity: 'low',
            message: 'Synthetic transport-only marker, not a real code defect.',
            evidence
          }]
        }
      }
      return {id: 'h' + h, status: 'clean', findings: []}
    })

    const verified = processStructuredReview(
      JSON.stringify({version: 1, hunks: modeled}),
      index,
      file.patch,
      index.hunks.length
    )
    totalHunks += verified.reviewedHunks.length
    coveredFiles.push(file.filename)
    for (const comment of verified.comments) {
      candidateComments.push({path: file.filename, ...comment})
    }
  }

  if (await fetchHead() !== expectedHead) {
    throw new Error('Stale PR: head changed during smoke acquisition')
  }

  const planned = planReviewPublication(candidateComments, [])
  const calls = []
  const transport = {
    async createReview(request) {
      calls.push({kind: 'create', request})
      return 1
    },
    async submitReview(id, body) {
      calls.push({kind: 'submit', id, body})
    },
    async discardPendingReview() {
      throw new Error('Unexpected fake rollback')
    }
  }
  const outcome = await publishReviewBatch(
    planned.pending,
    expectedHead,
    'Synthetic read-only validation. No real GitHub comments were posted.',
    transport
  )
  if (!outcome.confirmed) {
    throw new Error('Fake GitHub publication was not confirmed')
  }
  const replay = planReviewPublication(
    candidateComments,
    planned.pending.map(comment => comment.message)
  )
  if (replay.pending.length !== 0) {
    throw new Error('Fake publication replay was not idempotent')
  }
  if (calls.some(call => call.kind !== 'create' && call.kind !== 'submit')) {
    throw new Error('Unexpected fake transport call')
  }

  return {
    status: 'PASS',
    headSha: expectedHead,
    retrievedFiles: files.length,
    reviewedFiles: coveredFiles.length,
    coveredFiles,
    reviewedHunks: totalHunks,
    syntheticFindings: candidateComments.length,
    skippedNoPatch: 0,
    fakeReviewConfirmed: outcome.confirmed,
    fakeTransportOperations: calls.length,
    replayedCandidates: replay.pending.length,
    realGitHubMutations: 0
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!eventPath || !repository || !token) {
    throw new Error('Read-only PR smoke requires Actions event, repository and read-only token')
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const number = event.pull_request?.number
  const expectedHead = event.pull_request?.head?.sha
  if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/i.test(expectedHead)) {
    throw new Error('Expected a real pull_request event and immutable HEAD')
  }
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
    throw new Error('Invalid repository name in GitHub Actions environment')
  }

  const url = 'https://api.github.com/repos/' + repository + '/pulls/' + number
  const readApi = async endpoint => {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!response.ok) throw new Error('GitHub read-only HTTP ' + response.status)
    return response.json()
  }
  const currentPR = await readApi(url)
  const result = await smokeReadOnlyPullRequest({
    expectedHead,
    expectedFileCount: currentPR.changed_files,
    fetchHead: async () => (await readApi(url)).head.sha,
    fetchPage: async (page, pageSize) =>
      readApi(url + '/files?per_page=' + pageSize + '&page=' + page)
  })
  console.log(JSON.stringify(result, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '## Real PR diff, synthetic model, fake GitHub review\n' +
      '\n**Result:** ' + result.status +
      '\n\n**Files fetched:** ' + result.retrievedFiles +
      '\n\n**Files audited:** ' + result.reviewedFiles +
      '\n\n**Hunks checked:** ' + result.reviewedHunks +
      '\n\n**Synthetic findings:** ' + result.syntheticFindings +
      '\n\n**Actual GitHub writes:** 0\n' +
      '\nThis does not measure model accuracy or use OpenAI credentials.\n'
    )
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
