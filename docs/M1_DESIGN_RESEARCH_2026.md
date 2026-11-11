# Design research: reliable PR review (M1–M3)

Research date: 2026-11-11
Scope: historical CodeRabbit OSS fork. This is NOT the proprietary CodeRabbit production architecture.
Status: M1 integration work in progress, not production-certified.

## Executive assessment

The strongest reusable designs are deterministic diff location validation, explicit review-state accounting, bounded code-graph context and verification of defect claims. Adding more prompts or agents without measurement is not an adequate substitute.

## I. Open-source architectures

### 1. reviewdog — correct PR annotation boundaries

Repo: https://github.com/reviewdog/reviewdog (MIT)
Source: filter/diff_filter.go, diff/parse.go, diff/parse_test.go.

reviewdog separates diagnostics from reporters and makes filtering modes explicit: added, diff_context, file and nofilter. It handles no-newline sentinels, empty/deleted files and platform reporting constraints. A diagnostic outside the diff must not be invented as an inline review comment.

**Adopt M1:** exact changed-line index, fail-closed parsing, validate every proposed location before publishing. In this branch: src/diff-hunks.ts, tests/review-anchors.test.mjs and the review.ts integration.

**Defer:** per-provider GitHub Checks fallback, deletion-only findings, multi-platform support.

### 2. PR-Agent — idempotency and accurate coverage state

Repo: https://github.com/The-PR-Agent/pr-agent (MIT)
Source: pr_agent/algo/pr_processing.py, git_patch_processing.py, inline_comment_dedup.py and pr_agent/commands/pr_reviewer.py.
Tests include test_pr_reviewer_finding_state.py, test_review_large_diff_chunking.py and test_inline_comment_dedup.py.

The OSS implementation tracks token budgets, additional/unprocessed files, incremental per-commit review state and dedup fingerprints stored with comments. The architecture has dedicated tests for large diffs and reviewer failures.

**Adopt M1:** accountable coverage statuses, publisher acknowledgement, completed-head guard and deterministic semantic issue fingerprints. Preserve previous successful checkpoints but never mark the latest head SHA complete if analysis or publication fails.

**Defer:** exact hunk-granularity accounting, robust persisted ReviewRun state and dedup lookups before publishing.

### 3. Aider — bounded graph-aware context

Repo: https://github.com/Aider-AI/aider (Apache-2.0)
Source: aider/repomap.py; docs: aider/website/docs/repomap.md.

Aider extracts syntax tags and references, ranks important symbols via a graph and selects snippets within a token budget. For M2, ECA should supply compiler-variant-aware symbol IDs, call edges, read/write and alias facts. Do not equate tag graphs with sound pointer/ISR dataflow.

### 4. CodeQL and Semgrep — deterministic evidence

Repos: https://github.com/github/codeql and https://github.com/semgrep/semgrep
Docs:
https://github.com/github/codeql/blob/main/docs/codeql/codeql-language-guides/analyzing-data-flow-in-python.rst
https://github.com/semgrep/semgrep-docs/blob/main/docs/writing-rules/data-flow/taint-mode/overview.mdx

Distinguish local from interprocedural/interfile analysis and record model, build and semantic assumptions. M2/M3 review evidence should include a source-to-sink flow, call/dataflow trace, rule match, reproducible failing test or a defensible diagnostic. A plausible LLM explanation is not itself proof.

Licenses differ; treat implementation inspiration separately from source copying.

### 5. SARIF — persistent finding identity

GitHub SARIF reference:
https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support

SARIF carries stable rule IDs, locations, code flows and partial fingerprints to match findings across runs. Do not use model prose as the sole key. The pure issueFingerprint helper in this branch hashes stable path, rule, qualified symbol and source evidence, excluding SHA and absolute line numbers. Actual publisher-side dedup is a later step.

## II. Research papers and benchmarks

### Agentless — FSE 2025
https://arxiv.org/abs/2407.01489
https://conf.researchr.org/details/fse-2025/fse-2025-research-papers/85/Demystifying-LLM-based-Software-Engineering-Agents

Localization, repair and validation offered a competitive, interpretable baseline on software repair. This is NOT directly a PR-review benchmark. Transferable lesson: start simple and add orchestration only when measured outcomes improve.

### SWR-Bench — FSE 2026
https://conf.researchr.org/details/fse-2026/fse-2026-research-papers/78/SWR-Bench-Assessing-LLM-Performance-in-Real-World-Code-Review-Comment-Generation

The authors curated 1,000 manually verified PRs with project context and report benefits from multi-review aggregation. Higher recall may increase cost and noise; reproduce on a blind holdout before selecting multi-agent by default.

### GitHub ReviewBench — October 2026
https://github.com/review-bench/ReviewBench
https://github.blog/ai-and-ml/reviewbench-an-open-benchmark-for-ai-code-review/
https://review-bench.ai/

Human-audited ground truth, PR-based evaluation, precision, recall, severity, number of comments and latency are more meaningful than an isolated model score. Prefer a time-separated, unseen set with independent labels. Treat leaderboard numbers as measurements of their disclosed harness and data, not universal guarantees.

### Overcorrection bias — June 2026
https://link.springer.com/article/10.1007/s10515-026-00638-5

Study: Are LLMs reliable code reviewers? systematic overcorrection in requirement conformance judgement. Rich explanation/fix prompts can increase unwarranted criticism of correct solutions. The authors investigate counterfactual fix-guided executable validation. M3 should require explicit verification for consequential findings.

### Benchmark contamination
https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/

SWE-bench Verified evaluates issue solving, not PR-review accuracy, and has contamination concerns. Avoid using benchmark outcomes alone to claim production PR-review precision.

## III. Adopted target architecture

    GitHub webhook (immutable repo/PR/base/head)
       |
       v
    Diff acquisition + strict changed-line index
       |
       +----- deterministic rules and ECA (M2) ------+
       |                                              |
       v                                              |
    bounded symbol/context retrieval (M2)             |
       |                                              |
       v                                              |
    model hypotheses ---- evidence verifier <---------+
       |
       v
    changed-line anchor validation -> semantic dedup
       |
       v
    trusted publisher (API acknowledgement)
       |
       v
    coverage checkpoint ONLY for fully completed scope

### Invariants

1. PR input identity includes immutable base/head SHAs; recheck head before publication.
2. Every expected file/hunk must have an explicit status: reviewed, intentionally ignored, triaged trivial, blocked by budget, analysis failed, publication failed or pending.
3. Do not attach an inline comment to a line outside the model's source hunk or GitHub changed-line index.
4. Do not advance a checkpoint before publication acknowledgement.
5. Dedup against prior published findings using stable semantic fingerprints.
6. Isolate credentials from untrusted PR code; avoid external plugins for the pure analysis core.
7. Partial review is reportable but is NOT a completed review.

## IV. What is implemented in this M1 branch

- Exact new-side changed-line index and anchor checking.
- In-memory file-level review completeness gate.
- Publisher boolean acknowledgement.
- Checkpoint only when accounted files are all completed AND publication acknowledged.
- Marker distinguishes newly completed head reviews from historical legacy SHA markers.
- Pure semantic finding fingerprint function.
- Regressions for malformed diff, multi-hunk anchoring, partial coverage and stable issue keys.

## V. Remaining gaps, deliberately not hidden

- File-level accounting cannot establish precise per-hunk completeness; M1.1 must add hunk-scoped statuses.
- The comment-body checkpoint is not atomic persistent state; replace with an idempotent external store when deploying at scale.
- Semantic finding fingerprints are NOT yet wired into existing-comment lookups or the publisher.
- GitHub compare API pagination and truncated diff detection require dedicated integration tests.
- Background permissions and old npm dependencies still need separate security review.
- End-to-end precision/recall on real, unseen PRs has NOT been measured.

## VI. Measurable acceptance gates

- 100% of expected units have an explicit outcome; partial outcomes never create a completed-head marker.
- 0 invalid-coordinate inline publications on a corpus of malformed and Git-generated diffs.
- Duplicate rate on identical replayed PR heads and reruns.
- Precision/recall/F1 and severity-weighted recall on an independent, blind review corpus.
- Cost, tokens, latency percentiles, false positives per PR, and run-to-run variance.
- Embedded-C set covers function-pointer dispatch, pointer aliases, volatile/MMIO, ISR/task races, compiler flags, preprocessor variants, traps and cross-TU data access; declare unsupported configurations inconclusive.

M2 should start only after M1 reliability and replay tests, not because adding agents is fashionable.
