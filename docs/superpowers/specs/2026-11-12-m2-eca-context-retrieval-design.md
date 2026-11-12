# M2 Design: Bounded ECA Context Retrieval

Date: 2026-11-12  
Status: Proposed for user review; implementation has not started  
Base: `main` at `672a3f2261f707ba206041a41e98b44e3f8e891e`

## Intent

Improve embedded-C review quality by supplying a small, auditable set of cross-file facts around changed code: callers, headers, macro expansions, and read/write or data-flow relationships. The current reviewer sends the changed PR hunks and summary to the model, then validates that every finding points to an added line with exact diff evidence. M2 adds relevant context without weakening those guarantees.

## Goals

- Resolve context only for the immutable PR head SHA and an explicitly identified compiler/build variant.
- Use ECA-provided symbol and relation facts for deterministic retrieval; never let the model request arbitrary files.
- Carry provenance with every selected snippet: source path and blob SHA, line range, symbol, relation, variant, and the ECA fact that selected it.
- Enforce fixed per-request limits for files, snippets, bytes, tokens, and retrieval time. Rank and deduplicate candidates deterministically.
- Keep inline findings anchored to added lines in the reviewed diff. Context can support reasoning, but cannot become an inline location or source evidence for a changed-line finding.
- If the provider is absent, stale, malformed, over budget, or lacks the requested variant, report that context was unavailable and continue using the existing hunk-only protocol. Never claim that an uncontextualized review used cross-file analysis.
- Preserve current trusted-checkout, SHA revalidation, fail-closed validation, publication acknowledgement, and checkpoint rules.

## Non-goals

- Replacing ECA or claiming sound, complete C/C++ data-flow analysis.
- Executing PR code, build scripts, or analyzer output.
- Model-directed, open-ended retrieval or iterative model calls.
- Changing the strict review JSON schema, finding-line validator, publisher, or M1 model selection.
- Enabling automatic review publication or changing the isolated M1 acceptance PR.
- Expanding to all programming languages in this first M2 slice.

## Approaches

1. **Changed-file windows and include text.** Retrieve more lines from changed files and directly included headers. This is small and language-light, but misses callers and transitive relationships and cannot reliably resolve macros or variants.
2. **CodeRabbit-owned lexical C index.** Build symbol/include relationships from source text. This avoids an ECA dependency but can misresolve macros, conditional compilation, and indirect calls; it risks presenting heuristic matches as facts.
3. **ECA-backed provider contract (recommended).** CodeRabbit consumes validated, versioned ECA facts through a narrow provider interface. ECA resolves symbol and relation facts with compiler-variant metadata; CodeRabbit selects and budgets source snippets. The provider boundary keeps retrieval testable and permits later providers without putting analyzer logic in the PR action.

The third approach best matches the repository's M2 roadmap and the need to distinguish compiler variants and static evidence. It depends on agreeing the ECA output contract before implementing its adapter.

## Proposed data flow

1. Parse the already validated PR diff and identify changed symbols/locations.
2. Ask the provider for bounded candidate facts using repository identity, base/head SHA, language, and selected variant.
3. Validate the provider schema, SHA, blob SHA, path, line bounds, relation type, and variant before reading a snippet.
4. Rank candidates with a documented deterministic score: direct call/read/write or macro/include relation before indirect/transitive relations; then shorter graph distance; then stable path/symbol ordering.
5. Select only candidates that fit the per-request limits. Preserve a machine-readable retrieval trace for tests and aggregate diagnostics; do not log source, prompts, provider payloads, or credentials.
6. Render selected snippets as explicitly untrusted reference context in the existing review prompt. The model must still return the same strict hunk verdicts.
7. Validate output against the original changed-line index and exact added-line evidence. Recheck the PR head/base before any publication.

## Provider contract proposal

Each context item should include:

- `head_sha` and source `blob_sha`
- `path`, `start_line`, `end_line`
- stable `symbol_id` and relation type (`CALLS`, `INCLUDES`, `EXPANDS_MACRO`, `READS`, `WRITES`, or `ALIASES`)
- `variant_id` and the compile-command/configuration identity when known
- a bounded source excerpt or a reference that CodeRabbit resolves from the same SHA
- provenance identifying the ECA fact and graph distance

Unknown relation types, stale SHAs, line mismatches, untrusted paths, malformed records, or unsupported variants are rejected. Exact transport format/version remains an implementation decision after the ECA producer schema is inspected.

## Initial limits

Start with conservative internal limits, configurable only through trusted workflow configuration: at most 8 files, 12 snippets, 16 KiB of source text, 4,096 estimated context tokens, and 2 seconds for retrieval per review request. The selector must stop at a limit and record a stable skip reason; it must not silently truncate a selected snippet. These are initial engineering caps, not quality claims, and can change only with measured cost/latency and review-quality evidence.

## Acceptance criteria

- Tests prove context is restricted to the pinned head SHA and requested variant.
- A cross-file embedded-C fixture demonstrates retrieval for a changed call site with its declaration/definition and a relevant caller or data-flow fact.
- Stale, malformed, unsupported-variant, oversized, timed-out, and missing-provider cases fail closed to an explicitly marked hunk-only review.
- Candidate selection and prompt rendering are deterministic for identical input.
- No context-only line can be published as an inline finding; all findings still satisfy the M1 protocol and evidence checks.
- Mock/regression CI proves transport and validation behavior without API credentials. Live model quality and GitHub publication remain separate manual gates.
- Security, behavior, and over-engineering reviews cover the exact branch head before PR creation; keep any feature PR Draft until blockers are cleared.

## Decisions needed before implementation

1. Confirm that M2 is embedded-C-first and ECA-backed, with CodeRabbit owning only selection, limits, validation, and prompt integration.
2. Provide or approve the ECA facts schema and how a trusted GitHub Action obtains facts for the exact PR head and compiler variants.
3. Confirm the initial limits above, or replace them with preferred caps.

No source code or workflow behavior changes until this design is approved.