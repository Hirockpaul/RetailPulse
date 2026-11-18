import { redactQueryValues, SensitiveAttributeProcessor, tracesEndpoint } from './tracing';

describe('optional tracing', () => {
  it('stays disabled without an exporter and normalizes configured endpoints', () => {
    expect(tracesEndpoint(undefined)).toBeNull();
    expect(tracesEndpoint('   ')).toBeNull();
    expect(tracesEndpoint('http://jaeger:4318/')).toBe('http://jaeger:4318/v1/traces');
    expect(tracesEndpoint('http://collector/v1/traces')).toBe('http://collector/v1/traces');
  });

  it('redacts every query value while retaining parameter names', () => {
    expect(redactQueryValues('/api/v1/products?search=milk&page=2')).toBe(
      '/api/v1/products?search=REDACTED&page=REDACTED',
    );
    expect(redactQueryValues('token=secret&token=again')).toBe('token=REDACTED');
    expect(redactQueryValues('/api/v1/health')).toBe('/api/v1/health');
  });

  it('removes SQL and body attributes before a span can be exported', () => {
    const attributes: Record<string, string> = {
      'db.query.text': 'SELECT password FROM users',
      'http.request.body': '{"password":"secret"}',
      'url.query': 'search=private&page=3',
    };
    const span = {
      attributes,
      setAttribute(key: string, value: string) {
        attributes[key] = value;
        return this;
      },
    } as never;
    new SensitiveAttributeProcessor().onEnding(span);
    expect(attributes['db.query.text']).toBeUndefined();
    expect(attributes['http.request.body']).toBeUndefined();
    expect(attributes['url.query']).toBe('search=REDACTED&page=REDACTED');
  });
});
