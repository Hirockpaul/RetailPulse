export const OPENAPI_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RetailPulse API documentation</title>
  <style>
    :root { color-scheme: light; font: 15px/1.5 system-ui, sans-serif; color: #172033; background: #f6f8fb; }
    body { margin: 0; }
    header { background: #172033; color: white; padding: 2rem max(1rem, calc((100% - 70rem)/2)); }
    header p { color: #cdd6e5; max-width: 55rem; }
    main { max-width: 70rem; margin: auto; padding: 1.5rem 1rem 4rem; }
    a { color: #1559a6; }
    #status { color: #526078; }
    section { margin-top: 2rem; }
    article { background: white; border: 1px solid #dce2eb; border-radius: .55rem; margin: .65rem 0; overflow: hidden; }
    summary { cursor: pointer; display: flex; align-items: baseline; gap: .7rem; padding: .8rem 1rem; }
    code.method { min-width: 3rem; font-weight: 750; color: #075985; text-transform: uppercase; }
    code.path { color: #26344d; overflow-wrap: anywhere; }
    .summary { margin-left: auto; color: #526078; text-align: right; }
    .detail { border-top: 1px solid #e7ebf1; padding: 1rem; }
    pre { background: #f3f5f8; overflow: auto; padding: .8rem; border-radius: .35rem; font-size: .82rem; }
    .error { color: #a11; font-weight: 650; }
    @media (max-width: 42rem) { summary { flex-wrap: wrap; } .summary { width: 100%; text-align: left; margin-left: 3.7rem; } }
  </style>
</head>
<body>
  <header>
    <h1>RetailPulse API</h1>
    <p>Generated OpenAPI 3.1 documentation for an independent inventory simulation. All demo and forecast data is synthetic.</p>
    <a href="/api/v1/openapi.json" style="color:#a9d4ff">Download openapi.json</a>
  </header>
  <main>
    <p id="status">Loading the signed-in API contract…</p>
    <div id="routes"></div>
  </main>
  <script>
    const status = document.querySelector('#status');
    const routes = document.querySelector('#routes');
    const esc = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    fetch('/api/v1/openapi.json', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('OpenAPI request failed (' + response.status + ')');
      const spec = await response.json();
      const groups = new Map();
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          const tag = operation.tags?.[0] ?? 'Other';
          const list = groups.get(tag) ?? [];
          list.push({ path, method, operation });
          groups.set(tag, list);
        }
      }
      const count = [...groups.values()].reduce((n, list) => n + list.length, 0);
      status.textContent = 'OpenAPI ' + spec.openapi + ' · ' + count + ' operations · session cookie authentication';
      for (const [tag, list] of groups) {
        const section = document.createElement('section');
        section.innerHTML = '<h2>' + esc(tag) + '</h2>';
        for (const item of list) {
          const details = document.createElement('article');
          const request = item.operation.requestBody?.content?.['application/json']?.schema;
          const params = item.operation.parameters ?? [];
          details.innerHTML = '<details><summary><code class="method">' + esc(item.method) + '</code><code class="path">' + esc(item.path) + '</code><span class="summary">' + esc(item.operation.summary) + '</span></summary><div class="detail">' +
            (params.length ? '<h3>Parameters</h3><pre>' + esc(JSON.stringify(params, null, 2)) + '</pre>' : '') +
            (request ? '<h3>JSON body</h3><pre>' + esc(JSON.stringify(request, null, 2)) + '</pre>' : '') +
            '<h3>Responses</h3><pre>' + esc(JSON.stringify(item.operation.responses, null, 2)) + '</pre></div></details>';
          section.append(details);
        }
        routes.append(section);
      }
    }).catch(error => { status.className = 'error'; status.textContent = error.message; });
  </script>
</body>
</html>`;
