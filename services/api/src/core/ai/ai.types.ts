export const AI_FEATURES = [
  'forecast',
  'anomaly',
  'recommendation',
  'assistant',
  'report',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

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
}

export type AiErrorType =
  | 'invalid_json'
  | 'invalid_schema'
  | 'invented_number'
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
