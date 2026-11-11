# M1.7 — Production Responses Adapter & Safe Live Acceptance Gate

Status: Draft PR #9, stacked on Draft PR #8 → #7 → #6 → #5 → #4 → #3.
Do not merge to main or claim a successful paid/live review from this work.

## Why this change

The production Action used an old chatgpt npm SDK (ChatGPTAPI) while M1.6
benchmarked a separate direct Responses API client. A successful mock
benchmark could not establish the actual production HTTP path was equivalent.

M1.7 replaces the production SDK with one dependency-free Responses
transport, src/responses-client.ts, used by both:
- src/bot.ts: production summary, review and comment replies, preserving
  the existing Bot.chat(prompt, ids) -> [text, ids] tuple contract.
- scripts/controlled-model-eval.mjs: opt-in, read-only model benchmark.

The transport is stateless: it sends each request separately, with store:false
and no previous_response_id. Current orchestrator callers all pass empty
conversation IDs and build the necessary review context into the prompt.
The returned ID object remains empty, rather than fabricating a conversation
the server has not stored.

## HTTP contract and safety

- POST to a validated /v1/responses endpoint using built-in Node fetch.
- Send model, top-level instructions, user input, bounded
  max_output_tokens and store:false.
- Parse only completed responses with actual message.output_text blocks.
- Missing/incomplete/refusal-only/malformed responses are errors, never
  treated as clean code or an empty successful summary.
- Honor explicit retry budget and per-attempt timeout. Retry only transport
  failures and temporary 408/429/5xx responses; 400/401/403/404 errors do
  not retry. Backoff is bounded.
- Never put provider error text, model input, full raw response, credentials,
  or request headers into thrown errors or Actions logs. Logs contain only
  elapsed time and generic failure information.
- Accept HTTPS configurable endpoints; plain HTTP is allowed only for
  loopback development. No credentials, fragments or query parameters
  are accepted in an endpoint URL.
- No new runtime dependency or agent framework.

The historical openai_model_temperature Action input remains accepted but
is explicitly ignored. Reasoning models may reject that parameter, so it is
NOT silently sent to Responses. This behavior must be visible in Action
input documentation and option logging.

## Default models and bounded budgets

As of 2026-11-11:
- Light summary: gpt-6-luna, conservative internal total 10,000 tokens,
  3,000 max model output.
- Heavy review: gpt-6.1-sol, conservative internal total 14,000 tokens,
  5,000 max model output.

These internal limits are deliberately far below the models' advertised
context windows. They control prompts/cost and are NOT proof of true API
token accounting. If a file or hunk cannot fit, production's existing
coverage ledger must block a completed-head checkpoint rather than drop it.
Model selection remains configurable in action.yml and the workflow.

Primary references:
https://developers.openai.com/api/reference/resources/responses/methods/create
https://developers.openai.com/api/docs/guides/deployment-checklist
https://developers.openai.com/api/docs/models/gpt-6-luna
https://developers.openai.com/api/docs/models/gpt-6.1-sol

## Dependency simplification

Removed the unused chatgpt SDK, p-retry, and top-level node-fetch packages
from package.json and the matching lockfile root. Removed the unused
fetch-polyfill.js file: Node 24 has built-in fetch. Transitive fetch packages
used by GitHub dependencies may still exist inside node_modules.

The existing npm ci, TypeScript build and Action packaging jobs must succeed
with the updated lockfile. This change does NOT claim a complete dependency
security audit or CVE remediation.

## Verification strategy

1. TDD RED run #42977837669: shared Responses module absent; existing
   baseline tests still passed while the new module test failed.
2. Configuration RED run #42978661175: 3 new checks caught obsolete
   model defaults, missing token envelopes and misleading temperature input.
3. GREEN: unit and mock HTTP tests for success, multiple text chunks,
   incomplete/refusal/empty outputs, 400/401/403 failures, 429/503 retries,
   network errors, bounded retry counts and redacted errors.
4. Fake end-to-end:
   Responses HTTP mock -> production source validator ->
   exact fingerprint deduplication -> injected fake GitHub review transport.
   Wrong source evidence blocks every fake GitHub write.
5. Existing CI suite: action bundle, no-prompt-logging safety tests and
   all earlier full-file/hunk coverage tests.
6. Actual PR read-only smoke: actual GitHub PR file list, validation,
   synthetic verdicts and fake GitHub publisher; no real model call.
7. Newest commit SHA must have its own SUCCESS Core regression and smoke
   runs. A passed earlier run does NOT prove a later commit.

Tests are executable without an OpenAI API key. No claimed mock score is
evidence of the model's precision/recall.

## Agent-skills review record

Superpowers (TDD, verify before completion):
- Tests committed first, RED observed in GitHub Actions, GREEN verified.
- Fail-closed conditions tested before discussing production readiness.

Matt Pocock spec/security review:
- Separate API behavior and error-mapping correctness from credential
  handling, review text validation and action workflow trust boundary.
- Negative tests confirm invalid output cannot become GitHub comments.

Ponytail:
- Eliminate the old SDK, fetch polyfill and redundant retry package.
- Keep the production class thin and reuse a single pure HTTP transport.
- Do not add an agent framework, extra SDK, cache, database or async
  background service.

These are review methodologies adapted here, not independent dispatched
review agents.

Skill references:
https://github.com/obra/superpowers
https://github.com/mattpocock/skills

## Live acceptance STILL outstanding

- Repo secret OPENAI_API_KEY has not been confirmed; do not expose it in
  chats, PR descriptions, committed scripts or public logs.
- The main-only manual workflow from M1.6 can exercise this shared transport
  ONLY AFTER the trusted implementation is reviewed and merged.
  It uses a selectable model and never posts GitHub comments.
- Actual GitHub inline review publication and summary checkpoint
  are NOT proven by this PR's mock tests. A separate, controlled
  live PR is needed to verify right-side anchors, one-time submission,
  rerun deduplication and base/head freshness.
- The old application and fixture benchmark have not been tested with a
  live billable model in these PRs. Model access, cost, latency, real JSON
  validity and embedded-C precision/recall all remain unverified.
- A full npm audit, semantic deduplication, atomic publication/checkpoint,
  and large-PR cost controls remain separate release gates.
- PR #3 through PR #9 are stacked Drafts. The current default branch still
  uses its existing trusted implementation, not this branch's model adapter.

Release decision: DO NOT MERGE as production-ready solely on synthetic
verification. Obtain explicit owner approval for any live model cost
and for posting review comments on a real PR.
