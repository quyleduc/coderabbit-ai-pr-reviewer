# Review Engine V2 — research and migration plan

Status: **design proposal**. This is not implemented by the current CodeRabbit OSS action.

## Current implementation (source-verified)

- `src/review.ts`: GitHub compare-commits, hunk extraction, LLM summaries, per-file reviews and text-result parsing.
- `src/commenter.ts`: GitHub comments as both output and a hidden reviewed-commit checkpoint.
- `src/bot.ts`: separate light/heavy LLM clients.
- `src/prompts.ts`: natural-language output formats and free-form triage.
- `.github/workflows/openai-review.yml`: privileged integration that must execute **trusted** code, never PR head code.
- Missing from this OSS generation: repository-wide semantic graph, deterministic evidence validation, durable partial-run state, and structured findings.

## Security and trust boundary

```text
untrusted PR diff/comments  ->  read-only data acquisition
                           ->  isolated analysis engine (no write token)
                           ->  validated finding contract
                           ->  trusted GitHub publisher (minimal permissions)
```

1. Process PR head SHA as data, not executable workflow code.
2. Never use `pull_request_target` plus checkout of PR head for a local action that receives secrets.
3. Never run a PR-controlled build/script while holding publishing credentials.
4. Pin execution to an immutable SHA and reject stale output before publishing.
5. Use short-lived/least-privilege credentials and avoid logging secrets or source code unnecessarily.
6. Revisit dependency lockfile and GitHub Action runtime pinning before production deployment.

## Proposed system

```text
GitHub webhook -> event validator -> ReviewRun coordinator
                                     |
                                     +-- changed-line index
                                     +-- static analyzers
                                     +-- context providers
                                     |     +-- changed-file symbols
                                     |     +-- ECA call graph / read-write / alias facts
                                     |     +-- compile flags + build variant coverage
                                     +-- selective LLM hypotheses
                                     +-- evidence verifier
                                     |
                              deduplication + policy
                                     |
                              idempotent publisher
```

### ReviewRun identity

Use a stable identity such as
`(repository_id, pr_number, base_sha, head_sha, reviewer_version, configuration_hash)`.

Possible run states: `QUEUED -> ANALYZING -> VERIFYING -> PUBLISHING -> COMPLETE`, with
`PARTIAL`, `FAILED`, and `STALE` terminal/intermediate paths.
A run is **COMPLETE** only when all eligible changed code is accounted for and the
publisher confirms success. Do not mark a head SHA as reviewed when required hunks
were skipped for token limits or publication failed.

### Review coverage model

Persist a coverage record for every changed file/hunk with status:
`REVIEWED`, `IGNORED_BY_POLICY`, `SKIPPED_TRIVIAL`,
`BLOCKED_BY_BUDGET`, `FAILED_ANALYSIS`, `FAILED_PUBLISH`.
A review may be `PARTIAL` while still returning useful findings.

### Finding contract

```json
{
  "finding_id": "stable-hash",
  "head_sha": "<immutable commit>",
  "path": "src/main.c",
  "side": "RIGHT",
  "start_line": 42,
  "end_line": 42,
  "severity": "high",
  "kind": "CONCURRENCY",
  "message": "...",
  "evidence": [{"kind": "read_write_conflict", "ref": "eca://..."}],
  "confidence": "evidence-backed",
  "verification": "static"
}
```

All line coordinates must first be checked against the changed-line index.
A failed coordinate validation is a finding error, **not** permission to silently
attach a comment to a different hunk.

## Embedded-C-specific opportunities

The ECA engine should provide compile-command/variant-aware symbol resolution,
cross-TU call edges, pointer alias candidates, data read/write sets, volatile and
MMIO accesses, ISR/task concurrency evidence and explicit uncertainty.
An AI finding without sufficient static evidence should be distinguished from
a validated defect. No engine is assumed to provide 100% coverage.

## Milestones and evidence gates

- **M0 (this PR):** trusted checkout, pure diff parsing with omitted-count and
  no-newline regression tests, CI security guardrail and Action build validation.
- **M1:** explicit review state, idempotency, no silent partial success, correct
  diff coordinates, structured model outputs, publisher acknowledgement tests.
- **M2:** ECA-backed context-provider interface, impact-directed retrieval,
  compiler variant awareness, deterministic static rules.
- **M3:** isolated verification tools, multi-agent work only where it improves
  precision, and unseen-project evaluation.

Minimum acceptance metrics for later phases:
- Changed-line coverage with denominators and skip reasons.
- Precision/recall against curated, unseen, diverse repositories and seeded issues.
- Duplicate rate, invalid inline comment rate, partial-run recovery rate.
- Average/p95 latency, tokens, dollar cost and number of LLM calls.
- Security reviews for untrusted inputs, fork PRs and sandbox execution.

## Known limitations not solved in M0

- Reviewed-SHA marker can be written despite skipped hunks or publisher failures.
- Unchanged PR heads may be re-reviewed from base.
- Token budgeting may drop later hunks.
- Plain-text model response line mapping may be inaccurate.
- Existing Jest coverage is minimal.
- Bundled `dist/index.js` is historical; the hardened workflow rebuilds it
  from the **trusted** default branch before executing `uses: ./`.

Do not claim the V2 functionality is shipped until dedicated implementation,
CI and real-project benchmark evidence are available.
