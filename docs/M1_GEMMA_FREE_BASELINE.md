# M1 — Gemma 4 31B Free: one-model PR reviewer baseline

## Goal

Make the **existing** source-validated reviewer useful before adding model routing,
reasoning escalation, or new static-analysis features:

1. Fetch complete PR patches from the trusted base-repository workflow.
2. Summarize changed files and the PR with one OpenRouter model.
3. Produce structured, source-backed inline findings on changed lines.
4. Validate every hunk, line and evidence against the actual diff.
5. Publish only after the independent, explicitly gated acceptance exercise.

**Selected free model:** `google/gemma-4-31b-it:free`.
Model listing: https://openrouter.ai/google/gemma-4-31b-it:free

### Real-world limitations

The model page advertises code and JSON output capabilities, **not** strict JSON
Schema guarantee. Provider behavior can change. OpenRouter's free `:free` tier
is rate-limited (normally 20 requests/minute and 50/day unless the account has
the qualifying credits); failed requests also count. Keep test PRs small.

This version does not yet prove benchmark quality, provider reliability,
correct GitHub publication on a real PR, or readiness for confidential source.
Do not send private/company code without reviewing the provider's data policy.

## Repository setup

In GitHub > Settings > Secrets and variables > Actions:

- Repository secret `OPENROUTER_API_KEY` (never paste it in a PR or action input).
- Repository variable `LLM_PROVIDER=openrouter`.
- Optional variables `LLM_LIGHT_MODEL=google/gemma-4-31b-it:free` and
  `LLM_HEAVY_MODEL=google/gemma-4-31b-it:free`. When `LLM_PROVIDER=openrouter`
  these are already the trusted workflow's defaults; explicitly set them to
  pin the intent.
- **Do not enable** `ENABLE_AUTOMATED_PR_REVIEWS` before manual acceptance.

The existing trusted `.github/workflows/openai-review.yml` uses the base
branch and continues to protect review publishing behind explicit opt-in.
Gemma's production token policy currently reserves 4096 tokens for responses
and conservatively caps the review request at 15804 estimated tokens. Token
estimates use a generic tokenizer, not Gemma-native token counts.

## Step A — safe, read-only provider evaluation

Open GitHub Actions > **Controlled live model evaluation (no GitHub writes)**,
select main, then **Run workflow**:

```text
confirm: LIVE_MODEL_EVAL_ONLY
provider: openrouter
model: google/gemma-4-31b-it:free
reasoning_effort: omit
max_output_tokens: auto
```

`omit` means the request **omits the reasoning parameter**. It does not claim
to forcibly disable a provider's internal reasoning. For this M1 preset the
program also omits reasoning when no explicit effort is selected; other
OpenRouter model behavior remains unchanged.

The evaluation uses the production JSON validator on four embedded-C fixture
patches (null deref, divide by zero, out of bounds, semantic no-op). Required
baseline for M1: **all four parse and validate; TP=3, FP=0, FN=0** under the
existing fixture labels. Mock CI scores do **not** count as live evidence.

No GitHub review or comment is published by this step.

## Step B — actual isolated pull request acceptance

Only after Step A succeeds:

1. Use a **Draft** `acceptance/*` PR containing one known changed C defect and
   the exact marker required by `scripts/acceptance-gate.mjs`. Confirm the
   expected rule ID and added line from the diff.
2. In **Controlled live PR acceptance (manual)** provide the exact Draft PR,
   40-character head and base SHAs, expected rule/line, provider `openrouter`,
   and the Gemma model ID.
3. Run `preflight` with `PREFLIGHT_ACCEPTANCE_ONLY`.
4. Run `model-only` with `VALIDATE_ACCEPTANCE_MODEL`.
5. Configure GitHub environment `controlled-review-acceptance` with required
   reviewers **before** the explicitly authorized `publish` step. Use
   `PUBLISH_ACCEPTANCE_REVIEW` only on this isolated acceptance PR.

The publish step is privileged; never test it on a real work PR. A successful
review must be confirmed by reading back the posted GitHub review, without
duplicates or unsupported source evidence.

## M1 done means

- A verified real OpenRouter model call with valid JSON for all four fixtures.
- An isolated Draft acceptance PR passes the read-only and model-only gates.
- Explicitly approved publication to that isolated PR is verified, with correct
  anchor and checkpoint.
- No unauthorized GitHub writes, hidden partial-success checkpoints or leaked
  credentials/source.
- Regression and dependency audit green at the exact accepted commit.

## Next feature milestones

**M2:** targeted cross-file context (callers, headers, macros, data flow); limit
retrieval and token spend.

**M3:** review-thread Q&A, code fix suggestions, incremental review and stale
finding reconciliation.

**M4:** embedded C evidence analysis (pointer aliasing, ISR/races, AUTOSAR,
volatile/registers), optionally integrate ECA.

**M5:** end-user configuration and review policy, GitHub Check summaries,
performance/cost telemetry, larger PR scaling and production operations.

Reasoning escalation is optional and **not a dependency for M1**.
