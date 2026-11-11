# M1.5 — Production full-PR paginated file acquisition

Status: Draft PR #7, stacked on Draft PRs #6 → #5 → #4 → #3.

## Decision

**Review the complete current base→head PR diff at each new head SHA.**

The old reviewer used two repos.compareCommits() calls:
(1) base or last reviewed SHA → current SHA, (2) base → current SHA.
It selected their intersecting filenames to avoid re-reviewing untouched files.
The Compare API exposes only the first 300 changed file entries; intersecting
two incomplete lists can silently exclude an affected file even when each
individual hunk parser is correct.

The replacement uses octokit.pulls.get() to pin the current PR head, base and
changed_files count, then octokit.pulls.listFiles() with per_page=100 until
that exact count has been fetched. The file list is used directly: it is the
full current PR scope, **not** an incremental Compare-based subset.

**Trade-off:** after HEAD changes, unchanged PR files are summarized/reviewed
again. This is intentionally more expensive in tokens and time, but avoids
incomplete incremental selection. Exact previously-published comment bodies
are still deduplicated by the existing publisher where possible. This is
NOT semantic deduplication. Later incremental work must establish a complete
file scope independently before optimizing changed-hunk selection.

## Strict acquisition contract

Pure module: src/pr-files.ts.

loadCompletePullRequestFiles(expectedFileCount, fetchPage, options)
- Refuses missing/invalid/non-integer/0 counts or >3,000 files.
- Refuses empty, oversized or invalid pages, duplicate filenames, early short
  pages, and a total count not matching authoritative changed_files.
- Propagates GitHub API errors; never treats failed reads as an empty page.
- Supports the documented 3,000 file maximum (30 full pages x 100).
- Uses no new dependency or additional GitHub write permission.

verifyPullRequestPatch(file)
- Required for each **eligible** file before in-progress summary or LLM calls.
- Refuses missing/non-text patch data, invalid hunk metadata, unknown hunk
  content, inconsistent old/new hunk line counts and missing additions/deletions.
- Cross-checks the full GitHub file metadata addition/deletion totals with
  literal +/- patch lines, catching omitted whole hunks where individual
  remaining hunks are valid.
- Ignored file paths remain explicitly ignored_by_policy. A selected binary,
  pure rename without textual patch, oversized/truncated diff or unsupported
  change **blocks checkpointing** rather than pretending to have been reviewed.

## SHA and checkpoint correctness

- The initial pulls.get() response must match BOTH base SHA and head SHA from
  the immutable GitHub Actions event before file acquisition.
- A completion marker now includes a base+head scope marker:
  coderabbit:review-scope-v1:BASE:HEAD.
- Old completed-head comments without this marker will conservatively be
  reviewed again once. A retargeted base cannot reuse a checkpoint from the
  previous base even if head SHA is identical.
- Existing scope recheck immediately before GitHub publication remains in
  src/review.ts. A retarget/force push mid-analysis blocks publishing.
- The metadata checks do NOT make GitHub publication and summary checkpoint
  atomic. That remains separate durable-state work.

## Tests and actual GitHub evidence

New tests: tests/pr-files.test.mjs and tests/pr-files-wiring.test.mjs.
Test matrix:
- Multiple full/short pages; 300-file and 3,000-file valid scopes.
- >3,000 files rejected BEFORE fetching; no silent Compare API cap.
- Duplicate names; missing pages; metadata mismatch; API 403 errors.
- Missing selected binary patch; malformed/truncated patch/hunk.
- Base/head-scoped checkpoint and production adapter uses pulls.listFiles.
- Updated old M1.1 source contracts to assert the new correct behavior.
- Read-only smoke script now imports and calls **the exact same acquisition
  and patch validation module as production**, rather than duplicating its
  own slightly weaker file traversal.
- Real GitHub read-only smoke is unprivileged, no GitHub token or OpenAI
  secret in PR-head code, no actual review comments.

Verification gate: CI Core regression (portable Node tests + TypeScript
build and Action packaging) AND real read-only PR smoke must finish SUCCESS
on the exact latest head SHA. No passing run on a previous SHA is sufficient.

## Engineering review

Superpowers TDD: new tests and wiring rules were committed before production
changes, and observed to fail. Implemented production handler and verified
full green regression/Action build.

Matt Pocock spec/security split:
- Spec: authoritative PR scope, no sampling, explicit fail-closed metadata,
  correct changed-line index and unchanged publication state machine.
- Security: trusted default-branch reviewer remains the only workflow able
  to use repository OpenAI credentials; untrusted PR smoke receives no token.
  PR title/description/source remain untrusted LLM inputs.
- Limitation: no model-API integration or real GitHub review write tested.

Ponytail:
- Two Compare API requests + PR commit pagination + intersection are removed
  from the reviewer. The new function is small, reusable and pure; smoke
  imports it directly. No new runtime package, service, database or agent
  framework was introduced.

Methodology references:
- https://github.com/obra/superpowers
- https://github.com/mattpocock/skills
- https://github.com/reviewdog/reviewdog
- https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files

## Explicit remaining limits

- 3,000 changed-file GitHub PR-files API cap; requests with >3,000 fail closed.
- Token/context budgets and the default max_files setting may block a large
  PR even if all its metadata is acquired. Acquisition completeness is NOT
  the same as model semantic review completeness.
- Deletion-only hunks cannot be attached to RIGHT-side inline comments;
  clean verdicts are synthetic in smoke and do NOT prove deletions harmless.
- Retried publication can produce newly paraphrased findings; dedup only
  covers exact publisher fingerprints.
- The historical chatgpt SDK and configured model must still be validated in
  an actually credentialed, controlled live review. Existing review workflow
  success on a PR may run trusted old main-branch code and skip due to missing
  OPENAI_API_KEY; do not interpret that as E2E evidence.
- No labeled embedded-C precision/recall benchmark, no atomic transaction
  between GitHub review publication and summary checkpoint.
- All PR #3–#7 are stacked Drafts and have NOT been merged into main.
