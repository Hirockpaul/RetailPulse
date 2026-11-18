import { propagation } from '@opentelemetry/api';
import { ForecastClient } from './forecast.client';

describe('ForecastClient trace context', () => {
  afterEach(() => jest.restoreAllMocks());

  it('injects W3C context and forwards the correlation ID to forecasting', async () => {
    jest.spyOn(propagation, 'inject').mockImplementation((_context, carrier) => {
      (carrier as Record<string, string>).traceparent =
        '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"runId":"run-1","status":"RUNNING"}'));
    const client = new ForecastClient({ FORECAST_URL: 'http://forecasting:8000' } as never);

    await client.startRun(14, 'corr-test-12345');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://forecasting:8000/forecast/run',
      expect.objectContaining({
        headers: expect.objectContaining({
          traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
          'x-correlation-id': 'corr-test-12345',
        }),
      }),
    );
  });
});
