# M1.8 — Controlled live PR acceptance & release gate

Status: **Draft PR #10** stacked on Draft PRs #3–#9. This milestone
implements a guarded acceptance runner, not a successful paid model run.
Nothing was merged into main by this work.

## Trust and scope

The manual workflow is .github/workflows/controlled-live-pr-acceptance.yml.
It runs only from **trusted main**. All jobs checkout the default branch,
never the PR source, and set persist-credentials:false.

There are three explicit, separately confirmed modes:

1. **preflight** — read-only GITHUB_TOKEN, no OPENAI_API_KEY. It verifies
   the full target PR metadata and diff, without making any API write.
   Confirmation: PREFLIGHT_ACCEPTANCE_ONLY.
2. **model-only** — read-only GITHUB_TOKEN plus OPENAI_API_KEY for one
   real paid model invocation. It requires a specific expected defect
   rule/added line, validates the full structured JSON with the production
   diff validator, but makes **zero GitHub writes**.
   Confirmation: VALIDATE_ACCEPTANCE_MODEL.
3. **publish** — privileged job, requires confirmation
   PUBLISH_ACCEPTANCE_REVIEW and uses GitHub environment
   controlled-review-acceptance. This job alone has
   pull-requests:write and issues:write. It may post ONE verified inline
   review finding and then ONE idempotent checkpoint issue comment,
   only on the exact authorized acceptance PR.

Workflow default is preflight. There is **no pull_request_target trigger**
for the acceptance workflow. Source code checked out under privileged modes
comes from trusted main; the acceptance branch is read as untrusted diff
**data only**. A real API key is never in PR code, workflow inputs,
command-line parameters or public output.

### Repository setup BEFORE any live run

The repository owner must:
- Integrate and review the stacked chain #3 → #10 in dependency order;
  the manual workflow will not be callable as a trusted-main workflow
  until it exists on the default branch.
- Configure GitHub Actions repository secret OPENAI_API_KEY through the
  GitHub UI. Never paste the key into PRs, chat or commits.
- Create the GitHub Actions environment **controlled-review-acceptance**
  and configure **required reviewers**. Naming an environment in YAML
  alone does not enforce human approval; a nonexistent environment can
  be created without protections. This is a manual release blocker.
- Ensure the repository permits GITHUB_TOKEN to write pull request reviews
  and issue comments for the publish job only.
- Leave repository variable ENABLE_AUTOMATED_PR_REVIEWS **unset or false**
  during acceptance. This PR changes the existing automatic privileged
  OpenAI Reviewer job to require that variable exactly equal 'true'.
  This is a deliberate opt-in behavior change when code reaches main.

Do not assume that the connected GitHub app can inspect/configure secrets,
environments or organization-level branch protections. These must be
verified by the repository owner.

## Creating an isolated acceptance PR

Use a dedicated same-repo branch named acceptance/null-pointer, based on
current main. Open a **Draft PR targeting main**, with one changed file:

    tests/acceptance/known-defect.c

Example source for a newly added file:

    int read_sensor(const int *ptr) {
      return *ptr;
    }

Use this marker in the Draft PR body:

    <!-- coderabbit:acceptance-target-v1 -->

The runner requires ALL of the following:
- Exact repository match with the workflow's GITHUB_REPOSITORY for both
  PR head and base (forks are prohibited).
- PR open and Draft; head ref starts acceptance/; base ref exactly main.
- PR number, full 40-character head and base SHAs match workflow inputs.
- PR description includes the explicit acceptance-target marker.
- Exactly one changed file, under tests/acceptance/*.c, added or modified.
- Valid complete unified diff, one hunk and at least one RIGHT-side added
  line, with additions/deletions counts matching GitHub metadata.
- The supplied expected added-line number and uppercase rule ID are valid.

For the example above, the expected rule ID is NULL_DEREF and the target
line is the new-side line containing the dereference. Read its exact line
number from the acceptance PR diff: do not assume a fixed number.

Do not create this Draft acceptance PR before the new main-branch automatic
review opt-in guard is active, to avoid unexpectedly triggering the old
privileged reviewer.

## Three-phase manual acceptance

In Actions > Controlled live PR acceptance (manual) > Run workflow:
- Choose the trusted **main** branch.
- Set mode=preflight, exact PR number, pinned head and base SHAs, expected
  added-line number and rule ID, and confirm=PREFLIGHT_ACCEPTANCE_ONLY.
- Inspect the result. It must say preflight_ok and report zero writes.
- Repeat in mode=model-only with confirm=VALIDATE_ACCEPTANCE_MODEL and
  an explicit model ID. API usage is billable. The result must say
  model_validated with exactly one source-backed expected finding.
  A missing/wrong/hallucinated finding is a failure, not a pass.
- Only after inspecting the above and configuring required reviewers,
  choose mode=publish and confirm=PUBLISH_ACCEPTANCE_REVIEW.
  Approve the protected GitHub environment when prompted.

On successful publication:
- Existing GitHub reviews are checked for **PENDING** bot review state.
  Pending/ambiguous state blocks automatic duplicate posting.
- Previously published bot comments are retrieved with pagination and
  checked for the immutable scope marker. A previous success prevents
  duplicate review posts even if the model paraphrases the finding.
- Source validator enforces exactly one known rule and added-line anchor.
- PR head/base, branch provenance, Draft status and acceptance marker
  are rechecked before any write.
- The existing publishReviewBatch handles GitHub create + submit with a
  deterministic RIGHT-side line anchor and no blind retry on uncertainty.
- Publication is then read back from trusted github-actions[bot] comments.
  Only **after** positive readback is the separate checkpoint written.
- If a job dies after posting review but before the checkpoint, rerun
  verifies the existing bot comment and reconciles the missing checkpoint,
  without posting another review. Checkpoint issue comments are themselves
  deduplicated by exact immutable base/head marker.

Failure to read back a trusted publication blocks checkpointing; a failed
or ambiguous submission is NOT considered success.

## RED–GREEN and safe release evidence

Test suites:
- tests/acceptance-gate.test.mjs: rejects forks, retarget, stale SHA,
  wrong path, extra/missing files, partial patches and missing marker.
- tests/live-pr-acceptance.test.mjs: preflight/model-only zero writes,
  explicit rule+line check, stale SHA failure, pending review guard,
  publication acknowledgement and recovery after partial checkpoint.
- tests/live-acceptance-security.test.mjs: workflow job scopes, manual
  dispatch only, trusted default checkout, no raw provider stack logging.
- tests/review-publication.test.mjs: explicit RIGHT side for single/multi
  line GitHub review anchors and fail-closed publish results.
- All earlier 172 tests and read-only real-PR smoke remain mandatory.

Review methodology:
- Obra Superpowers RED–GREEN and verification-before-completion.
- Matt Pocock behavior/security split.
- Ponytail simplicity: no new npm dependency, GitHub App/agent framework
  or persistence layer; bounded single PR test instead.

## NOT YET PROVEN

- No real OPENAI_API_KEY was accessed or OpenAI Responses API call executed
  for this PR. Mock scores are NOT model precision or recall.
- No actual GitHub review or checkpoint was posted; live publishing requires
  the manual protected mode above, and the workflow is not on main yet.
- No separate test repository was created; isolation is a same-repo Draft
  PR on an acceptance/ branch with exact SHA and one-file restrictions.
  A separate repository would need a separately scoped installed credential.
- GitHub environment required-reviewer protection is a manual setup,
  not something this repository source file can assert is configured.
- Model-only and publish are separate invocations; the model is called
  again in publish mode and must pass the expected finding validation again.
- Semantic correctness beyond the known synthetic defect, precision/recall
  on unseen embedded-C projects, large PR performance and overall npm audit
  remain unresolved.
- GitHub review creation and final issue-comment checkpoint remain two
  separate API transactions; readback and retry reconciliation reduce,
  but do not eliminate, every possible race.

Official references:
https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment
https://docs.github.com/en/rest/pulls/reviews
https://docs.github.com/en/rest/pulls/comments

**Release verdict:** Keep Draft. No claim of production-ready or successful
live E2E until the protected workflow has actually run with a real model
and one authorized GitHub review/comment checkpoint has been inspected.
