export const AI_FEATURES = [
  'forecast',
  'anomaly',
  'recommendation',
  'assistant',
  'report',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export type AiProvider = 'groq' | 'nvidia';

export const AI_CLAIM_TYPES = [
  'fact',
  'prediction',
  'estimate',
  'recommendation',
  'unknown',
] as const;
export type AiClaimType = (typeof AI_CLAIM_TYPES)[number];

/** A backend-selected, display-ready fact. No user-entered text belongs here. */
export interface AiFact {
  id: string;
  label: string;
  value: string | number;
}

export interface AiClaim {
  type: AiClaimType;
  text: string;
}

export interface AiAnswer {
  claims: AiClaim[];
}

export interface AiExplanationRequest {
  userId: string;
  feature: AiFeature;
  facts: AiFact[];
  template: AiAnswer;
}

export interface AiExplanationResult {
  answer: AiAnswer;
  source: 'ai' | 'template';
  /** Present only for model-generated wording; templates remain provider-independent. */
  provider?: AiProvider;
}

export type AiErrorType =
  | 'invalid_json'
  | 'invalid_schema'
  | 'invented_number'
  | 'truncated'
  | 'unsafe_language'
  | 'timeout'
  | 'rate_limit'
  | 'provider_4xx'
  | 'provider_5xx'
  | 'network'
  | 'unsupported_provider'
  | 'audit_error';

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiGeneratedAnswer {
  answer: AiAnswer;
  usage: AiUsage;
}

export interface AiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiToolExecutionResult {
  /** Minimum, permission-checked business data returned to the model. */
  content: unknown;
  /** Scalar values the final numeric-claim validator may treat as evidence. */
  facts: AiFact[];
}

export type AiToolExecutor = (
  name: string,
  argumentsJson: string,
) => Promise<AiToolExecutionResult>;

export interface AiAssistantRequest {
  userId: string;
  question: string;
  tools: AiToolDefinition[];
  execute: AiToolExecutor;
  template: AiAnswer;
}

export interface AiAssistantResult extends AiExplanationResult {
  toolsUsed: string[];
}

export interface AiGeneratedAssistant extends AiGeneratedAnswer {
  toolsUsed: string[];
}
