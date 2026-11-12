# LLM providers and API protocols

The reviewer uses one normalized request: model ID, system instruction, user
prompt, and maximum output tokens. A wire-protocol adapter turns that request
into one provider API call and extracts final text. Review validation remains
shared and still rejects incomplete output, invalid JSON, unsupported findings,
and evidence that does not match the changed source.

This supports non-streaming text requests used by the review workflow. It does
not claim full feature parity for streaming, tool calls, image input,
embeddings, or provider-specific structured-output features.

## Supported provider defaults

| `llm_provider`      | Default protocol          | Default API base URL                               | Credential environment variable        |
| ------------------- | ------------------------- | -------------------------------------------------- | -------------------------------------- |
| `openai`            | `openai-responses`        | `https://api.openai.com/v1`                        | `OPENAI_API_KEY`                       |
| `openrouter`        | `openai-responses`        | `https://openrouter.ai/api/v1`                     | `OPENROUTER_API_KEY`                   |
| `freemodel`         | `openai-chat-completions` | `https://freemodel.in/v1`                          | `FREEMODEL_API_KEY` (or `LLM_API_KEY`) |
| `anthropic`         | `anthropic-messages`      | `https://api.anthropic.com/v1`                     | `ANTHROPIC_API_KEY`                    |
| `gemini`            | `gemini-generate-content` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`                       |
| `openai-compatible` | `openai-chat-completions` | Must be configured                                 | `LLM_API_KEY`                          |

`llm_api_protocol: auto` selects the provider default. The supported explicit
values are `openai-responses`, `openai-chat-completions`, `anthropic-messages`,
and `gemini-generate-content`. A protocol can be overridden for compatible
gateways, but a provider's upstream must implement that protocol.

The action's `openai_light_model` and `openai_heavy_model` inputs retain their
historic names; their values are model IDs for the selected provider. For
Anthropic, Gemini, FreeModel, or a custom OpenAI-compatible service, configure
both inputs with model IDs from that service. In the sample review workflow, set
repository variables `LLM_LIGHT_MODEL` and `LLM_HEAVY_MODEL`; it stops with a
clear error if a non-default provider is selected without them. The controlled
live workflows require an explicit model ID on every dispatch.

The `openrouter` profile pins its API base URL to OpenRouter so its API key
cannot be sent to an arbitrary custom host. Other base URL overrides must use
HTTPS. Plain HTTP is accepted only for localhost development.

## FreeModel configuration

In a workflow that uses this Action:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  FREEMODEL_API_KEY: ${{ secrets.FREEMODEL_API_KEY }}
with:
  llm_provider: freemodel
  llm_api_protocol: auto
  openai_heavy_model: <model-id-from-FreeModel>
  openai_light_model: <model-id-from-FreeModel>
```

The provider uses the OpenAI Chat Completions request format, `Bearer`
authentication, `/chat/completions`, and the `max_tokens` budget field. The
model ID is independent of the protocol, so a Claude model ID can be selected
through this OpenAI-compatible route.

FreeModel's API reference documents `/chat/completions` and lists `max_tokens`
as the output-budget parameter. Its Claude Code guide also describes
Anthropic-style client configuration, but that does not establish that every
FreeModel account or model supports the native Anthropic `/messages` request
shape. Use the documented Chat Completions protocol unless a native Messages
endpoint has been verified for the specific gateway account.

## Protocol behavior

- **OpenAI Responses:** `POST /responses`, `instructions`, `input`, and
  `max_output_tokens`. Only completed, non-empty final text is accepted.
- **OpenAI Chat Completions:** `POST /chat/completions`, system/user messages,
  `max_tokens`, and `stream: false`. Truncation, tool-only, and empty results
  fail closed.
- **Anthropic Messages:** `POST /messages`, `x-api-key`, required
  `anthropic-version`, `system`, `messages`, and `max_tokens`. Only `end_turn`
  and `stop_sequence` text responses are accepted.
- **Gemini generateContent:** `POST /models/{model}:generateContent`,
  `x-goog-api-key`, `systemInstruction`, `contents`, and
  `generationConfig.maxOutputTokens`. Only `STOP` text responses are accepted.

The adapters use bounded timeouts and retries. They do not print request
prompts, model responses, keys, or raw upstream error bodies. Credentials are
selected by the provider profile and are not copied from one provider variable
to another.

Other vendors that implement OpenAI Chat Completions can use the
`openai-compatible` profile by setting `llm_base_url`, `LLM_API_KEY`, and a
model ID accepted by that gateway. Many inference services expose this protocol.
Vendor-only APIs with a different request/response schema need their own adapter
and are outside this protocol set.

## Verification limits

Protocol tests use simulated HTTP responses to verify URLs, headers, payloads,
response parsing, truncation handling, retry limits, and secret isolation. A
passing test suite is not a live-provider check. A real request requires the
corresponding API key and must be run through the explicitly gated manual live
evaluation workflow.
