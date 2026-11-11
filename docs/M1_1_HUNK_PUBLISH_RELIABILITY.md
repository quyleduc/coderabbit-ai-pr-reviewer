# M1.1 — Hunk coverage and replay-safe publisher

**Status:** change proposal, not production certification.

## Source-based rationale

The old CodeRabbit OSS Action uses one LLM request per file and packs only a subset
of diff hunks when token-limited. A successful model response does not imply all
hunks received review feedback. Prior code could delete earlier inline comments
before recreating them on retries.

Reference designs:
- PR-Agent: https://github.com/The-PR-Agent/pr-agent — incremental review state, budgets, inline fingerprint markers
- reviewdog: https://github.com/reviewdog/reviewdog — strict changed-line filtering, reporter contracts
- SARIF: https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support — stable finding identities

## Implemented here

1. Every parsed file hunk is a distinct tracked unit. Files with two hunks need
   two model acknowledgements; one LGTM or finding cannot imply both are done.
2. Over-budget hunks are explicitly blocked. Missing model acknowledgments and
   failures stop the completion checkpoint; partial findings may still be useful.
3. Before publishing, the PR's current head and base SHAs are checked against
   the event scope. If stale, no inline review is published.
4. Exact replay dedup uses a SHA-256 fingerprint of path, new-side line range and
   normalized comment text. Comment markers allow detection across separate runs.
5. Existing remote comments are read strictly, with pagination. Only the real
   github-actions bot identity counts toward suppression: arbitrary user-inserted
   markers do not suppress findings.
6. Publisher no longer deletes old inline comments. A failed or ambiguous batch
   publish does not automatically fall back to individual posts or set a checkpoint.
7. Tests cover hunk-level partial review and publication-fingerprint replay.

Source: src/review-hunks.ts, src/review-dedup.ts, src/review.ts, src/commenter.ts.

## Required acceptance gates

- Pure Node.js regression suite and TypeScript/Action bundle CI pass.
- Missing one of multiple hunks blocks completion.
- Replaying exactly the same comment does not create another candidate.
- API uncertainty does not yield a successful checkpoint.
- Changed head/base rejects stale inline publication.

## Important known gaps

- GitHub Compare API may cap/truncate changed files for very large PRs, requiring a
  separate acquisition hardening pass.
- Model output remains free-form text and does not constitute verified evidence.
- Only exact replay is deduplicated; semantically equivalent paraphrases can repeat.
- The GitHub comment checkpoint is not an atomic transactional datastore.
- There is a narrow race between the prepublish head check and GitHub API mutation.
- A stale run can leave an old in-progress summary that needs cleanup.
- Build dependencies are historical and require a separate security update.
- Benchmark precision/recall has not been measured against blind real-project PRs.

Do not merge solely on the basis of a positive AI-generated review. Require the
full CI and human inspection of the GitHub publication trust boundary.
