# Agent engineering and PR-review guidance

This file applies to the historical CodeRabbit OSS fork. Keep the GitHub Action
usable as a trusted reviewer of untrusted pull request content.

## Scope and workflow

- Use a feature branch; never modify main directly. Pin base and head SHAs.
- Before implementation, read relevant source, caller and tests. A passing
  workflow does not prove the LLM reviewed code: without OPENAI_API_KEY,
  the historical default-branch Action skipped actual analysis.
- Under pull_request_target, check out only trusted base-repository code.
  Treat PR code, filenames, review comments and LLM output as untrusted.
- Never execute PR-head scripts with credentials or log model prompts,
  replies, secrets or user-supplied system prompts.

## Independent review passes

Review substantive PRs through two separate lenses:

1. **Spec/behavior:** expected hunk coverage, correct changed-line coordinates,
   no false-complete checkpoint, GitHub publisher acknowledgement, retry and
   idempotency, partial-run behavior and meaningful failure-injection tests.
2. **Standards/security/maintainability:** trust boundaries, log redaction,
   GitHub API failure handling, type safety, performance and code smells.

Do not merge these verdicts into a single approval if either has blockers.
A third **Ponytail** pass should identify deletions and standard library
alternatives but preserve seams that enable concrete error-path testing.

## Verification gates

- Reproduce a bug first, then test RED and GREEN against the relevant module.
  Prefer behavioral tests; source-grep contracts complement, not replace them.
- Run the Node 22 portable suite:
    node --experimental-strip-types --test tests/*.test.mjs
  Then run:
    npm ci
    npm run build
    npm run package
  Confirm the current PR HEAD matches the completed green workflow run.
- Unknown or failed GitHub API outcomes may not advance the reviewed head SHA
  and may not trigger blind publication retry.
- Explicitly disclose when the live credential-dependent model/review path
  has not been tested. Unit and build checks are not E2E integration evidence.
- Do not add new agent frameworks, dependencies or abstractions without an
  observed use case and measured benefit.

## Severity and reporting

- Critical: trust boundary bypass, leak of secret/source to unauthorized logs,
  false-complete checkpoint or destructive duplicate publication.
- Important: missed hunks, invalid locations, GitHub API failure gaps.
- Minor: readability, wrappers, naming, formatting.

For each finding: provide file and lines, triggering input, observable test,
fix status and remaining risk. Leave PR Draft while blockers remain.

## Source methodology: adapt workflows, not runtime dependencies

- Obra Superpowers: https://github.com/obra/superpowers
- Matt Pocock engineering review, TDD and debugging:
  https://github.com/mattpocock/skills
- Anthropic code-simplifier reference:
  https://github.com/anthropics/claude-plugins-official
- PR-Agent: https://github.com/The-PR-Agent/pr-agent
- reviewdog: https://github.com/reviewdog/reviewdog

This file guides future code reviews. No independent subagent is claimed
unless one is actually dispatched and its results are verified.
