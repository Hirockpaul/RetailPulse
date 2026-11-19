/** Loading, empty and error states (V2 6-1, D5): shared components and one real page. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { ScenariosPage } from '../pages/ScenariosPage';
import { fakeApi, renderSignedIn } from './render';

describe('shared status components', () => {
  it('loading is announced as a status', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('an error is an alert, and Retry calls back', async () => {
    const retry = vi.fn();
    render(<ErrorMessage message="Cannot reach the API." onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the API.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('an error without a retry offers none', () => {
    render(<ErrorMessage message="Not found." />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('empty shows its message', () => {
    render(<Empty>Nothing here yet.</Empty>);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});

describe('a page through its states (Scenarios)', () => {
  it('loading while the list is on its way', async () => {
    fakeApi('ANALYST', { '/scenarios': 'pending' });
    renderSignedIn(<ScenariosPage />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
  });

  it('empty when there are none, with a hint only for those who may create', async () => {
    fakeApi('ANALYST', { '/scenarios': { body: [] } });
    const first = renderSignedIn(<ScenariosPage />);
    expect(await screen.findByText('No scenarios yet.')).toBeInTheDocument();
    first.unmount();
    fakeApi('INVENTORY_MANAGER', { '/scenarios': { body: [] } });
    renderSignedIn(<ScenariosPage />);
    expect(await screen.findByText('No scenarios yet: create one above.')).toBeInTheDocument();
  });

  it('an API error shows the server message, and Retry asks again', async () => {
    let calls = 0;
    const spy = fakeApi('ANALYST', {
      '/scenarios': () =>
        ++calls === 1
          ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong.' } } }
          : { body: [] },
    });
    renderSignedIn(<ScenariosPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No scenarios yet.')).toBeInTheDocument();
    expect(spy.mock.calls.filter(([u]) => String(u).includes('/scenarios')).length).toBe(2);
  });
});
