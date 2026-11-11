# M1.4 — Complete PR diff coverage audit (read-only)

Status: Draft PR #6, stacked on Draft PR #5 → #4 → #3.

## Question answered

Can our diff acquisition, changed-line index, strict JSON protocol and fake
GitHub reviewer account for **all** changed files and hunks in a *real* PR,
without silently ignoring missing or truncated patches?

M1.3 sampled the first suitable file and could return PASS while other files
were unexamined. M1.4 removes that false-completeness pattern in the
read-only smoke harness.

## Procedure and invariants

The workflow obtains current PR metadata and GETs the full PR-files list.
The expected changed_files count is compared with the number of retrieved
unique filenames after pagination. A repeated filename, page error, pagination
ceiling or any mismatch blocks PASS.

For **every** changed file:
- A textual unified-diff patch is required. Binary, pure rename without a
  patch, unsupported and oversized/truncated files are hard blockers,
  **not** silently marked as reviewed.
- The existing changed-line diff parser must validate the entire hunk body.
- GitHub per-file additions/deletions metadata must match independently
  counted +/- source lines. This detects some otherwise-valid partial diffs
  whose entire tail hunks were omitted.
- Files exceeding 20 hunks are rejected for this bounded smoke, never skipped.
- A fake model emits exactly one structured verdict per hunk: a synthetic
  test-only finding on a real added line when available, or a clean verdict.
  Deletion-only hunks also receive an explicit clean verdict; this is **not**
  an assessment of actual deletion correctness.
- The real structured JSON validator runs before any fake publication.
- HEAD SHA is verified before and after acquisition.
- One in-memory fake GitHub review batch is built from all files and a
  duplicate rerun must yield zero candidates. There are **zero remote writes**.

Fields returned: retrievedFiles, reviewedFiles, coveredFiles, reviewedHunks,
syntheticFindings, replayedCandidates, realGitHubMutations.

The smoke is a **protocol and transport audit**, not real model code review.
A "clean" synthetic verdict is not evidence that a human or AI checked logic.

## Trust boundary

This repository is **public**. No authenticated API key is required for
GitHub PR metadata. The smoke workflow is triggered by pull_request and
executes PR-branch code, so **never** pass GITHUB_TOKEN or any repository
secret to the script. It now uses unauthenticated public GitHub REST GETs.

Checkout sets persist-credentials:false. The Action runner uses read-only
permissions, no pull_request_target, no OpenAI key and no GitHub mutation
endpoints. Unauthenticated API requests are subject to GitHub's stricter
rate limit, which must produce a failure rather than false success.

For a private repository, use a separately trusted checkout/runner design;
do not add a credential back to this untrusted PR-head script.

## TDD evidence

- RED core regression run #42970818852: 7 new tests failed because the
  original smoke sampled one file and ignored coverage gaps.
- GREEN verified after implementing full per-file/per-hunk accounting.
- RED core regression run #42971189774: 2 new security tests caught
  GITHUB_TOKEN exposure and authenticated header in PR-head script.
- GREEN verified after using unauthenticated public GETs and removing
  workflow token injection.

See tests/full-pr-coverage.test.mjs, tests/read-only-pr-smoke.test.mjs and
tests/read-only-workflow-security.test.mjs.

### Reproduction

Node 22:
    node --experimental-strip-types --test tests/*.test.mjs

Actions:
- Core regression workflow: Node 22 tests; Node 20 TypeScript build and
  Action packaging.
- Read-only PR review smoke: actual pull request files + fake model/publisher.
Both must be SUCCESS on the exact current PR head SHA.

## Design review: spec / security / simplicity

Spec: all file and hunk units are accounted for, not only the first
available file. Missing or incomplete diff blocks PASS. A fake marker
validates line anchoring but not defect semantics.

Security: no real GitHub comments, no OpenAI key, no scoped GitHub token
exposed to code checked out from an untrusted PR.

Ponytail: extends the existing pure smoke/validator/publisher and uses Node's
built-in fetch. No framework, new runtime dependency, background agent or
another persistence layer. A small isolated regression suite is more useful
here than a speculative service architecture.

References:
- Obra Superpowers TDD and verification:
  https://github.com/obra/superpowers
- Matt Pocock code-review/testing skills:
  https://github.com/mattpocock/skills
- reviewdog changed-line diff filtering:
  https://github.com/reviewdog/reviewdog
- GitHub PR files API (up to 3,000 changed files):
  https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
- GitHub Actions token permissions:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication

## What is not yet proven

1. Full *real-model* review of those files: this uses synthetic verdicts only.
2. Bug precision, recall, severity or source-level semantic reasoning.
3. Actual remote publication, concurrent retry behavior or atomic checkpoint.
4. Large PRs over this smoke's 20 hunks/file safety bound, files without
   textual patches, PR-file API's 3,000 changed-file limit, or private repos.
5. Production acquisition still uses Compare API capped at 300 files; this
   safer paginated PR-files smoke is not automatically production adoption.
6. Immutable base SHA is not independently pinned by this smoke after
   acquisition. It pins head SHA, whereas production also checks base SHA.
7. Historical OpenAI client version, model compatibility and npm audit risk.
8. A credentialed end-to-end model+GitHub integration requires the owner to
   configure secrets and run a controlled PR on trusted default-branch code.

Do not merge a chain of stacked PRs as "production ready" merely because
synthetic transport tests and TypeScript builds pass.
