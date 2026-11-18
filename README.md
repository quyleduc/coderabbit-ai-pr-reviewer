# Proofline

Source-validated AI pull request reviewer and summarizer GitHub Action (`node24`).

Proofline reviews the complete current PR diff on every head SHA using a strict JSON protocol: every finding must cite an exact added line (`evidence`) in its hunk, pass sanitization, and be published atomically before a head checkpoint is recorded.

## Key Features

- **Source-validated inline reviews:** Structured JSON protocol (`version: 1`) with 1-shot schema/token-budgeted repair retry and deterministic severity prioritization (`high > medium > low`, capped at 3 new findings per run).
- **Semantic + exact deduplication:** Suppresses exact and reworded duplicate findings (`rule_id` + normalized `evidence` when unique in diff), preserves threads after comment replies, and skips generic rules (`OTHER_DEFECT`) from cross-run collapsing.
- **Multi-provider LLM support:** `openai`, `anthropic`, `gemini`, `openrouter`, `freemodel`, and `openai-compatible` (see [docs/LLM_API_PROTOCOLS.md](docs/LLM_API_PROTOCOLS.md)).
- **Opt-in C AST cross-file context:** `context_provider: 'ast'` uses pinned `web-tree-sitter` + official `tree-sitter-c` WASM to resolve called `.c`/`.h` definitions via GitHub API without checking out PR code (see [docs/AST_CONTEXT_SUPPLY_CHAIN.md](docs/AST_CONTEXT_SUPPLY_CHAIN.md)).
- **Interactive comment replies:** Tag `@proofline` in a PR review comment thread (restricted to trusted `OWNER` / `MEMBER` / `COLLABORATOR` commenters), or add `@proofline: ignore` in the PR description to skip review.

## Quick Start

```yaml
name: Proofline PR Review

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Run Proofline
        uses: quyleduc/coderabbit-ai-pr-reviewer@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          max_files: '20'
          openai_retries: '1'
          context_provider: 'none' # set to 'ast' for C (.c/.h) cross-file context
```

## Configuration

All inputs and defaults are defined in [action.yml](action.yml). Common options:

- `llm_provider`: `openai` (default), `anthropic`, `gemini`, `openrouter`, `freemodel`, `openai-compatible`
- `openai_light_model` / `openai_heavy_model`: model IDs for summary/triage and hunk review
- `max_files`: maximum files processed (`150` default in `action.yml`; `20` recommended in [docs/PRODUCTION_REVIEW_POLICY.md](docs/PRODUCTION_REVIEW_POLICY.md))
- `openai_retries`: retry attempts (`5` default in `action.yml`; `1` recommended for free-tier providers)
- `context_provider`: `'none'` (default, hunk-only) or `'ast'` (C cross-file `CALLS` via GitHub API)
- `language`: response ISO language code (default `en-US`)

## Development

```bash
npm ci --ignore-scripts
npm run build
npm run format-check
npm run lint
npm run package
npm test
```

## License

MIT — forked from OSS `coderabbitai/ai-pr-reviewer` and substantially rewritten. See [LICENSE](LICENSE) and [dist/licenses.txt](dist/licenses.txt).
