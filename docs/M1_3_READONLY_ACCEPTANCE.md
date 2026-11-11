# M1.3 — Read-only acceptance against an actual GitHub PR

**Status:** Draft PR #5, stacked on Draft PR #4, which is stacked on Draft PR #3.
Do not treat passing this smoke as an AI review or bug-detection benchmark.

## Goal

Verify that the new diff index, structured verdict validator, publication
deduplication and GitHub review batch builder can handle metadata from an actual
pull request without using an OpenAI API key or making any GitHub write request.

## Read-only trust boundary

Workflow: .github/workflows/read-only-pr-review-smoke.yml

- Trigger: pull_request (NOT pull_request_target).
- Workflow token permission scopes: contents:read, pull-requests:read.
- Checkout: persist-credentials:false.
- Only calls GitHub REST GET endpoints for current PR metadata and changed
  files (fetch, with its default GET method).
- No OPENAI_API_KEY is passed.
- No actual GitHub review, issue comment or PR metadata is modified.
- All simulated review mutations are in-memory functions.
- Run timeout is bounded to 10 minutes.

GitHub docs:
- https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files

## Integration route

1. Read immutable expected PR HEAD from the GitHub Actions event.
2. GET actual current PR head SHA and reject mismatches.
3. Read PR files using per_page=100 with explicit pagination and a hard limit
   of 30 pages (GitHub PR-files API documents up to 3,000 files).
4. Choose one usable text patch with valid unified-diff hunks; if none exists,
   reject rather than claiming full review.
5. Build a deterministic **synthetic** JSON model response:
   exactly one verdict per hunk of the selected file and at most one
   artificially generated test-only finding, with literal source-line evidence.
6. Validate with the same processStructuredReview() used by the production
   reviewer. Reject stale HEAD after acquisition.
7. Pass the proposed comments through the production exact-replay
   deduplication planner.
8. Execute publishReviewBatch() with an injected **in-memory fake** GitHub
   transport, never real GitHub mutation endpoints.
9. Verify replay candidates are zero and report the limited scope explicitly.

The smoke validates only **one** selected text file, not all files in the
PR. Its reported "reviewedFiles" field is 1, even when a PR has 5 files.
This deliberate sampling is not repository coverage.

## Observed evidence on actual PR #5

Earlier CI snapshot:
- Read-only PR smoke run:
  https://github.com/quyleduc/coderabbit-ai-pr-reviewer/actions/runs/42967614065
- Result: PASS.
- Actual PR metadata: 5 changed files retrieved; 1 file / 1 hunk sampled.
- Synthetic model output: 1 test-only finding.
- Simulated publication confirmed, second identical replay produced 0
  candidates, **actual GitHub writes = 0**.
- No model correctness, bug precision or recall measured.

TDD:
- RED: Core regression run 42967392999 failed because smoke module was absent.
- RED: Core regression run 42967515308 failed two focused tests that caught
  the redundant base-file contents request/dataflow.
- GREEN after implementation and simplification:
  Core regression run 42967614216 — 112/112 tests pass; TypeScript build and
  GitHub Action package pass. Newer commits must have their OWN matching green
  workflow run before merge approval.

## Simplification (Ponytail pass)

src/review.ts fetched original/base file contents for every selected diff,
then passed them as fileContent to doSummary() and doReview() even though
neither callback ever read the value. Removed the unused API call and the
redundant tuple element. Diff/hunk parsing became synchronous without needing
a concurrency wrapper for non-network work.

The regression specifically asserts no base-file getContent request remains
and the three actually used values (filename, diff, hunks) continue into both
summary and review paths. The patch deletes ~40 net lines without adding any
runtime dependency.

## Skills-derived review gates

- Obra Superpowers: test-first RED/GREEN and fresh CI SHA verification
  https://github.com/obra/superpowers
- Matt Pocock: separate specification and security/quality passes
  https://github.com/mattpocock/skills
- Ponytail: remove unused code before adding new dependency/framework

Findings:
- **Spec:** actual PR GET, page traversal, stale SHA, fake model validation,
  fake publisher and replay exercised; intentionally one file sampled.
- **Security:** unprivileged PR event, scoped read-only token, no secret, no
  remote write path in script, no persistent checkout credentials.
- **Simplicity:** removed unused base-content calls, no new runtime package.

## Not covered, and next acceptance gate

- No credentialed OpenAI API call: the secret OPENAI_API_KEY has not been
  confirmed/configured for the live reviewer.
- No live GitHub review/comment write; fake publication is not a live E2E.
- No compiler-aware semantics or independently labeled PR bug findings.
- The historical main branch uses an outdated client/model configuration;
  dependency compatibility and security audit remain separate.
- The production comparison still uses GitHub's compareCommits endpoint,
  whose 300-file cap is handled by fail-closed rejection. The smoke uses the
  PR-files GET endpoint, but the production acquisition has NOT been changed.
- The smoke checks one file; it must not be used as coverage or detection
  recall evidence.
- Summary checkpoint and publication are not an atomic transaction.

Before production:
1. Integrate #3, #4 and #5 only when their individual release gates are met.
2. Configure OPENAI_API_KEY through GitHub Actions repository secrets, never
   through PR text, a code commit or a ChatGPT message.
3. On a controlled **small** PR, verify the real model's JSON response,
   correct in-diff comments, author identity, idempotent rerun and
   fail-closed behavior for bad responses.
4. Then evaluate precision/recall on human-labeled unseen embedded-C PRs.

No live model or real publication success is claimed by this milestone.
