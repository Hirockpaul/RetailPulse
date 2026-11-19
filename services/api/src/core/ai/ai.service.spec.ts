import { loadEnv, type Env } from '../config/env';
import { AiProviderError, type AiClient } from './ai.client';
import type { AiRepository } from './ai.repository';
import { AiService } from './ai.service';
import type { AiExplanationRequest } from './ai.types';

const request: AiExplanationRequest = {
  userId: '00000000-0000-0000-0000-000000000001',
  feature: 'forecast',
  facts: [{ id: 'forecast', label: 'Forecast units', value: 12 }],
  template: { claims: [{ type: 'prediction', text: 'The forecast is 12 units.' }] },
};

function env(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    ...overrides,
  });
}

describe('AiService', () => {
  it('uses the template without any database or network call when provider is none', async () => {
    const repository = { reserve: jest.fn(), complete: jest.fn() };
    const client = { generate: jest.fn() };
    const service = new AiService(
      env({ AI_PROVIDER: 'none' }),
      repository as unknown as AiRepository,
      client as unknown as AiClient,
    );

    await expect(service.explain(request)).resolves.toEqual({
      answer: request.template,
      source: 'template',
    });
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('records token counts and returns a checked provider answer', async () => {
    const repository = {
      reserve: jest.fn().mockResolvedValue({ requestId: 7 }),
      complete: jest.fn().mockResolvedValue(undefined),
    };
    const answer = { claims: [{ type: 'prediction' as const, text: 'Forecast is 12 units.' }] };
    const client = {
      generate: jest.fn().mockResolvedValue({
        answer,
        usage: { inputTokens: 41, outputTokens: 9 },
      }),
    };
    const service = new AiService(
      env({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-key' }),
      repository as unknown as AiRepository,
      client as unknown as AiClient,
    );

    await expect(service.explain(request)).resolves.toEqual({
      answer,
      source: 'ai',
      provider: 'groq',
    });
    expect(client.generate).toHaveBeenCalledWith('groq', 'forecast', request.facts);
    expect(repository.complete).toHaveBeenCalledWith(
      7,
      'ok',
      expect.any(Number),
      { inputTokens: 41, outputTokens: 9 },
      null,
    );
  });

  it('allows 20 requests per user in ten minutes and templates the twenty-first', async () => {
    let count = 0;
    const repository = {
      reserve: jest
        .fn()
        .mockImplementation(async () => (++count <= 20 ? { requestId: count } : null)),
      complete: jest.fn().mockResolvedValue(undefined),
    };
    const client = {
      generate: jest.fn().mockResolvedValue({
        answer: { claims: [{ type: 'prediction', text: 'Forecast is 12 units.' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const service = new AiService(
      env({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-key' }),
      repository as unknown as AiRepository,
      client as unknown as AiClient,
    );

    const results = [];
    for (let index = 0; index < 21; index++) results.push(await service.explain(request));

    expect(results.slice(0, 20).every((result) => result.source === 'ai')).toBe(true);
    expect(results[20]).toEqual({ answer: request.template, source: 'template' });
    expect(client.generate).toHaveBeenCalledTimes(20);
  });

  it('never returns a server key or provider error detail', async () => {
    const key = 'do-not-return-this-key';
    const repository = {
      reserve: jest.fn().mockResolvedValue({ requestId: 8 }),
      complete: jest.fn().mockResolvedValue(undefined),
    };
    const client = { generate: jest.fn().mockRejectedValue(new Error(`failed with ${key}`)) };
    const service = new AiService(
      env({ AI_PROVIDER: 'groq', GROQ_API_KEY: key }),
      repository as unknown as AiRepository,
      client as unknown as AiClient,
    );

    const result = await service.explain(request);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result).toEqual({ answer: request.template, source: 'template' });
  });

  it('falls back to the other configured provider and audits both attempts', async () => {
    const repository = {
      reserve: jest
        .fn()
        .mockResolvedValueOnce({ requestId: 10 })
        .mockResolvedValueOnce({ requestId: 11 }),
      complete: jest.fn().mockResolvedValue(undefined),
    };
    const answer = { claims: [{ type: 'prediction' as const, text: 'Forecast is 12 units.' }] };
    const client = {
      generate: jest
        .fn()
        .mockRejectedValueOnce(new AiProviderError('provider_5xx'))
        .mockResolvedValueOnce({
          answer,
          usage: { inputTokens: 6, outputTokens: 4 },
        }),
    };
    const service = new AiService(
      env({
        AI_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'nvidia-key',
        GROQ_API_KEY: 'groq-key',
      }),
      repository as unknown as AiRepository,
      client as unknown as AiClient,
    );

    await expect(service.explain(request)).resolves.toEqual({
      answer,
      source: 'ai',
      provider: 'groq',
    });
    expect(client.generate).toHaveBeenNthCalledWith(1, 'nvidia', 'forecast', request.facts);
    expect(client.generate).toHaveBeenNthCalledWith(2, 'groq', 'forecast', request.facts);
    expect(repository.complete).toHaveBeenNthCalledWith(
      1,
      10,
      'fallback',
      expect.any(Number),
      { inputTokens: null, outputTokens: null },
      'provider_5xx',
    );
    expect(repository.complete).toHaveBeenNthCalledWith(
      2,
      11,
      'ok',
      expect.any(Number),
      { inputTokens: 6, outputTokens: 4 },
      null,
    );
  });
});
