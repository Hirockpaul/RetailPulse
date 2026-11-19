import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('deployed web security configuration', () => {
  const nginx = readFileSync(resolve(__dirname, '../../../apps/web/nginx.conf'), 'utf8');

  it('keeps all security headers in locations that override add_header inheritance', () => {
    for (const header of [
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
      'Permissions-Policy',
      'Content-Security-Policy',
    ]) {
      expect(nginx.match(new RegExp(`add_header ${header}`, 'g'))).toHaveLength(2);
    }
  });

  it('uses a restrictive application CSP and forwards the effective browser host', () => {
    expect(nginx).toContain("default-src 'self'");
    expect(nginx).toContain("object-src 'none'");
    expect(nginx).toContain("frame-ancestors 'none'");
    expect(nginx).not.toMatch(/script-src[^;\n]*unsafe-inline/);
    expect(nginx).toContain('proxy_set_header X-Forwarded-Host $http_host;');
  });

  it('does not enable HSTS on the localhost HTTP demo', () => {
    expect(nginx).not.toContain('Strict-Transport-Security');
  });
});

describe('local service exposure', () => {
  const compose = readFileSync(resolve(__dirname, '../../../docker-compose.yml'), 'utf8');

  it('binds every published service to localhost and keeps forecasting internal', () => {
    const publishedPorts = [...compose.matchAll(/^\s+- ['"]?([^,'"\s]+:\d+)['"]?$/gm)].map(
      (match) => match[1],
    );
    expect(publishedPorts.length).toBeGreaterThan(0);
    expect(publishedPorts.every((port) => port.startsWith('127.0.0.1:'))).toBe(true);

    const forecasting = compose.match(/\n {2}forecasting:\n([\s\S]*?)\n {2}api:/)?.[1];
    expect(forecasting).toBeDefined();
    expect(forecasting).not.toMatch(/^\s+ports:/m);
  });

  it('does not ship Grafana with a default administrator credential', () => {
    expect(compose).toContain("GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION: 'true'");
    expect(compose).not.toContain('GF_SECURITY_ADMIN_PASSWORD');
  });
});
