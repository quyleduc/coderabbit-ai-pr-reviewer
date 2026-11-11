# M1.9 — Explicit OpenRouter Responses provider (stacked Draft)

## Intent and scope

PR #11 is stacked on Draft PR #10 (M1.8). It does **not** change `main`,
automatically enable PR review, or authorize a live paid model call.

The existing stateless Responses transport, source-line evidence validator,
idempotent publication builder, and controlled-acceptance safeguards are reused.
No new runtime dependencies, model adapter frameworks, or speculative fallbacks
are introduced.

## Production GitHub Action configuration

In the repository running the trusted reviewer workflow:

1. Set repository variable `LLM_PROVIDER=openrouter`.
2. Set repository secret `OPENROUTER_API_KEY` (never commit/paste it).
3. Set repository variables `LLM_LIGHT_MODEL` and `LLM_HEAVY_MODEL` to
   **actual OpenRouter model IDs**, e.g. `anthropic/claude-sonnet-4.6`
   **only if that model is supported for OpenRouter Responses requests**.
4. Leave `ENABLE_AUTOMATED_PR_REVIEWS` unset/false until the M1.8 live acceptance
   gate has been completed. Enabling it is a distinct, privileged action.

To keep OpenAI, omit `LLM_PROVIDER` or set `LLM_PROVIDER=openai`, configure
`OPENAI_API_KEY`, and use OpenAI model IDs. The existing `openai_light_model`
and `openai_heavy_model` action inputs are retained for compatibility and now
accept provider-qualified IDs.

The action input `llm_provider` defaults to `openai`. An explicit
`openrouter` selection uses **only** `OPENROUTER_API_KEY` and the pinned
`https://openrouter.ai/api/v1/responses` endpoint. It never sends the
`OPENAI_API_ORG` header. A custom `openai_base_url` is rejected for OpenRouter.
OpenAI's existing custom-compatible base URL remains supported for backwards
compatibility; it must be treated as a trusted credential destination.

## Controlled model evaluation and acceptance

The manual `controlled-live-eval.yml` and `controlled-live-pr-acceptance.yml`
workflows now include a `provider` choice (`openai` or `openrouter`) and
a provider-specific model ID field. Credentials are injected only into the
selected job/provider path. Both workflows still run **trusted main code only**,
so their new OpenRouter capability is not available until this Draft chain
has been reviewed and integrated.

M1.8 acceptance requirements remain mandatory: exact Draft acceptance PR,
pinned base/head SHA, a single labeled C defect, read-only preflight,
model-only verification, and environment-protected explicit publish. A YAML
environment name is **not** a replacement for configuring required reviewers.

## Security and compatibility guarantees under test

- Unknown or misspelled provider, missing matching key, custom OpenRouter
  credential endpoint, malformed provider-qualified model ID: **fail closed**.
- For OpenRouter, the transport uses `POST /api/v1/responses`, Bearer
  authorization, `store:false`, bounded timeouts, bounded retries and size
  checks, with no OpenAI key/organization forwarding.
- Errors never log raw provider bodies, PR source, prompts, or secret keys.
- The structured output and GitHub publication rules are unchanged; model
  responses must still pass the source-backed reviewer validator.
- A `store:false` field is a transport preference, **not** a guarantee of
  retention policy or privacy across OpenRouter and underlying model vendors.
  Sending private source code to a selected provider requires separate
  organizational authorization.

## Verification and release gates

Automated regression covers key isolation, fixed endpoint, model slug syntax,
mock Responses output, controlled workflow wiring and existing C reviewer
behavior. Recorded CI evidence must correspond to PR #11's exact final head.
Read-only GitHub smoke does not perform a paid model request or post comments.

**Still not verified:** credentialed OpenRouter Responses call, upstream
model compatibility, live latency/cost, a real GitHub review publication,
model quality on unseen embedded-C projects, full dependency audit, and M1.8
multi-step publication safety under arbitrary concurrent failures.

**Keep this stacked PR in Draft until these independent gates are closed.**

API documentation: https://openrouter.ai/docs/api/api-reference/responses/create-responses
