# M1.6 — Controlled model evaluation and fail-closed LLM responses

> Historical milestone record. The current six-case live evaluation, canonical
> rule catalog, per-case safe metrics, and quality gate are documented in
> [CONTROLLED_LIVE_EVALUATION.md](./CONTROLLED_LIVE_EVALUATION.md).

Status: Draft PR #8, stacked on Draft PR #7 → #6 → #5 → #4 → #3.
Main is not modified by this milestone.

## Purpose

Separate three different claims that were previously easy to confuse:

1. **Transport/source integrity:** can a verified diff and structured response
   pass source coordinates into a fake GitHub reviewer without losing hunks?
2. **Evaluator correctness:** can a metric calculator score known labeled
   examples and penalize false positives and missed findings?
3. **Actual model quality:** does a real LLM identify real bugs on independent,
   previously unseen embedded C projects? This is NOT proven by 1 or 2.

M1.6 establishes #2 on a small deterministic baseline and provides a
controlled **opt-in** path toward #3.

## Files and execution

- scripts/controlled-model-eval.mjs: source-backed benchmark, exact
  rule+line matching, mock fixture runner, and optional OpenAI Responses
  API probe. It has no GitHub mutation API at all.
- tests/fixtures/embedded-c-review.json: four deliberately small, human
  labeled, synthetic embedded-C diffs (null dereference risk, division by
  zero, out-of-bounds loop, and a semantically equivalent clean change).
- tests/controlled-model-eval.test.mjs: scoring, duplicate FP, missing FN,
  strict source evidence validation, fake Responses API transport, HTTP
  failures, incomplete/empty model output and no-call without an API key.
- tests/live-model-gates.test.mjs: production failure paths and trusted
  manually triggered workflow.
- .github/workflows/core-regression.yml: every PR runs a deterministic
  --mock benchmark without OpenAI credentials.
- .github/workflows/controlled-live-eval.yml: optional workflow_dispatch
  on **main only**, after the trusted implementation is merged. Repository
  secret OPENAI_API_KEY and explicitly entered OPENAI_MODEL are required.
  GitHub permissions are only contents:read; the script never posts PR
  comments or changes checkpoint state.

### Mock command (no API key or network required)

    node --experimental-strip-types scripts/controlled-model-eval.mjs --mock

The mock response is part of each fixture. The resulting 3 TP / 0 FP /
0 FN and perfect precision/recall/F1 mean **the test evaluator works on
predefined answers**. This is not a measure of actual LLM reliability.

### Live command (manual, paid, never executed as part of PR CI)

    OPENAI_API_KEY=... OPENAI_MODEL=<explicit-model-id> \
      node --experimental-strip-types scripts/controlled-model-eval.mjs --live

Run locally without putting a key in a commit or public shell output. Or,
**after code review and merge to default branch**, use the manually
triggered GitHub workflow on main with confirmation LIVE_MODEL_EVAL_ONLY,
model selection and a configured OPENAI_API_KEY repository secret.
The workflow never checks out an untrusted PR head with secret access.

The standalone model probe uses POST /v1/responses, store:false, bounded
output size and a 90-second timeout per request. Only aggregate numeric
results are logged. Invalid JSON, invented source evidence, missing hunks,
HTTP failures and incomplete responses abort the benchmark. On an error,
the CLI logs a generic failure only, never provider response body, source
diff, prompt or token.

OpenAI Responses API reference:
https://platform.openai.com/docs/api-reference/responses/create

**Compatibility qualification:** this standalone probe exercises the
production structured-review prompt and validator but uses the modern
Responses API directly; the legacy production Bot still uses the historical
chatgpt npm client. Therefore a successful live probe by itself is not
proof that production's model client or real GitHub publication works.

## Scoring methodology

Each prediction is matched to a human label by exact tuple
(new-side line number, rule_id) within a fixture. Each label can match
at most once: repeated predictions count as FP. Missing labels count as FN.

    precision = TP / (TP + FP)
    recall    = TP / (TP + FN)
    F1        = 2*precision*recall / (precision + recall)

For the empty-prediction/empty-label case, precision and recall are
defined as 1; for no predictions against known defects, precision is 0.
The benchmark records TP, FP and FN first, so these conventions are
explicit and reproducible.

This is a **strict rule/line benchmark**, not semantic equivalence:
two valid issue descriptions at nearby locations or with different rule IDs
may be judged different. Independent human labeling, larger representative
projects and reviewer adjudication are required before quality claims.

## Fail-closed production improvements

- src/bot.ts previously caught ChatGPTError and returned an empty string,
  silently conflating failed requests and a successful empty reply.
  Requests now throw a generic, redacted error after retry exhaustion.
  Empty requests and empty model output also throw.
- src/review.ts now refuses empty consolidated, final and short summaries
  instead of allowing a partial success path. No latest-head checkpoint
  may be advanced after such a failure.
- Review-chain contents are no longer dumped into the GitHub Actions log.
- src/prompts.ts uses an erasable type-only import so the public Node 22
  mock evaluator can run the SAME production prompt template.

Tests intentionally check both invalid provider responses and the
production bot/summary failure wiring; no external credentials are needed.

## Agent-skills review

Adapted established reviews, not claims of separate dispatched subagents:

- Obra Superpowers: RED–GREEN–verify, including fixing invalid unified diff
  test data rather than weakening the parser.
  https://github.com/obra/superpowers
- Matt Pocock engineering skills: separate specification, failure-path,
  security and test-quality checks.
  https://github.com/mattpocock/skills
- Ponytail: no new runtime agent framework or npm dependency; pure Node
  scripts, existing code paths, and a manually gated workflow only.
- Security: default-branch-only secret handling, no automatic paid API calls,
  no Github write scopes, no prompt/model output logging.

## Remaining production acceptance gates

1. API key availability has NOT been verified; no real OpenAI API invocation
   is claimed by this PR's passing mock tests.
2. A successful standalone Responses API probe is **not** an end-to-end
   production review. Real publication must be validated separately on a
   controlled PR after integrating the trusted branch.
3. The current fixture set is deliberately tiny and synthetic, containing
   short snippets rather than compilable whole-project embedded C builds.
   Its mock precision/recall is NOT production model precision/recall.
4. Published finding recall/precision should be evaluated against unseen
   independently labeled PRs (e.g. embedded drivers with pointer aliasing,
   ISR/task races, memory safety, MISRA-relevant control-flow defects).
5. GitHub publication/checkpoint is not an atomic transaction; exact-body
   deduplication is not semantic deduplication.
6. Legacy model client compatibility, dependency audits and full control
   of production token costs require separate release gates.
7. PR #3–#8 remain Draft and must not be merged solely because mock CI is
   green.

### Required evidence before claiming real-model quality

For a selected actual model and pinned evaluation run record the model ID,
API result completion status, fixture version, totals TP/FP/FN, precision,
recall and F1, invalid-response count, and the **human review** of each
reported defect. The evaluation is not certified unless these facts can
be reproduced without exposing secrets or source code in public logs.
