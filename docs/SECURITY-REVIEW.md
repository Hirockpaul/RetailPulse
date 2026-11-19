# RetailPulse V2 security review

Reviewed 2026-11-18 for step 5c. This review covers the repository, the HTTP boundary and the local
Compose demo. RetailPulse contains synthetic data and is **not a production deployment**.

## Scope and threat model

The protected asset is the inventory ledger and the human decisions around transfers, orders,
anomalies, reports and model activation. The main threats considered are an anonymous or
wrong-role caller, a store manager crossing store scope, a cross-site browser write, stolen
credentials/session material, malformed input, injection, secret leakage, unsafe model artifacts,
and accidental exposure of local infrastructure.

The browser and API are one origin. PostgreSQL, forecasting and optional observability services are
trusted local infrastructure. The forecasting service has no login and must remain internal.
Prometheus, Grafana, MLflow and Jaeger are localhost-only local tools, not hardened multi-user
services. TLS, host allow-listing, HSTS and edge denial-of-service controls belong at a real
deployment's trusted reverse proxy.

The controls follow the OWASP guidance for
[sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[HTTP response headers](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
and [Content Security Policy](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
SameSite is treated as defence in depth, not the only cross-site request control.

## Executable checklist

| Verify that | Result and evidence |
| --- | --- |
| Every route is explicitly public or role-protected | Pass. The global `AuthGuard` denies by default; `app.spec.ts` discovers every controller route and fails if its metadata is missing. |
| Anonymous and wrong-role requests are rejected | Pass. HTTP tests cover protected reads/writes, all roles and the stable 401/403 envelope. |
| A store manager cannot cross store scope | Pass. `core/auth/access.ts` supplies the shared filter/assertion and integration tests exercise reads and writes against real PostgreSQL. |
| Passwords are memory-hard and comparisons do not leak | Pass. scrypt uses N=32768, r=8, p=3, random 16-byte salts and constant-time comparison. Unknown accounts run a dummy hash; tests prove unknown, disabled and wrong-password responses are identical. |
| Sessions are unpredictable, server-side, revocable and expire | Pass. Tokens contain 32 random bytes; only SHA-256 is stored. Validation requires an active user and an unexpired row; logout deletes it. Integration tests cover storage, expiry and logout. |
| Browser cookies are protected | Pass. `HttpOnly`, `SameSite=Strict`, path `/`, eight-hour expiry and `Secure` in production. A focused test covers the production option. The web app keeps user display state in memory and never reads the cookie. |
| Login guessing is bounded | Pass for the documented single API instance: five failures per email + IP in 15 minutes, bounded in-memory state and a tested 429. See the multi-instance limitation below. |
| Cross-site browser writes are refused | Pass. Unsafe methods reject a mismatched/malformed `Origin` or `Sec-Fetch-Site: cross-site`; same-origin writes and non-browser clients without browser headers remain supported. CORS is not enabled. |
| Inputs are bounded and SQL is not injectable | Pass. Request bodies/queries use Zod at controller boundaries, stock-changing writes require bounded idempotency keys, repositories use PostgreSQL parameters, and the reviewed dynamic fragments come only from fixed mappings/constants. |
| Errors do not disclose internals | Pass. Expected failures use a stable code/message/details envelope; unexpected clients receive only `INTERNAL_ERROR` while the server log is correlated. Tests cover the envelope. |
| Browser output is hardened | Pass. The API sends no-store, nosniff, frame, referrer and permissions headers. The docs reader uses a random per-response nonce CSP and escapes contract content before HTML insertion. Nginx repeats the static-app headers in every location that overrides `add_header` inheritance and applies a restrictive React CSP. |
| Credentials and request secrets stay out of source/logs/traces | Pass. Only `.env.example` is tracked. Runtime credentials come from environment variables. The API does not log bodies/cookies; tracing tests prove query values, SQL, bodies and credentials are stripped. Session tokens are hashed before persistence. |
| Model artifacts cannot be substituted silently | Pass from 3b. Artifacts are content-addressed under one configured directory; path containment, identity metadata and SHA-256 are checked before joblib load. Rollback loads the prior verified artifact. Pickle/joblib files remain trusted service-owned inputs, never uploads. |
| Local infrastructure is not accidentally public | Pass after 5c fixes. Every published Compose port, including PostgreSQL, binds to `127.0.0.1`; forecasting has no published port. Grafana has no initial admin account and anonymous access is read-only over synthetic localhost data. The restricted Grafana DB role can select only reporting views. |
| Known vulnerable production packages fail CI | Pass. CI runs `npm audit --omit=dev --audit-level=high` and pinned `pip-audit` against forecasting production requirements. Both audits reported zero known vulnerabilities on 2026-11-18. |

## Findings fixed in 5c

1. PostgreSQL was published on all host interfaces despite the Compose comment. It now binds to
   `127.0.0.1` like every other published service.
2. Nginx locations that set `Cache-Control` did not inherit server-level security headers because
   of Nginx `add_header` inheritance. Each static location now declares the complete set and a test
   prevents regression.
3. `SameSite=Strict` was the only cross-site write defence. Unsafe browser requests now also pass
   Origin/Fetch Metadata validation.
4. The docs reader used inline script/style without CSP. It now receives a cryptographically random
   nonce and a restrictive policy for each response.
5. Grafana shipped a known fallback administrator password even though only anonymous read-only
   local viewing is needed. Initial administrator creation is now disabled.
6. Dependency audits were manual. Production Node and Python audits now run in CI.

## Accepted limitations and deployment requirements

- The login throttle is process-local and resets on restart. Move it to PostgreSQL or Redis before
  multiple API replicas or hostile internet traffic.
- The local HTTP demo deliberately omits HSTS. A real deployment must terminate TLS, redirect HTTP,
  validate allowed hosts, set HSTS after HTTPS is proven, and mark forwarded headers as trusted only
  from its proxy.
- Grafana, Prometheus, MLflow and Jaeger are suitable only for synthetic localhost data. Add
  authentication/network policy and durable encrypted storage before any shared environment.
- Forecasting trusts calls on the private service network. Add service authentication or mTLS if
  that network stops being a single trusted boundary.
- CSP currently needs `style-src 'unsafe-inline'` for React's existing dynamic style attributes;
  scripts remain inline-blocked. Migrating dynamic styles to classes would allow removing it.
- Backups, restore verification, secret rotation and encrypted off-host storage belong to step 5e.
- Dependency scanners report known published advisories, not absence of defects. Keep lockfiles,
  base images and audits current.

## Repeatable verification

```bash
npm audit --omit=dev --audit-level=high
services/forecasting/.venv/bin/pip-audit -r services/forecasting/requirements.txt
npm run check
npm run test:int
npm run forecast:test
npm run test:e2e
docker compose config --quiet
```

For a container check, build the three images, start the `full` profile, inspect headers on `/` and
signed-in `/api/v1/docs`, then confirm PostgreSQL, web, API and optional UIs listen only on loopback.
