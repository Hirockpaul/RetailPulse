# RetailPulse AI explanations

Status: **Phase 7a foundation and 7b forecast explanations built.** RetailPulse remains a
synthetic-data portfolio project. AI explains backend-verified numbers; it never chooses quantities,
changes stock, approves recommendations, or creates orders.

## Default and setup

AI is off by default. With `AI_PROVIDER=none`, the API makes no AI network request and returns the
existing backend template unchanged. This is also the safe setting when running fully offline.

To enable the Groq client, set these server-side values in `.env` and restart the API:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your-server-side-key
GROQ_MODEL=openai/gpt-oss-20b
AI_TEMPERATURE=0.2
AI_MAX_TOKENS=500
AI_TIMEOUT_MS=15000
```

The key is read only by the API process. It is never returned to the browser, stored in
`ai_requests`, included in errors, or logged by the AI module. `NVIDIA_API_KEY` and `NVIDIA_MODEL`
are reserved configuration for Phase 7e; the NVIDIA provider is not implemented in 7a.

Groq uses its OpenAI-compatible chat-completions endpoint with strict JSON Schema output. The model
stays configurable because provider model availability changes. References:
[Groq OpenAI compatibility](https://console.groq.com/docs/openai) and
[Groq structured outputs](https://console.groq.com/docs/structured-outputs).

## Data boundary

The backend, not the model, selects the facts. A request can contain only a short feature name and
an array of `{ id, label, value }` facts. Future 7b–7d callers will provide product name, store code,
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

7c–7e are not built yet.
