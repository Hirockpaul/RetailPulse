import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The main happy path of an inventory manager, through the real UI:
 * sign in → Overview → receive and sell stock (ledger shows both) → transfer stock from a
 * distribution centre to a store through every step. All data is synthetic.
 */
const SKU = 'RP-00001';

async function pick(select: Locator, code: string) {
  const value = await select.locator('option', { hasText: `${code} —` }).getAttribute('value');
  await select.selectOption(value!);
}

async function record(page: Page, action: string, location: string, quantity: string) {
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Record' }) });
  await form.getByLabel('Action').selectOption(action);
  await pick(form.getByLabel('Location'), location);
  await form.getByLabel('Quantity').fill(quantity);
  await form.getByRole('button', { name: 'Record' }).click();
  await expect(form.getByRole('status')).toBeVisible();
}

test('inventory manager: overview → receive → sell → transfer DC to store', async ({ page }) => {
  // Sign in.
  await page.goto('/');
  await page.getByLabel('Email').fill('inventory@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Overview is the landing page; without a forecast it says so instead of guessing.
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();
  await expect(page.getByText('Out of stock now')).toBeVisible();
  // The e2e database has a labelled fixture forecast (e2e/forecast-fixture.mjs), so risks show.
  await expect(page.getByText('At risk within 7 days')).toBeVisible();
  await expect(page.getByText('Synthetic demo data').first()).toBeVisible();

  // Find a product.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await nav.getByRole('link', { name: 'Products' }).click();
  await page.getByPlaceholder('Search SKU or name').fill(SKU);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: SKU }).click();
  await expect(page.getByRole('heading', { name: 'Record a stock movement' })).toBeVisible();

  // Receive 10 at STR-01, then sell 2 there: both appear in the ledger, newest first.
  await record(page, 'RECEIVE', 'STR-01', '10');
  await record(page, 'SELL', 'STR-01', '2');
  const ledgerRows = page.locator('section[aria-labelledby="ledger-heading"] tbody tr');
  await expect(ledgerRows.nth(0)).toContainText('sale');
  await expect(ledgerRows.nth(0)).toContainText('-2');
  await expect(ledgerRows.nth(1)).toContainText('receipt');
  await expect(ledgerRows.nth(1)).toContainText('+10');

  // Request a transfer DC-NORTH → STR-01 and take it through every step.
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await nav.getByRole('link', { name: 'Transfers' }).click();
  const form = page.locator('form', {
    has: page.getByRole('button', { name: 'Request transfer' }),
  });
  // Destination first: each list leaves out the location chosen in the other one.
  await pick(form.getByLabel(/^To/), 'STR-01');
  await pick(form.getByLabel('From'), 'DC-NORTH');
  await form.getByPlaceholder('SKU or name').fill(SKU);
  await form.getByRole('button', { name: 'Search' }).click();
  await form.getByRole('button', { name: 'Add', exact: true }).first().click();
  await form.getByLabel('Qty').fill('3');
  await form.getByRole('button', { name: 'Request transfer' }).click();

  await expect(page.getByRole('heading', { name: 'DC-NORTH → STR-01' })).toBeVisible();
  for (const [step, status] of [
    ['Approve', 'Approved'],
    ['Dispatch', 'In transit'],
    ['Receive', 'Received'],
  ]) {
    await page.getByRole('button', { name: step, exact: true }).click();
    await expect(page.locator('header').getByText(status, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('This transfer is finished.')).toBeVisible();
});

test('a large write-off becomes a finding that a manager can investigate', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('inventory@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();

  // Receive 30 of a product at STR-02, then write 25 of them off in one adjustment.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await nav.getByRole('link', { name: 'Products' }).click();
  await page.getByPlaceholder('Search SKU or name').fill('RP-00002');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: 'RP-00002' }).click();
  await record(page, 'RECEIVE', 'STR-02', '30');
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Record' }) });
  await form.getByLabel('Action').selectOption('ADJUST');
  await pick(form.getByLabel('Location'), 'STR-02');
  await form.getByLabel('Change (+/−)').fill('-25');
  await form.getByLabel('Reason (required)').fill('e2e: damaged in storage');
  await form.getByRole('button', { name: 'Record' }).click();
  await expect(form.getByRole('status')).toBeVisible();

  // The event worker turns it into a finding within seconds.
  await nav.getByRole('button', { name: 'Intelligence' }).click();
  await nav.getByRole('link', { name: 'Unusual activity' }).click();
  const finding = page.getByRole('link', { name: 'Large write-off' });
  await expect(async () => {
    await page.reload();
    await expect(finding.first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await finding.first().click();
  await expect(page.getByText('One adjustment removed 25 units at once')).toBeVisible();
  await page.getByRole('button', { name: 'Start investigating' }).click();
  await expect(page.getByText('new → investigating')).toBeVisible();
});

test('the nine steps: Control Tower risk → forecast → explanation → recommendation → approved transfer → stock', async ({
  page,
}) => {
  // 1. Sign in.
  await page.goto('/');
  await page.getByLabel('Email').fill('inventory@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // 2. Control Tower: the risk is there.
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();
  const soonest = page
    .locator('div', { has: page.getByRole('heading', { name: /^Soonest to run out/ }) })
    .last();
  const firstRisk = soonest.locator('tbody tr').first();
  await expect(firstRisk).toContainText('STR-01');
  const sku = (await firstRisk.getByRole('link').first().textContent())!.trim();

  // 3. The product's forecast, at that store.
  await firstRisk.getByRole('link', { name: sku }).click();
  const stockRow = page
    .locator('section[aria-labelledby="stock-heading"] tbody tr')
    .filter({ hasText: 'STR-01' });
  const onHandBefore = Number(
    (await stockRow.locator('td').nth(2).textContent())!.replace(/\D/g, ''),
  );
  const forecast = page.locator('section[aria-labelledby="forecast-heading"]');
  await pick(forecast.getByLabel('Store'), 'STR-01');
  await expect(forecast.getByRole('img').first()).toBeVisible();

  // 4. Why this forecast?
  await forecast.getByText('Why this forecast?').click();
  await expect(forecast.getByText('Average sales, last 56 days')).toBeVisible();
  await forecast.getByRole('button', { name: 'Explain in words' }).click();
  await expect(forecast.getByText('Template explanation')).toBeVisible();
  await expect(forecast.getByText(/measured uncertainty ranges, not guarantees/)).toBeVisible();

  // 5. A recommendation from the current forecast and stock.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Planning' }).click();
  await nav.getByRole('link', { name: 'Replenishment' }).click();
  await page.getByRole('button', { name: 'Recalculate' }).click();
  const recRow = page.getByRole('row').filter({ hasText: sku }).filter({ hasText: 'STR-01' });
  await expect(recRow).toContainText('Transfer from DC-NORTH');
  await recRow.getByRole('link', { name: sku }).click();
  const header = (await page.getByText(/^Transfer from DC-NORTH:/).textContent())!;
  const quantity = Number(/:\s*([\d,]+) units/.exec(header)![1].replace(/,/g, ''));
  expect(quantity).toBeGreaterThan(0);

  // 6. Approve: an approved transfer is created, no stock has moved yet.
  await page.getByRole('button', { name: 'Approve and create transfer' }).click();
  await expect(page.getByText(/^Approved by Imani Inventory/)).toBeVisible();

  // 7. The transfer: dispatch and receive.
  await page.getByRole('link', { name: 'View the transfer →' }).click();
  await expect(page.getByRole('heading', { name: 'DC-NORTH → STR-01' })).toBeVisible();
  for (const [step, status] of [
    ['Dispatch', 'In transit'],
    ['Receive', 'Received'],
  ]) {
    await page.getByRole('button', { name: step, exact: true }).click();
    await expect(page.locator('header').getByText(status, { exact: true })).toBeVisible();
  }

  // 8–9. The store's stock went up by exactly the approved quantity.
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await nav.getByRole('link', { name: 'Products' }).click();
  await page.getByPlaceholder('Search SKU or name').fill(sku);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: sku }).click();
  await expect(stockRow.locator('td').nth(2)).toHaveText(
    new Intl.NumberFormat().format(onHandBefore + quantity),
  );
});

test('a what-if scenario runs in the browser and changes no stock, ledger or recommendation', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('inventory@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();

  const api = async () => {
    const overview = await (await page.request.get('/api/v1/overview')).json();
    const recs = await (
      await page.request.get('/api/v1/replenishment/recommendations?pageSize=1')
    ).json();
    return {
      onHand: overview.controlTower.kpis.onHand,
      openTransfers: overview.controlTower.kpis.openTransfers,
      lastMovementAt: overview.freshness.lastMovementAt,
      recommendations: recs.total,
    };
  };
  const before = await api();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Planning' }).click();
  await nav.getByRole('link', { name: 'Scenarios' }).click();
  const name = `E2E demand +50 % ${Date.now()}`;
  const form = page.getByRole('form', { name: 'New scenario' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Demand change (%)').fill('50');
  await form.getByRole('button', { name: 'Save scenario' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('never run');
  await row.getByRole('button', { name: 'Run' }).click();
  await expect(row).not.toContainText('never run');
  await row.getByRole('checkbox').check();
  await expect(page.getByRole('heading', { name: 'Comparison' })).toBeVisible();

  expect(await api()).toEqual(before);
});

test('a manager generates a report, sees its period and generation time, and can print it', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('inventory@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Intelligence' }).click();
  await nav.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();

  const form = page.getByRole('form', { name: 'Generate a report' });
  await form.getByLabel('Scope').selectOption({ label: 'STR-01 — Riverside Store' });
  await form.getByRole('button', { name: 'Generate' }).click();

  // The report page: period, scope and generation time up front; CSV and print available.
  await expect(page.getByText('Daily report · STR-01 — Riverside Store')).toBeVisible();
  await expect(page.getByText('(UTC days)')).toBeVisible();
  await expect(page.getByText(/by Imani Inventory$/)).toBeVisible();
  const csv = page.getByRole('link', { name: 'Download CSV' });
  await expect(csv).toHaveAttribute('href', /\/api\/v1\/reports\/[0-9a-f-]+\/export\.csv$/);
  const download = await page.request.get((await csv.getAttribute('href'))!);
  expect(download.status()).toBe(200);
  expect((await download.text()).split('\r\n')[0]).toBe('section,metric,location,product,value');

  // Printing hides the navigation and the buttons, keeps the period.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Print / save as PDF' })).toBeHidden();
  await expect(page.getByText('(UTC days)')).toBeVisible();
});

test('a signed-in analyst can read the generated API contract', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('analyst@retailpulse.test');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Control Tower' })).toBeVisible();

  await page.goto('/api/v1/docs');
  await expect(page).toHaveTitle('RetailPulse API documentation');
  await expect(page.locator('#status')).toHaveText(
    'OpenAPI 3.1.0 · 78 operations · session cookie authentication',
  );
  await expect(page.locator('main article')).toHaveCount(78);
  await expect(page.getByRole('heading', { name: 'Inventory movements' })).toBeVisible();
});
