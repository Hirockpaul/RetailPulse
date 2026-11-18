import { type HealthInput, runHealth, worstLevel } from './monitoring.health';

const monitoringOk = {
  status: 'SUCCEEDED' as const,
  error: null,
  dataDrift: 'STABLE',
  predictionDrift: 'STABLE',
  performance: 'OK',
  currentDays: 10,
};

const healthy: HealthInput = {
  daysBehind: 0,
  latestSucceededRunId: 'r1',
  latestRun: { status: 'SUCCEEDED', error: null },
  latestMonitoring: monitoringOk,
  monitoringCoversLatestRun: true,
  latestSucceededMonitoring: monitoringOk,
};

const check = (over: Partial<HealthInput>, key: string) =>
  runHealth({ ...healthy, ...over }).checks.find((c) => c.key === key)!;

describe('runHealth (V2 3c-2)', () => {
  it('all OK when everything is fresh, succeeded, monitored and stable', () => {
    const h = runHealth(healthy);
    expect(h.overall).toBe('OK');
    expect(h.checks.map((c) => c.level)).toEqual(['OK', 'OK', 'OK', 'OK']);
  });

  it.each([
    [0, 'OK'],
    [-1, 'OK'], // a run that already includes today's partial day is not "behind"
    [1, 'WARN'],
    [2, 'ALERT'],
    [9, 'ALERT'],
    [null, 'ALERT'],
  ] as const)('freshness: %s days behind → %s', (days, level) => {
    expect(check({ daysBehind: days }, 'FRESHNESS').level).toBe(level);
  });

  it('says how far behind, and when there is no forecast at all', () => {
    expect(check({ daysBehind: 3 }, 'FRESHNESS').message).toBe(
      'The latest forecast is 3 days behind the latest complete day of sales.',
    );
    expect(check({ daysBehind: null }, 'FRESHNESS').message).toContain('no successful forecast');
  });

  it('latest run: FAILED is an alert with its error; RUNNING is fine; none is an alert', () => {
    const failed = check({ latestRun: { status: 'FAILED', error: 'ValueError: x' } }, 'LATEST_RUN');
    expect(failed).toMatchObject({
      level: 'ALERT',
      message: expect.stringContaining('ValueError: x'),
    });
    expect(check({ latestRun: { status: 'RUNNING', error: null } }, 'LATEST_RUN').level).toBe('OK');
    expect(check({ latestRun: null }, 'LATEST_RUN').level).toBe('ALERT');
  });

  it('monitoring: none yet → WARN; failed → ALERT; missed the latest run → WARN', () => {
    expect(check({ latestMonitoring: null }, 'MONITORING').level).toBe('WARN');
    expect(
      check(
        { latestMonitoring: { ...monitoringOk, status: 'FAILED', error: 'boom' } },
        'MONITORING',
      ),
    ).toMatchObject({ level: 'ALERT', message: expect.stringContaining('boom') });
    expect(check({ monitoringCoversLatestRun: false }, 'MONITORING').level).toBe('WARN');
  });

  it.each([
    [{ dataDrift: 'DRIFT' }, 'ALERT'],
    [{ predictionDrift: 'DRIFT' }, 'ALERT'],
    [{ performance: 'DEGRADED' }, 'ALERT'],
    [{ dataDrift: 'WATCH' }, 'WARN'],
    [{ predictionDrift: 'WATCH' }, 'WARN'],
    [{ performance: 'INSUFFICIENT_DATA' }, 'OK'],
  ])('model quality %o → %s', (over, level) => {
    const m = { ...monitoringOk, ...over };
    expect(check({ latestSucceededMonitoring: m }, 'MODEL_QUALITY').level).toBe(level);
  });

  it('insufficient data is OK but never presented as evidence of health', () => {
    const m = {
      ...monitoringOk,
      dataDrift: 'INSUFFICIENT_DATA',
      predictionDrift: 'INSUFFICIENT_DATA',
      performance: 'INSUFFICIENT_DATA',
      currentDays: 0,
    };
    expect(check({ latestSucceededMonitoring: m }, 'MODEL_QUALITY')).toEqual({
      key: 'MODEL_QUALITY',
      level: 'OK',
      message: 'Not enough new days to judge yet (0 since training; 7 needed).',
    });
    expect(check({ latestSucceededMonitoring: null }, 'MODEL_QUALITY').message).toContain(
      'Not judged yet',
    );
  });

  it('names every problem found, and the overall level is the worst check', () => {
    const m = { ...monitoringOk, dataDrift: 'DRIFT', performance: 'DEGRADED' };
    expect(check({ latestSucceededMonitoring: m }, 'MODEL_QUALITY').message).toBe(
      'The data has drifted; accuracy on new days is degraded.',
    );
    expect(runHealth({ ...healthy, daysBehind: 1 }).overall).toBe('WARN');
    expect(worstLevel(['OK', 'ALERT', 'WARN'])).toBe('ALERT');
    expect(worstLevel([])).toBe('OK');
  });
});
