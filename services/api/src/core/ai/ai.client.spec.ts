import { Logger } from '@nestjs/common';
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

    await expect(built.client.generate('groq', 'forecast', facts)).resolves.toEqual({
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

    await expect(built.client.generate('groq', 'forecast', facts)).rejects.toMatchObject({
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

    await expect(built.client.generate('groq', 'forecast', facts)).rejects.toMatchObject({
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

    await expect(built.client.generate('groq', 'forecast', facts)).rejects.toMatchObject({
      type: 'unsafe_language',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries timeouts at most twice', async () => {
    const timeout = new Error('secret provider detail');
    timeout.name = 'TimeoutError';
    const fetcher = jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockRejectedValue(timeout);
    const built = client(fetcher);

    await expect(built.client.generate('groq', 'forecast', facts)).rejects.toMatchObject({
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

    await expect(built.client.generate('groq', 'forecast', facts)).resolves.toBeDefined();
    expect(built.sleep).toHaveBeenCalledWith(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back immediately when retry-after is over ten seconds', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '11' } }));
    const built = client(fetcher);

    await expect(built.client.generate('groq', 'forecast', facts)).rejects.toMatchObject({
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
      await built.client.generate('groq', 'forecast', facts);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AiProviderError);
    expect(JSON.stringify(error)).not.toContain('test-secret-key');
    expect(error).toMatchObject({ type: 'provider_5xx', message: 'provider_5xx' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('calls NVIDIA NIM without streaming or visible reasoning and checks its JSON', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValue(success());
    const sleep = jest.fn<ReturnType<AiSleep>, Parameters<AiSleep>>().mockResolvedValue(undefined);
    const nvidiaClient = new AiClient(
      env({
        AI_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'nvidia-test-secret',
        NVIDIA_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b',
      }),
      fetcher,
      sleep,
    );

    await expect(nvidiaClient.generate('nvidia', 'forecast', facts)).resolves.toEqual({
      answer: { claims: [{ type: 'prediction', text: 'Forecast is 12 units.' }] },
      usage: { inputTokens: 41, outputTokens: 9 },
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer nvidia-test-secret' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      stream: false,
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
    });
    expect(String(init.body)).not.toContain('nvidia-test-secret');
  });

  it('executes only a declared read tool and validates the final assistant numbers', async () => {
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'get_stock', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '{"claims":[{"type":"fact","text":"Available stock is 12 units."}]}',
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          }),
          { status: 200 },
        ),
      );
    const built = client(fetcher);
    const execute = jest.fn().mockResolvedValue({
      content: { available: 12 },
      facts: [{ id: 'stock.available', label: 'available', value: 12 }],
    });

    await expect(
      built.client.assist(
        'groq',
        'How much stock is available?',
        [
          {
            type: 'function',
            function: {
              name: 'get_stock',
              description: 'Read stock.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
        execute,
      ),
    ).resolves.toEqual({
      answer: { claims: [{ type: 'fact', text: 'Available stock is 12 units.' }] },
      toolsUsed: ['get_stock'],
      usage: { inputTokens: 50, outputTokens: 15 },
    });
    expect(execute).toHaveBeenCalledWith('get_stock', '{}');
    const secondBody = JSON.parse(String(fetcher.mock.calls[1][1].body));
    expect(secondBody.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'get_stock',
      content: '{"available":12}',
    });
  });

  it('rejects an undeclared assistant tool before executing it', async () => {
    const fetcher = jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'change_stock', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const built = client(fetcher);
    const execute = jest.fn();

    await expect(built.client.assist('groq', 'Change stock.', [], execute)).rejects.toMatchObject({
      type: 'invalid_schema',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('corrects an invented assistant number once using the existing tool evidence', async () => {
    const toolCall = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'get_stock', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
    const answer = (units: number) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `{"claims":[{"type":"fact","text":"Available stock is ${units} units."}]}`,
              },
            },
          ],
        }),
        { status: 200 },
      );
    const fetcher = jest
      .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
      .mockResolvedValueOnce(toolCall)
      .mockResolvedValueOnce(answer(99))
      .mockResolvedValueOnce(answer(12));
    const built = client(fetcher);

    await expect(
      built.client.assist(
        'groq',
        'How much stock is available?',
        [
          {
            type: 'function',
            function: {
              name: 'get_stock',
              description: 'Read stock.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
        async () => ({
          content: { available: 12 },
          facts: [{ id: 'stock.available', label: 'available', value: 12 }],
        }),
      ),
    ).resolves.toMatchObject({
      answer: { claims: [{ type: 'fact', text: 'Available stock is 12 units.' }] },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(String(fetcher.mock.calls[2][1].body));
    expect(retryBody.messages.at(-1).content).toContain('failed the required JSON');
  });

  describe('token budget and reasoning (Groq gpt-oss reasons before answering)', () => {
    const fetchOk = () =>
      jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockResolvedValue(success());
    const sleepNone = () =>
      jest.fn<ReturnType<AiSleep>, Parameters<AiSleep>>().mockResolvedValue(undefined);

    it('asks Groq gpt-oss for low, hidden reasoning and uses max_completion_tokens (default 1500)', async () => {
      const fetcher = fetchOk();
      await new AiClient(env(), fetcher, sleepNone()).generate('groq', 'forecast', facts);
      const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
      expect(body).toMatchObject({
        max_completion_tokens: 1500,
        reasoning_effort: 'low',
        include_reasoning: false,
      });
      expect(body).not.toHaveProperty('max_tokens');
    });

    it('sends no reasoning fields to other Groq models', async () => {
      const fetcher = fetchOk();
      await new AiClient(
        env({ GROQ_MODEL: 'qwen/qwen3.8-27b', AI_MAX_TOKENS: '900' }),
        fetcher,
        sleepNone(),
      ).generate('groq', 'forecast', facts);
      const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
      expect(body.max_completion_tokens).toBe(900);
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('include_reasoning');
      expect(body).not.toHaveProperty('max_tokens');
    });

    it('keeps max_tokens for NVIDIA, in explanations and in the assistant', async () => {
      const nvidiaEnv = env({ AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'nvidia-test-secret' });
      const fetcher = fetchOk();
      await new AiClient(nvidiaEnv, fetcher, sleepNone()).generate('nvidia', 'forecast', facts);
      const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
      expect(body).toMatchObject({ max_tokens: 1500, stream: false, reasoning_effort: 'none' });
      expect(body).not.toHaveProperty('max_completion_tokens');

      const toolFetcher = jest
        .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
        .mockResolvedValue(success('not used'));
      await new AiClient(nvidiaEnv, toolFetcher, sleepNone())
        .assist('nvidia', 'What is low?', [], jest.fn())
        .catch(() => undefined);
      const assistBody = JSON.parse(String(toolFetcher.mock.calls[0][1].body));
      expect(assistBody).toMatchObject({ max_tokens: 1500, stream: false });
      expect(assistBody).not.toHaveProperty('max_completion_tokens');
    });

    it('an answer cut off by the token limit fails as truncated, without a pointless retry', async () => {
      const fetcher = jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"claims":[{"type":"fa' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 400, completion_tokens: 1500 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      await expect(
        new AiClient(env(), fetcher, sleepNone()).generate('groq', 'forecast', facts),
      ).rejects.toMatchObject({ type: 'truncated' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('the assistant also stops on a cut-off answer', async () => {
      const fetcher = jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '{"cl' }, finish_reason: 'length' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      await expect(
        new AiClient(env(), fetcher, sleepNone()).assist('groq', 'What is low?', [], jest.fn()),
      ).rejects.toMatchObject({ type: 'truncated' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("the provider's error code is kept for the log, nothing else", () => {
    const failing = (status: number, body: unknown) =>
      jest.fn<ReturnType<AiFetch>, Parameters<AiFetch>>().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const sleepNone = () =>
      jest.fn<ReturnType<AiSleep>, Parameters<AiSleep>>().mockResolvedValue(undefined);

    it('keeps a short code such as json_validate_failed on a 400', async () => {
      const fetcher = failing(400, {
        error: {
          message: 'Failed to validate JSON. Generated: {"claims":[{"text":"Tea 500 ...',
          type: 'invalid_request_error',
          code: 'json_validate_failed',
        },
      });
      const error = await new AiClient(env(), fetcher, sleepNone())
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ type: 'provider_4xx', detail: 'json_validate_failed' });
      expect(String((error as AiProviderError).detail)).not.toContain('Tea 500');
    });

    it('falls back to the error type, and drops anything that is not code-shaped', async () => {
      const typed = await new AiClient(
        env(),
        failing(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } }),
        sleepNone(),
      )
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect(typed).toMatchObject({ type: 'provider_4xx', detail: 'invalid_request_error' });

      const prose = await new AiClient(
        env(),
        failing(400, { error: { code: 'model said: Tea 500 is low!' } }),
        sleepNone(),
      )
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect(prose).toMatchObject({ type: 'provider_4xx' });
      expect((prose as AiProviderError).detail).toBeUndefined();

      const notJson = await new AiClient(
        env(),
        jest
          .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
          .mockResolvedValue(new Response('<html>bad gateway</html>', { status: 403 })),
        sleepNone(),
      )
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect((notJson as AiProviderError).detail).toBeUndefined();
    });
  });

  describe('a rejected answer is logged with its reason, never with its text', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());
    const sleepNone = () =>
      jest.fn<ReturnType<AiSleep>, Parameters<AiSleep>>().mockResolvedValue(undefined);
    const always = (content: string) =>
      jest
        .fn<ReturnType<AiFetch>, Parameters<AiFetch>>()
        .mockImplementation(async () => success(content));

    it('names the invented number before the retry and again on the final failure', async () => {
      const answer =
        '{"claims":[{"type":"prediction","text":"Tea 500 will sell about 46 units."}]}';
      const error = await new AiClient(env(), always(answer), sleepNone())
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ type: 'invented_number', detail: '46' });
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        'AI provider groq forecast answer rejected: invented_number (46); retrying once',
        'AI provider groq forecast answer rejected: invented_number (46)',
      ]);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('will sell');
    });

    it('names the forbidden word for unsafe wording', async () => {
      const answer =
        '{"claims":[{"type":"prediction","text":"The weekday CAUSED the forecast of 12."}]}';
      const error = await new AiClient(env(), always(answer), sleepNone())
        .generate('groq', 'forecast', facts)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ type: 'unsafe_language', detail: 'caused' });
      expect(warn.mock.calls[0][0]).toBe(
        'AI provider groq forecast answer rejected: unsafe_language (caused); retrying once',
      );
    });

    it('logs invalid JSON without any detail', async () => {
      await new AiClient(env(), always('{"claims": [ oops'), sleepNone())
        .generate('groq', 'forecast', facts)
        .catch(() => undefined);
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        'AI provider groq forecast answer rejected: invalid_json; retrying once',
        'AI provider groq forecast answer rejected: invalid_json',
      ]);
    });

    it('a valid answer logs nothing', async () => {
      await new AiClient(
        env(),
        always('{"claims":[{"type":"prediction","text":"Forecast is 12 units."}]}'),
        sleepNone(),
      ).generate('groq', 'forecast', facts);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
