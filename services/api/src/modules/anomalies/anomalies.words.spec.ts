import { validateAiAnswer } from '../../core/ai/ai.validation';
import type { AiService } from '../../core/ai/ai.service';
import type { AuthUser } from '../../core/auth/auth.types';
import type { DatabaseService } from '../../core/database/database.service';
import type { AnomaliesRepository } from './anomalies.repository';
import type { AnomalyFinding } from './anomalies.schemas';
import { AnomaliesService } from './anomalies.service';
import { anomalyWords } from './anomalies.words';

const finding: AnomalyFinding = {
  id: 'finding-1',
  source: 'SALES',
  kind: 'SPIKE',
  severity: 'HIGH',
  status: 'NEW',
  day: '2026-11-18',
  productId: 'product-1',
  sku: 'TEA-500',
  productName: 'Breakfast Tea 500g',
  locationId: 'location-1',
  locationCode: 'STR-01',
  score: 10.24,
  observed: 24,
  expected: 4.16,
  explanation: 'Raw detector explanation must not be sent.',
  details: null,
  rule: 'robust_z v1',
  foundAt: new Date('2026-11-19T08:00:00Z'),
  reviewedAt: null,
};

describe('anomalyWords', () => {
  it('builds a checked explanation from backend-selected facts without raw text', () => {
    const prepared = anomalyWords(finding);

    expect(prepared.facts).toEqual(
      expect.arrayContaining([
        { id: 'product', label: 'Product name', value: 'Breakfast Tea 500g' },
        { id: 'store', label: 'Store code', value: 'STR-01' },
        { id: 'observed', label: 'Observed value', value: 24 },
        { id: 'expected', label: 'Expected or rule-threshold value', value: 4.2 },
      ]),
    );
    expect(JSON.stringify(prepared.facts)).not.toContain(finding.explanation);
    expect(JSON.stringify(prepared.facts)).not.toContain(finding.rule);
    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'anomaly'),
    ).not.toThrow();
    expect(prepared.template.claims.map((claim) => claim.text).join(' ')).toMatch(
      /signal to investigate, not proof/i,
    );
  });

  it('uses rule-threshold language and kind-specific checks for operational findings', () => {
    const prepared = anomalyWords({
      ...finding,
      source: 'OPERATIONS',
      kind: 'LARGE_WRITE_OFF',
      observed: 30,
      expected: 20,
      score: 30,
    });
    const text = prepared.template.claims.map((claim) => claim.text).join(' ');

    expect(text).toContain("rule's comparison threshold was 20");
    expect(text).toMatch(/physical count.*damage or loss/i);
  });

  it('rejects wording that turns an anomaly signal into a certain conclusion', () => {
    const prepared = anomalyWords(finding);
    expect(() =>
      validateAiAnswer(
        JSON.stringify({
          claims: [{ type: 'fact', text: 'This definitely proves a problem with 24 units.' }],
        }),
        prepared.facts,
        'anomaly',
      ),
    ).toThrow('unsafe_language');
  });
});

describe('AnomaliesService.explainInWords', () => {
  it('checks store access and sends no identity, review, or detector text to AI', async () => {
    const repo = { find: jest.fn().mockResolvedValue(finding) };
    const ai = {
      explain: jest.fn().mockResolvedValue({
        source: 'ai',
        answer: { claims: [{ type: 'recommendation', text: 'Checked explanation.' }] },
      }),
    };
    const service = new AnomaliesService(
      repo as unknown as AnomaliesRepository,
      {} as DatabaseService,
      ai as unknown as AiService,
    );
    const user: AuthUser = {
      id: 'user-1',
      email: 'private@example.test',
      displayName: 'Private Manager',
      role: 'STORE_MANAGER',
      locationIds: ['location-1'],
    };

    await expect(
      service.explainInWords('finding-1', { user, correlationId: 'corr-1' }),
    ).resolves.toEqual({
      source: 'ai',
      claims: [{ type: 'recommendation', text: 'Checked explanation.' }],
    });

    expect(ai.explain).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        feature: 'anomaly',
        facts: expect.arrayContaining([
          { id: 'product', label: 'Product name', value: 'Breakfast Tea 500g' },
          { id: 'store', label: 'Store code', value: 'STR-01' },
        ]),
      }),
    );
    const sent = JSON.stringify(ai.explain.mock.calls[0][0].facts);
    expect(sent).not.toContain(user.email);
    expect(sent).not.toContain(user.displayName);
    expect(sent).not.toContain('corr-1');
    expect(sent).not.toContain(finding.explanation);
    expect(sent).not.toContain(finding.rule);
  });

  it('refuses an inaccessible store before calling AI', async () => {
    const repo = { find: jest.fn().mockResolvedValue(finding) };
    const ai = { explain: jest.fn() };
    const service = new AnomaliesService(
      repo as unknown as AnomaliesRepository,
      {} as DatabaseService,
      ai as unknown as AiService,
    );
    const user: AuthUser = {
      id: 'user-2',
      email: 'store2@example.test',
      displayName: 'Store 2',
      role: 'STORE_MANAGER',
      locationIds: ['location-2'],
    };

    await expect(
      service.explainInWords('finding-1', { user, correlationId: 'corr-2' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ai.explain).not.toHaveBeenCalled();
  });
});
