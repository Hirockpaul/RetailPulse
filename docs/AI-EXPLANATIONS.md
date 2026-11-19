# RetailPulse AI explanations

Status: **Phase 7a foundation and 7b–7g features built.** RetailPulse remains a
synthetic-data portfolio project. AI explains backend-verified numbers; it never chooses quantities,
changes stock, approves recommendations, or creates orders.

## Default and setup

AI is off by default. With `AI_PROVIDER=none`, the API makes no AI network request and returns the
existing backend template unchanged. This is also the safe setting when running fully offline.

Choose a preferred provider with server-side values in `.env`, then restart the API. Groq:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your-server-side-key
GROQ_MODEL=openai/gpt-oss-20b
AI_TEMPERATURE=0.2
AI_MAX_TOKENS=1500
AI_TIMEOUT_MS=15000
```

NVIDIA hosted NIM:

```dotenv
AI_PROVIDER=nvidia
NVIDIA_API_KEY=your-server-side-key
NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b
AI_TEMPERATURE=0.2
AI_MAX_TOKENS=1500
AI_TIMEOUT_MS=15000
```

The key is read only by the API process. It is never returned to the browser, stored in
`ai_requests`, included in errors, or logged by the AI module.

Groq uses its OpenAI-compatible chat-completions endpoint with strict JSON Schema output. The model
stays configurable because provider model availability changes. NVIDIA uses its OpenAI-compatible
hosted NIM endpoint with streaming disabled, reasoning disabled, and JSON-object output; the same
local schema, numeric, and safety checks still apply. References:
[Groq OpenAI compatibility](https://console.groq.com/docs/openai) and
[Groq structured outputs](https://console.groq.com/docs/structured-outputs), plus the
[Nemotron 3 Ultra API reference](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/apireference).

If both keys are configured, `AI_PROVIDER` is the preferred provider and the other provider is
tried only after the preferred provider exhausts its safe retries or fails validation. Each
provider attempt gets its own metadata-only `ai_requests` row. If neither succeeds, RetailPulse
returns the local template. The UI labels successful model wording with `Groq` or `NVIDIA`.

## Data boundary

The backend, not the model, selects the facts. A request can contain only a short feature name and
an array of `{ id, label, value }` facts. The 7b–7d callers provide product name, store code,
calculated values, measured ranges, and model-factor labels as needed. They must not provide:

- user names, email addresses, session data, or API keys;
- free-text notes or manager-entered comments;
- database rows, prompts from the browser, or write-capable tools.

The model returns JSON claims tagged `fact`, `prediction`, `estimate`, `recommendation`, or
`unknown`. Zod validates the JSON even when the provider promises strict output. Every numeric token
in every claim must occur in an explicit fact value sent by the backend (a number in a label does
not count). Forecast output is also rejected if it uses causal or certainty wording. A schema
failure, invented number, or unsafe wording is retried once, then the template is used. Model
factors are described as associations, never causes, and predictions must remain uncertain.

## Reliability and audit

- Each provider attempt times out after 15 seconds by default.
- Network errors, timeouts, and 5xx responses retry at most twice with 1 s and 2 s backoff.
- A schema or numeric validation failure retries once.
- For 429 responses, `retry-after` is honoured only when it is at most 10 seconds; otherwise the
  template is used immediately.
- Each user gets 20 accepted AI requests per rolling 10 minutes. A PostgreSQL advisory transaction
  lock makes the limit safe under concurrent requests.
- `ai_requests` stores user, feature, provider, model, token counts, duration, outcome, error type,
  and timestamps. It never stores facts, prompts, or answers.
- **Token budget.** `AI_MAX_TOKENS` (default 1500) is the most a provider may generate per call.
  Groq's gpt-oss models reason before answering and that reasoning counts against the same budget,
  so for them RetailPulse sends `reasoning_effort: "low"` and `include_reasoning: false`, and uses
  Groq's `max_completion_tokens` (its replacement for the deprecated `max_tokens`). Other Groq
  models get no reasoning fields; NVIDIA keeps `max_tokens` with reasoning off. A reply cut off by
  the limit (`finish_reason: "length"`) is recorded as `truncated` and shown as the template at
  once: retrying with the same budget cannot help.
- **Logs.** Each failed provider attempt logs one warning, e.g.
  `AI provider groq model openai/gpt-oss-20b fell back: provider_4xx (json_validate_failed)`. The
  part in brackets is the provider's own short error code, kept only when it is code-shaped.
  Provider error messages are never read out, because they can echo request content.

The only database writes available to the foundation are metadata inserts/updates in `ai_requests`.
Tests reject any SQL that targets inventory, the ledger, recommendations, orders, or transfers.

## Forecast explanations (7b)

“Why this forecast?” keeps its exact SHAP factors and adds an on-demand **Explain in words** button.
The button calls `POST /api/v1/forecasts/explanation/words`; opening the panel alone does not spend
an AI request. Store access is checked before facts are loaded.

The backend sends only the product name, store code, first forecast day and value, 80/95% bounds,
measured range coverage where available, the model starting point, and at most three displayed
factor labels/values/multipliers. It does not send a user name, email, correlation ID, browser text,
or free-text note. The output keeps visible claim labels and explicitly says that uncertainty ranges
are not guarantees and model factors describe model behaviour, not customer behaviour.

With `AI_PROVIDER=none`, pressing the button returns the deterministic template and makes no network
request or `ai_requests` row. Provider errors, invalid JSON, invented numbers, and user rate limits
also return that same template. No forecast, range, factor, stock value, or order is changed.

## Anomaly explanations (7c)

Each unusual-activity detail page has a lazy **Explain in words** button. It calls
`POST /api/v1/anomalies/{id}/explanation/words` only when pressed, after the API checks that the
caller may access the finding's store.

The backend sends the product name, store code, day, finding kind/source/severity, observed and
expected-or-threshold values, score, and one kind-specific checklist. It does not send the raw
detector explanation or rule, review history, review notes, actor names, user identity, or
correlation ID. The answer separates what happened, the comparison, why the rule flagged it, and
what a manager can check. It must describe the flag as a signal to investigate, never proof of a
problem, wrongdoing, or a known cause.

With `AI_PROVIDER=none`, the same button returns the deterministic template entirely offline. The
endpoint does not review, confirm, dismiss, or resolve the finding and cannot change inventory.

## Recommendation explanations (7d)

The recommendation detail page keeps its complete deterministic calculation and adds a lazy
**Explain in words** button. It calls
`POST /api/v1/replenishment/recommendations/{id}/explanation/words` after store access is checked.

The backend selects values from the stored recommendation snapshot: product/store, stock position,
forecast demand and error, lead/review periods, safety stock, reorder and order-up-to levels,
unrounded and rounded quantities, pack/minimum rules, and the selected transfer source or supplier.
Excess redistribution sends its keep level, movable excess, and destination instead. The raw stored
explanation, manager notes, decision actor, user identity, correlation ID, and internal record IDs
are not sent.

The output describes the existing suggestion and labels forecast values as predictions and safety
stock as an estimate. It cannot approve or reject the suggestion, create a transfer or purchase
order, or change stock. With `AI_PROVIDER=none`, or when all configured provider attempts fail, the
same button returns the local template.

## NVIDIA provider and fallback (7e)

Nemotron 3 Ultra is available through the same server-only client as Groq. A live compatibility
probe confirmed the configured hosted model accepts non-streaming JSON-object requests with
reasoning disabled and returns OpenAI-style usage counts. Production code is still covered by
mocked tests so the test suite needs no real key or network access.

**Tests never call a provider, even when your `.env` enables one.** Unit and integration tests pass
their settings explicitly, and the browser (e2e) API is started with `AI_PROVIDER=none` and empty
keys. `test/integration/ai.int-spec.ts` switches a provider on against a real PostgreSQL with the
provider faked at the `fetch` boundary. It checks what would leave the machine (no review notes, no
user names or emails, the key only in the `Authorization` header), the metadata-only audit row, the
invented-number retry and fallback, a long 429, the assistant's store scope, a prompt-injected
question that asks for writes, invalid tool arguments, and the per-user limit under 25 simultaneous
requests. Each AI endpoint also has an AI-off integration test (template, store scope, writes
nothing).

Provider fallback never changes the facts or validation rules: it sends the same minimum backend-
selected payload to the second configured provider. It cannot call tools or domain services. The
preferred failure and fallback success are separately auditable without storing either response.

## Read-only assistant (7f)

The **Assistant** page sends one question at a time to `POST /api/v1/assistant/ask`. Questions are
not stored by RetailPulse and conversation history is not persisted. Unlike the fixed 7b–7d
explanations, the user’s question must be sent to the configured provider, so the page explicitly
warns users not to enter names, email addresses, or private notes.

The model may request only four local reads: the scoped Control Tower, scoped location health, open
anomalies, and pending recommendations. Every tool calls the existing service with the signed-in
`AuthUser`; store managers therefore receive only their allowed stores. Tool arguments are parsed
with strict Zod schemas, unknown tools are rejected, at most six calls across four rounds are
allowed, and results omit notes, actors, user data, raw detector explanations, decision text, and
internal record IDs.

No inventory, review, approval, order, transfer, or other mutation service is exposed to the tool
executor. A test supplies write methods that fail if called and proves they remain untouched. The
final answer uses the same tagged-claim schema and numeric validation as explanations: every numeric
token must occur in permission-checked tool results. Provider/tool failures return local guidance.
With `AI_PROVIDER=none`, no database tool or network request runs.

## Report summaries (7g)

An immutable report has a lazy **Summarise in words** button. It calls
`POST /api/v1/reports/{id}/summary/words` only after the API applies the report's existing scope
permission check. The summary does not run a live report query and never edits the saved snapshot.

The backend sends the period, scope name/code, selected sales and movement totals, selected work
counts, generation-time stock totals, forecast-based risk figures when present, and at most the
first three stores and products from the report's existing ranked breakdowns. User identity,
report/internal location/product IDs, generation actor, and unselected rows are not sent. The
generation-time stock figures are explicitly distinguished from period-end figures, and stock-risk
figures remain uncertain predictions rather than outcomes.

The result is visibly labelled **AI-generated report summary (Groq/NVIDIA)** or **Template report
summary**. With `AI_PROVIDER=none`, it is produced locally without a network request or AI audit
row. Provider failures and validation failures use the same deterministic template. No answer text
is persisted, so regenerating a summary never changes the underlying report.
