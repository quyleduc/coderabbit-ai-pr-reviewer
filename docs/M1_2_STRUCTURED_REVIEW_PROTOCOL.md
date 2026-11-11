# M1.2 — Structured Review Protocol v1

Status: Draft PR #4, stacked on PR #3. No merge to main.
Protocol version: 1

## Why

The historical CodeRabbit OSS reviewer asked an LLM to emit Markdown line
ranges with LGTM/comments. Even a stricter Markdown parser could not assert
the model had given a verdict for every requested diff hunk, and a plausible
comment was not evidence that it referred to actual changed source.

This milestone replaces the review-file response format with a strict JSON
contract, implemented using only the TypeScript/Node standard library.
The summary, triage and conversational reply protocols are unchanged.

## Wire format

The system labels each packed diff fragment with a stable, zero-based hunk id.
Example model response:

    {
      "version": 1,
      "hunks": [
        {"id": "h0", "status": "clean", "findings": []},
        {
          "id": "h1",
          "status": "issues",
          "findings": [
            {
              "line": 42,
              "rule_id": "NULL_DEREF",
              "severity": "high",
              "message": "This call dereferences a potentially null pointer.",
              "evidence": "result = ptr->value;"
            }
          ]
        }
      ]
    }

The model must return one and only one verdict for each **packed** hunk.
Verdicts are either clean (zero findings) or issues (one or more findings).
Findings require a new-side added line in the corresponding hunk; the evidence
must exactly match the trimmed source code of that added line in the trusted
GitHub diff. Only severity low, medium, high and uppercase rule identifiers
are accepted. A message must be actionable and satisfy length restrictions.

Strict checks:
- Version, exact object fields, nonempty valid JSON; no extra prose.
- Each hunk in the prompt is accounted for exactly once.
- No duplicate ids, unknown ids or cross-hunk findings.
- An issue cannot claim an empty list; clean cannot contain findings.
- Evidence must match actual source, not a hallucinated snippet.
- Invalid/out-of-range/oversized input is rejected before publication.
- Multiple findings may refer to a single added line; deduplication is
  applied by the existing publication layer.

For compatibility with some language models, the parser also accepts one
whole JSON fenced code block, without leading or trailing prose.

## Production integration

The model input is labelled with review_hunk id=h0, review_hunk id=h1 and so on.
Token budgeting includes these delimiters.

The pure processStructuredReview function validates the **whole** model
response before any candidate is added to the publisher buffer.

    model.chat() -> processStructuredReview()
                 -> commenter.bufferReviewComment()
                 -> hunkCoverage ledger
                 -> existing dedup/publish/acknowledgement logic

On validation failure the file is marked failed_analysis and the completed
head SHA is not checkpointed. Source/provenance validation takes place
without adding another external model or dependency.

A clean verdict counts as reviewed; if the user previously opted in to
LGTM comments, the reviewer can attach one to a suitable added line.
Deletion-only hunks have no right-side inline anchor.

## Tests and evaluation

Tests/review-protocol.test.mjs uses real diff strings and independent known
expected outputs to verify:
- complete multi-hunk response
- missing, repeated and unknown hunk ids
- context-line and cross-hunk finding rejection
- hallucinated line evidence rejection
- invalid severity, version, messages and extra fields
- inconsistent verdicts, fenced JSON and injection-like extra prose
- fake model -> source validation -> dedup -> fake GitHub create/submit flow
- a malformed fake model response cannot trigger any GitHub mutation
- substantive findings containing LGTM text are not silently dropped

The earlier GitHub CI RED run #42965619591 showed the new module absent
while the baseline 90 tests still passed; follow-up revisions are checked
against the **latest** PR head and green build result, never an older run.

## Key limits

1. Exact source-line citation proves **provenance**, not that a reported bug
   exists. Human/analytic verification and PR precision/recall still matter.
2. A clean verdict is the model's assessment, not a proof of absence.
3. The legacy chatgpt client does not guarantee native JSON-schema decoding;
   the prompt requests it and the runtime strictly validates it.
   Ill-formed JSON deliberately fails the review rather than silently
   downgrading to Markdown.
4. The 300-file GitHub Compare cap, token-budget partial runs, old npm
   dependency risks, race between head-SHA precheck and GitHub mutation,
   and summary checkpoint persistence are not resolved by this milestone.
5. No credentialed live OpenAI review is proven by fake transport tests.
   Repository owner must configure a valid OPENAI_API_KEY before a controlled
   live E2E acceptance test.
6. PR #4 is stacked on PR #3; it must not be merged to main before PR #3
   is integrated and its remaining acceptance conditions are satisfied.

## Agent-skills review methodology

- Obra Superpowers: test-first RED/GREEN, systematic diagnosis and evidence
  before completion — https://github.com/obra/superpowers
- Matt Pocock: independent requirements and code standards evaluation,
  behavior-first tests — https://github.com/mattpocock/skills
- Ponytail: no new runtime dependency, model orchestration framework or
  speculative persistence layer — existing pure module interfaces are enough.

No separate reviewer subagent was dispatched or claimed here.
