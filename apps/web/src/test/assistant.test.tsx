import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssistantPage } from '../pages/AssistantPage';
import { fakeApi, renderSignedIn } from './render';

describe('read-only assistant', () => {
  it('sends one question and shows provider, claims and permission-checked tools', async () => {
    const spy = fakeApi('STORE_MANAGER', {
      '/assistant/ask': {
        body: {
          source: 'ai',
          provider: 'nvidia',
          toolsUsed: ['get_control_tower', 'get_open_anomalies'],
          claims: [{ type: 'fact', text: 'One high-severity finding needs attention.' }],
        },
      },
    });
    renderSignedIn(<AssistantPage />);

    await userEvent.type(await screen.findByLabelText('Question'), 'What needs attention?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));

    expect(await screen.findByText('AI answer (NVIDIA)')).toBeInTheDocument();
    expect(screen.getByText(/One high-severity finding/)).toBeInTheDocument();
    expect(screen.getByText(/Control Tower, open unusual activity/)).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).includes('/assistant/ask'));
    expect(call?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ question: 'What needs attention?' });
  });
});
