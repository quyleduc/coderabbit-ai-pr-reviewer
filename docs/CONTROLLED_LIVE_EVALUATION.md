# Controlled live evaluation

The manual live workflow tests one selected provider and model against the
checked-in embedded-C review set. It sends no GitHub review and has only
read-only repository permissions.

## What the benchmark checks

The suite contains six reviewed diffs: four synthetic defect/clean cases, one
additional bounded-copy defect, and the clean fix from
[littlefs PR #966](https://github.com/littlefs-project/littlefs/pull/966).
That real C change is pinned to its reviewed patch and source commits so scores
remain reproducible if the upstream branch changes.

Each model reply must pass the production JSON, hunk, changed-line and exact
source-evidence validator. Findings then score by exact `(line, rule_id)` match
within each fixture after known aliases are mapped to their canonical ID. The
production prompt and evaluator share the IDs in `src/rule-catalog.ts`. The
production protocol remains compatible with valid custom IDs; the evaluator
reports an unknown ID as `NON_CANONICAL` without logging the model's raw label.

The report includes one compact result per fixture with only its ID, expected
and predicted line/rule pairs, and TP/FP/FN. It never logs prompts, source text,
model messages or credentials. The live workflow exits unsuccessfully unless
precision, recall and F1 are all 1.0 on this small, curated baseline. A passing
result is evidence for this model/configuration and fixture set, not a general
claim about review quality across repositories.

## Running it

After the change is merged, start **Controlled live model evaluation (no GitHub
writes)** on `main`. Select provider/model and protocol explicitly, then enter
`LIVE_MODEL_EVAL_ONLY`. For the FreeModel configuration used in the previous
run, use provider `freemodel`, protocol `auto`, and model
`deepseek-v4.1-flash`.

Other wire protocols have mocked transport coverage. Each requires its own
credentialed live run before claiming live compatibility.
