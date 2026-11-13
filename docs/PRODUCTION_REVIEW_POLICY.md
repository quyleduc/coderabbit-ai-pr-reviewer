# Production Review Policy

## Modes

1. **Shadow**: analyze a pinned pull request diff, validate every model finding against added-line evidence, and save a JSON artifact. Never post comments, reviews, labels, statuses, or PR edits.
2. **Canary**: publish only after an explicit maintainer trigger and only through the existing review publication safeguards.
3. **Default-on**: consider only after the shadow and canary exit criteria below pass.

## Scope

- Analyze source changes only. Skip generated bundles, lockfiles, vendored dependencies, binaries, and files without a complete text patch.
- Never execute or check out pull-request code in a privileged workflow.
- Limit an evaluation to 100 files, 100 hunks, 64 KiB per patch, and 50 model findings. Exceeding a limit makes the run inconclusive; it must not be reported as a clean review.
- Every finding must use a canonical rule ID, severity, actionable message, exact evidence from an added line, and an inline location on that same added line.
- Suppress style-only, speculative, duplicate, or unsupported comments. Cap publishable findings at three per pull request.

## Failure handling

- Provider errors, rate limits, timeouts, incomplete file lists, oversized diffs, and invalid model output produce an inconclusive result.
- Do not treat missing or invalid output as a clean verdict.
- Retry transient transport failures at most once with bounded backoff. Do not retry HTTP 429 for FreeModel.
- Never log API keys, prompts, raw provider responses, or untrusted PR text. Store only validated findings and bounded error codes in artifacts.

## Promotion gates

- **Shadow to canary:** benchmark at least 20 merged pull requests across C/C++, TypeScript, workflows, and configuration; reach at least 80% precision on findings selected for publication; zero wrong-file or wrong-line anchors; invalid output below 2%.
- **Canary to default-on:** run for at least two weeks or 50 eligible pull requests, whichever is later; keep duplicate comments at zero and provider failure below 5%; maintain maintainer feedback for false positives.
- Track precision, known-defect recall, invalid output rate, latency, retry rate, and cost. Fixture results do not count as real-pull-request accuracy evidence.

## Rollback

Keep automatic review disabled until promotion gates pass. Disable the shadow variable or remove the trigger label to stop model calls. Keep publication behind the existing protected environment and explicit authorization.
