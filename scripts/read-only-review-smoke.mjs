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
export async function smokeReadOnlyPullRequest({
  expectedHead,
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

  const initial = await fetchHead()
  if (initial !== expectedHead) {
    throw new Error('Stale PR: head changed before smoke acquisition')
  }

  const files = []
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
      files.push(file)
    }
    if (batch.length < pageSize) {
      complete = true
      break
    }
  }
  if (!complete) throw new Error('GitHub PR files pagination exceeded safety limit')

  const available = files.filter(f => typeof f.patch === 'string' && f.patch.length > 0)
  let selected
  let index
  for (const file of available) {
    const next = buildChangedLineIndex(file.patch)
    if (next.valid && next.hunks.length <= 20) {
      selected = file
      index = next
      break
    }
  }
  if (!selected || !index) {
    throw new Error('No usable text diff patch in PR; inconclusive smoke')
  }

  // Identify one truly added line to make a SYNTHETIC test finding.
  // No assertion is made that the real source has a defect.
  const lines = selected.patch.split(/\r?\n/)
  let cursor = 0
  let evidence
  let addedLine
  let selectedHunk
  for (const raw of lines) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (match) {
      cursor = Number(match[1])
    } else if (raw.startsWith('+')) {
      const text = raw.slice(1).trim()
      const hunk = index.hunks.findIndex(h => h.addedLines.includes(cursor))
      if (text && hunk !== -1 && evidence === undefined) {
        evidence = text
        addedLine = cursor
        selectedHunk = hunk
      }
      cursor++
    } else if (raw.startsWith(' ')) {
      cursor++
    }
  }

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

  // Freshness check after acquisition (still no real mutation).
  if (await fetchHead() !== expectedHead) {
    throw new Error('Stale PR: head changed during smoke acquisition')
  }
  const verified = processStructuredReview(
    JSON.stringify({version: 1, hunks: modeled}),
    index,
    selected.patch,
    index.hunks.length
  )
  const candidates = verified.comments.map(c => ({
    path: selected.filename, ...c
  }))
  const planned = planReviewPublication(candidates, [])
  const calls = []
  const fakeTransport = {
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
    fakeTransport
  )
  if (!outcome.confirmed) {
    throw new Error('Fake GitHub publication was not confirmed')
  }
  const replay = planReviewPublication(
    candidates,
    planned.pending.map(c => c.message)
  )
  if (replay.pending.length !== 0) {
    throw new Error('Fake publication replay was not idempotent')
  }
  if (calls.some(c => c.kind !== 'create' && c.kind !== 'submit')) {
    throw new Error('Unexpected fake transport call')
  }

  return {
    status: 'PASS',
    headSha: expectedHead,
    retrievedFiles: files.length,
    reviewedFiles: 1,
    reviewedFile: selected.filename,
    reviewedHunks: verified.reviewedHunks.length,
    syntheticFindings: verified.comments.length,
    skippedNoPatch: files.length - available.length,
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
  const result = await smokeReadOnlyPullRequest({
    expectedHead,
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
      '\n\n**Selected file:** ' + result.reviewedFile +
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
