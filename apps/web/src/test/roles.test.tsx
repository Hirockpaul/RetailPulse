/**
 * Role-based visibility (V2 6-1, D5). The API enforces every rule; these check that the UI does not
 * offer what a role may not do.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ReportsPage } from '../pages/ReportsPage';
import { ScenariosPage } from '../pages/ScenariosPage';
import { fakeApi, page, renderSignedIn, STR1, STR2 } from './render';

const scenario = {
  id: 's1',
  name: 'Demand +20 %',
  description: null,
  demandPct: 20,
  supplierLeadTimeDays: 0,
  dcAvailabilityPct: 0,
  createdBy: 'Test',
  createdAt: '2026-11-18T10:00:00Z',
  latestResult: null,
};

describe('menu', () => {
  it.each([
    ['INVENTORY_MANAGER', true],
    ['ANALYST', true],
    ['STORE_MANAGER', false],
  ] as const)('%s sees Planning → Scenarios: %s', async (role, visible) => {
    fakeApi(role, { '/overview': 'pending' });
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await userEvent.click(within(nav).getByRole('button', { name: /Planning/ }));
    expect(within(nav).getByRole('link', { name: 'Replenishment' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Scenarios' }) !== null).toBe(visible);
  });
});

describe('Scenarios page', () => {
  it('approvers can create and run; analysts only read', async () => {
    fakeApi('INVENTORY_MANAGER', { '/scenarios': { body: [scenario] } });
    const first = renderSignedIn(<ScenariosPage />);
    expect(await screen.findByRole('form', { name: 'New scenario' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Run' })).toBeInTheDocument();
    first.unmount();

    fakeApi('ANALYST', { '/scenarios': { body: [scenario] } });
    renderSignedIn(<ScenariosPage />);
    expect(await screen.findByText('Demand +20 %', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New scenario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });
});

describe('Reports page', () => {
  const locations = page([
    {
      id: STR1,
      code: 'STR-01',
      name: 'Riverside Store',
      type: 'STORE',
      city: 'x',
      skuCount: 1,
      totalOnHand: 1,
    },
    {
      id: STR2,
      code: 'STR-02',
      name: 'Hillcrest Store',
      type: 'STORE',
      city: 'x',
      skuCount: 1,
      totalOnHand: 1,
    },
  ]);

  it('a store manager can only choose their own store, never the whole network', async () => {
    fakeApi('STORE_MANAGER', { '/locations': { body: locations }, '/reports': { body: page([]) } });
    renderSignedIn(<ReportsPage />);
    const scope = await screen.findByLabelText('Scope');
    await within(scope).findByRole('option', { name: /STR-01/ });
    expect(
      within(scope)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['STR-01 — Riverside Store']);
  });

  it('an inventory manager can choose the network or any store', async () => {
    fakeApi('INVENTORY_MANAGER', {
      '/locations': { body: locations },
      '/reports': { body: page([]) },
    });
    renderSignedIn(<ReportsPage />);
    const scope = await screen.findByLabelText('Scope');
    await within(scope).findByRole('option', { name: /STR-02/ });
    expect(
      within(scope)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Whole network', 'STR-01 — Riverside Store', 'STR-02 — Hillcrest Store']);
  });
});
