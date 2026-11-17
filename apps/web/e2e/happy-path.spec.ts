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
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Out of stock now')).toBeVisible();
  await expect(page.getByText('No forecast yet')).toBeVisible();
  await expect(page.getByText('Synthetic demo data').first()).toBeVisible();

  // Find a product.
  const nav = page.getByRole('navigation', { name: 'Main' });
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
