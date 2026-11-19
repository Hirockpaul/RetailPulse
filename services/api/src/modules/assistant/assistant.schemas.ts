import { z } from 'zod';

export const askAssistantBodySchema = z
  .object({
    question: z.string().trim().min(3).max(500),
  })
  .strict();

export type AskAssistantBody = z.output<typeof askAssistantBodySchema>;

export interface AssistantAnswer {
  source: 'ai' | 'template';
  provider?: 'groq' | 'nvidia';
  toolsUsed: string[];
  claims: {
    type: 'fact' | 'prediction' | 'estimate' | 'recommendation' | 'unknown';
    text: string;
  }[];
}
