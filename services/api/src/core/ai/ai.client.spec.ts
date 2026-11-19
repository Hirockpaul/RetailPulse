import { loadEnv, type Env } from '../config/env';
import { AiClient, AiProviderError, type AiFetch, type AiSleep } from './ai.client';
import type { AiFact } from './ai.types';

const facts: AiFact[] = [
  { id: 'product', label: 'Product', value: 'Tea 500' },
  { id: 'store', label: 'Store', value: 'STR-01' },
  { id: 'forecast', label: 'Forecast units', value: 12 },
  { id: 'range', label: '80% upper range', value: 18 },
];

function env(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    AI_PROVIDER: 'groq',
    GROQ_API_KEY: 'test-secret-key',
    AI_TIMEOUT_MS: '100',
    ...overrides,
  });
}

function success(content = '{"claims":[{"type":"prediction","text":"Forecast is 12 units."}]}') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 41, completion_tokens: 9 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function client(fetcher: jest.MockedFunction<AiFetch>) {
  const sleep = jest.fn<ReturnType<AiSleep>, Parameters<AiSleep>>().mockResolvedValue(undefined);
  return { client: new AiClient(env(), fetcher, sleep), sleep };
}

describe('AiClient', () => {
  it('calls Groq with strict JSON schema and records token usage', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValue(success());
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).resolves.toEqual({
      answer: { claims: [{ type: 'prediction', text: 'Forecast is 12 units.' }] },
      usage: { inputTokens: 41, outputTokens: 9 },
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'openai/gpt-oss-20b',
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(String(init.body)).toContain('Tea 500');
    expect(String(init.body)).not.toContain('test-secret-key');
  });

  it('retries invalid JSON once, then rejects it', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockImplementation(async () => success('not-json'));
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).rejects.toMatchObject({
      type: 'invalid_json',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(built.sleep).toHaveBeenCalledWith(1000);
  });

  it('rejects an invented number after one validation retry', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockImplementation(async () =>
        // 80 occurs in a label, but is not an explicit backend value and therefore is not evidence.
        success('{"claims":[{"type":"prediction","text":"Forecast is 80 units."}]}'),
      );
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).rejects.toMatchObject({
      type: 'invented_number',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects causal or certain wording for a forecast after one retry', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockImplementation(async () =>
        success(
          '{"claims":[{"type":"prediction","text":"The input definitely caused the forecast of 12 units."}]}',
        ),
      );
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).rejects.toMatchObject({
      type: 'unsafe_language',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries timeouts at most twice', async () => {
    const timeout = new Error('secret provider detail');
    timeout.name = 'TimeoutError';
    const fetcher = jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockRejectedValue(timeout);
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).rejects.toMatchObject({
      type: 'timeout',
      message: 'timeout',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(built.sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(built.sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('honours retry-after of ten seconds or less on 429', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(success());
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).resolves.toBeDefined();
    expect(built.sleep).toHaveBeenCalledWith(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back immediately when retry-after is over ten seconds', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '11' } }));
    const built = client(fetcher);

    await expect(built.client.generate('forecast', facts)).rejects.toMatchObject({
      type: 'rate_limit',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(built.sleep).not.toHaveBeenCalled();
  });

  it('retries a provider 500 twice and returns only a safe error type', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValue(new Response('GROQ_API_KEY=test-secret-key', { status: 500 }));
    const built = client(fetcher);

    let error: unknown;
    try {
      await built.client.generate('forecast', facts);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AiProviderError);
    expect(JSON.stringify(error)).not.toContain('test-secret-key');
    expect(error).toMatchObject({ type: 'provider_5xx', message: 'provider_5xx' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
