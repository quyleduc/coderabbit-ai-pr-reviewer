# Bounded Context Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, testable Embedded C review-context provider contract and render its selected context in the existing strict hunk-review prompt.

**Architecture:** A pure TypeScript module validates provider facts, binds them to the pinned PR head and selected build variant, ranks them deterministically, and enforces the approved file/snippet/byte/token/time caps. `review.ts` accepts an optional provider; the Action entry point does not configure an ECA provider yet, so ordinary runs remain explicitly hunk-only until ECA's quality gate and producer schema are accepted.

**Tech Stack:** Existing TypeScript 5.9, Node.js 22 portable test runner, existing `@dqbd/tiktoken` tokenizer, GitHub Actions on Node 24; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-m2-eca-context-retrieval-design.md`

## Global Constraints

- Base commit: `672a3f2261f707ba206041a41e98b44e3f8e891e`; work only on `design/m2-eca-context-retrieval`.
- Limits: 8 files, 12 snippets, 16 KiB of source text, 4,096 estimated context tokens, 2 seconds per retrieval request.
- Bind every item to the exact `head_sha`, `blob_sha`, line range, relation, status, symbol, and requested variant.
- Allowed fact statuses are `SUPPORTED`, `PARTIAL`, `UNKNOWN`, `UNSUPPORTED`, and `UNMATCHED`; preserve uncertainty labels.
- Findings remain limited to added lines in their original diff hunk with exact source evidence; context cannot supply an inline anchor.
- With no provider, a stale/malformed result, timeout, or unsupported variant, use the existing hunk-only review and report the context status.
- Do not change the strict JSON review protocol, publication/checkpoint behavior, model choice, automatic-review opt-in, or M1 acceptance PR.
- Do not execute PR code or add dependencies.
- Do not implement a production ECA adapter before the ECA pointer correctness/coverage gates for littlefs, FreeRTOS-Kernel, and lwIP and an accepted ECA producer schema.

## Review Focus

- Stale head or mismatched variant: reject the fact and produce a hunk-only result; pin in Task 1.
- Unsafe path, malformed SHA, invalid range, unknown relation/status, or excerpt/range mismatch: reject the entire provider result with a stable reason and fall back to hunk-only review; pin in Task 1.
- PARTIAL/UNKNOWN/UNSUPPORTED/UNMATCHED facts: label them as uncertain and never treat them as validated defect evidence; pin in Tasks 1 and 2.
- Candidate sets at file/snippet/byte/token boundaries: deterministic ordering, stop reason, and no silent truncation; pin in Task 1.
- Missing, failing, or non-cooperative provider: report a stable unavailable reason and continue hunk-only; pin in Tasks 1 and 2.

---

### Task 1: Provider contract and bounded deterministic selection

**Files:**
- Create: `src/review-context.ts`
- Test: `tests/review-context.test.mjs`

**Interfaces:**
- Produces `ReviewContextCandidate` with `headSha`, `blobSha`, `path`, `startLine`, `endLine`, `symbolId`, `relation`, `variantId`, `status`, `graphDistance`, `provenance`, and `excerpt`.
- Produces `ReviewContextProvider` with trusted `variantId` and `collectCandidates(request, signal)`.
- Produces `ReviewContextRequest` containing repository ID, PR number, base/head SHA, changed filename, and validated hunk ranges/patches.
- Produces `retrieveReviewContext(provider, request, limits?)` returning selected snippets, stable unavailable/skip reasons, and estimated token/byte totals.

- [ ] **Step 1: Write failing contract and ranking tests**

In `tests/review-context.test.mjs`, add behavior tests for valid candidate selection and stable tie-breaking; exact head/variant checks; malformed path/SHA/range/relation/status and excerpt-length rejection; duplicate elimination; deterministic file/snippet/byte/token caps; uncertain status labeling; absent provider; provider error; timeout; and whole-result fallback when any identity or structure check fails. Assert that a single oversized snippet yields no context, while candidate-count caps retain a deterministic bounded prefix and record omitted-candidate reasons. Assert each result contains stable reason codes and never throws on provider failures.

- [ ] **Step 2: Run the new tests and confirm they fail for missing behavior**

Run: `node --experimental-strip-types --test tests/review-context.test.mjs`  
Expected: failures because `review-context.ts` does not yet export the contract and selector.

- [ ] **Step 3: Implement the minimal provider contract and selector in `src/review-context.ts`**

Validate the complete provider response before selection. Any stale head, variant mismatch, malformed candidate, unsafe path, invalid line bounds, unsupported relation/status, or excerpt line-count mismatch returns an empty context result with a stable reason. Rank by graph distance, then the fixed relation order CALLS, READS, WRITES, EXPANDS_MACRO, INCLUDES, ALIASES, then path, symbol ID, and line. Deduplicate by path/range/symbol/relation/variant. Enforce all five approved limits without truncating a snippet: a single snippet too large for the byte/token cap returns no context; when only aggregate file/snippet caps omit lower-ranked candidates, return a bounded deterministic prefix with an explicit omission reason. Catch provider exceptions and timeout, abort the request signal, and return a stable unavailable status.

- [ ] **Step 4: Re-run the new tests and confirm they pass**

Run: `node --experimental-strip-types --test tests/review-context.test.mjs`  
Expected: all new tests pass, including budget boundaries and fallback cases.

- [ ] **Step 5: Commit the provider contract**

```bash
git add src/review-context.ts tests/review-context.test.mjs
git commit -m "feat: add bounded review context provider"
```

### Task 2: Render context safely and connect the optional provider seam

**Files:**
- Modify: `src/inputs.ts`
- Modify: `src/prompts.ts`
- Modify: `src/review.ts`
- Test: `tests/review-context-prompt.test.mjs`
- Test: `tests/review-context-wiring.test.mjs`

**Interfaces:**
- Consumes `ReviewContextProvider`, `ReviewContextRequest`, and `retrieveReviewContext` from Task 1.
- Adds `Inputs.reviewContext: string`; `clone()` preserves it and `render()` replaces `$review_context`.
- `codeReview(lightBot, heavyBot, options, prompts, contextProvider?)` accepts an optional provider. Existing callers remain valid.
- Produces a prompt section with provider status, provenance, and selected excerpts clearly marked as untrusted reference context. The strict response JSON contract and changed-line validator remain unchanged.

- [ ] **Step 1: Write failing prompt and wiring tests**

In `tests/review-context-prompt.test.mjs`, assert that empty context leaves the prompt hunk-only, populated context includes status/provenance/excerpt under an untrusted-context heading, and context instructions forbid findings anchored to context-only lines.

In `tests/review-context-wiring.test.mjs`, assert that the optional provider is queried only after PR SHA/hunk validation, the retrieved context is included before request-token counting and model invocation, no-provider and provider-failure states are reported, the ordinary `main.ts` entry point supplies no production ECA provider, and `processStructuredReview` still validates findings against the original changed-line index.

- [ ] **Step 2: Run the new tests and confirm they fail for missing wiring**

Run: `node --experimental-strip-types --test tests/review-context-prompt.test.mjs tests/review-context-wiring.test.mjs`  
Expected: failures because the input field, prompt section, and provider seam do not exist.

- [ ] **Step 3: Add optional context rendering and retrieval to the review path**

Thread `reviewContext` through `Inputs` cloning/rendering. Add the untrusted context section and instruction to `reviewFileDiff`. In `review.ts`, keep the default provider absent, query an injected provider with the exact immutable PR scope and validated file hunks, include the formatted selection before token counting, and record a concise context status in the existing review status comment. Preserve the current model output schema, evidence validation, publication, and checkpoint flow. Do not wire an ECA provider in `main.ts`.

- [ ] **Step 4: Re-run the new tests and confirm they pass**

Run: `node --experimental-strip-types --test tests/review-context-prompt.test.mjs tests/review-context-wiring.test.mjs`  
Expected: all new rendering and source-wiring tests pass; the default path reports hunk-only context status.

- [ ] **Step 5: Commit the prompt integration**

```bash
git add src/inputs.ts src/prompts.ts src/review.ts tests/review-context-prompt.test.mjs tests/review-context-wiring.test.mjs
git commit -m "feat: include bounded context in review prompts"
```

### Task 3: Full regression, build, packaging, and local review

**Files:**
- No new files; verify all changes from Tasks 1–2.

- [ ] **Step 1: Run the full portable test suite**

Run: `node --experimental-strip-types --test tests/*.test.mjs`  
Expected: all tests pass, including M1 security, protocol, coverage, and publication regressions.

- [ ] **Step 2: Run project verification gates**

Run sequentially: `npm ci`, `npm run build`, `npm run format-check`, `npm run lint`, `npm run package`, `npm run audit`.  
Expected: every command exits successfully; disclose any existing audit findings without weakening the audit.

- [ ] **Step 3: Review the exact branch head**

Inspect the complete diff against base `672a3f2261f707ba206041a41e98b44e3f8e891e` for behavior/security, prompt trust boundaries, and unnecessary abstraction. Confirm no credential/source logging, no changed-line anchor relaxation, no production ECA provider, and no change to `ENABLE_AUTOMATED_PR_REVIEWS`.

- [ ] **Step 4: Record results and commit only if all gates are green**

No model API call, live evaluation, GitHub review publication, or merge is part of this plan. Leave M2 provider use unavailable in the default Action entry point until the ECA acceptance gate is met.
