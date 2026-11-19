import { postJson } from './client';

export interface AssistantAnswer {
  source: 'ai' | 'template';
  provider?: 'groq' | 'nvidia';
  toolsUsed: string[];
  claims: {
    type: 'fact' | 'prediction' | 'estimate' | 'recommendation' | 'unknown';
    text: string;
  }[];
}

export const askAssistant = (question: string) =>
  postJson<AssistantAnswer>('/assistant/ask', { question });
