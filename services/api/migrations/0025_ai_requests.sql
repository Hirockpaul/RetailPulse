-- 0025 (Phase 7a): metadata-only audit log for optional AI explanations.
-- Prompts and answers are deliberately never stored.

CREATE TABLE ai_requests (
  id                bigserial PRIMARY KEY,
  user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  feature           text NOT NULL CHECK (feature IN ('forecast', 'anomaly', 'recommendation', 'assistant', 'report')),
  provider          text NOT NULL CHECK (provider IN ('groq', 'nvidia')),
  model             text NOT NULL CHECK (length(btrim(model)) > 0),
  input_tokens      integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens     integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  duration_ms       integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome           text CHECK (outcome IS NULL OR outcome IN ('ok', 'fallback', 'error')),
  error_type        text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT ai_requests_completion_consistent CHECK (
    (outcome IS NULL AND completed_at IS NULL)
    OR (outcome IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX ai_requests_user_window_idx ON ai_requests (user_id, requested_at DESC);
CREATE INDEX ai_requests_feature_time_idx ON ai_requests (feature, requested_at DESC);

COMMENT ON TABLE ai_requests IS
  'Metadata for optional AI explanations. Never stores prompts, facts, or generated text.';
