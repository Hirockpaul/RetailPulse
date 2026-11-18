/**
 * Run health (V2 3c-2): computed on request from the latest runs, never stored, never acts.
 * Rules fixed before building: docs/V2-PLAN.md step 3c-2.
 */

export type Level = 'OK' | 'WARN' | 'ALERT';

export interface HealthCheck {
  key: 'FRESHNESS' | 'LATEST_RUN' | 'MONITORING' | 'MODEL_QUALITY';
  level: Level;
  message: string;
}

export interface HealthInput {
  /** (today − 1) − last data day of the latest successful run; null = no successful run. */
  daysBehind: number | null;
  latestSucceededRunId: string | null;
  latestRun: { status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; error: string | null } | null;
  latestMonitoring: {
    status: 'SUCCEEDED' | 'FAILED';
    error: string | null;
    dataDrift: string | null;
    predictionDrift: string | null;
    performance: string | null;
    currentDays: number;
  } | null;
  /** A monitoring run exists for (or after) the latest successful forecast run. */
  monitoringCoversLatestRun: boolean;
  /** Latest successful monitoring run (quality comes from it, even if a later one failed). */
  latestSucceededMonitoring: HealthInput['latestMonitoring'];
}

const ORDER: Level[] = ['OK', 'WARN', 'ALERT'];
export const worstLevel = (levels: Level[]): Level =>
  levels.reduce<Level>((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), 'OK');

function freshness(daysBehind: number | null): HealthCheck {
  if (daysBehind === null) {
    return { key: 'FRESHNESS', level: 'ALERT', message: 'There is no successful forecast yet.' };
  }
  if (daysBehind <= 0) {
    return {
      key: 'FRESHNESS',
      level: 'OK',
      message: 'The forecast uses data up to yesterday.',
    };
  }
  return {
    key: 'FRESHNESS',
    level: daysBehind === 1 ? 'WARN' : 'ALERT',
    message: `The latest forecast is ${daysBehind} day${daysBehind === 1 ? '' : 's'} behind the latest complete day of sales.`,
  };
}

function latestRun(run: HealthInput['latestRun']): HealthCheck {
  if (!run) return { key: 'LATEST_RUN', level: 'ALERT', message: 'No forecast has been run yet.' };
  if (run.status === 'FAILED') {
    return {
      key: 'LATEST_RUN',
      level: 'ALERT',
      message: `The latest forecast run failed: ${run.error ?? 'no error recorded'}.`,
    };
  }
  return {
    key: 'LATEST_RUN',
    level: 'OK',
    message:
      run.status === 'RUNNING'
        ? 'A forecast run is in progress.'
        : 'The latest forecast run succeeded.',
  };
}

function monitoring(i: HealthInput): HealthCheck {
  const m = i.latestMonitoring;
  if (!m) return { key: 'MONITORING', level: 'WARN', message: 'Monitoring has not run yet.' };
  if (m.status === 'FAILED') {
    return {
      key: 'MONITORING',
      level: 'ALERT',
      message: `The latest monitoring run failed: ${m.error ?? 'no error recorded'}.`,
    };
  }
  if (i.latestSucceededRunId && !i.monitoringCoversLatestRun) {
    return {
      key: 'MONITORING',
      level: 'WARN',
      message: 'The latest successful forecast run has not been monitored yet.',
    };
  }
  return { key: 'MONITORING', level: 'OK', message: 'Monitoring is up to date.' };
}

function quality(m: HealthInput['latestSucceededMonitoring']): HealthCheck {
  if (!m) {
    return { key: 'MODEL_QUALITY', level: 'OK', message: 'Not judged yet: no monitoring result.' };
  }
  const statuses = [m.dataDrift, m.predictionDrift, m.performance];
  const problems: string[] = [];
  if (m.dataDrift === 'DRIFT') problems.push('the data has drifted');
  if (m.predictionDrift === 'DRIFT') problems.push('the forecasts have drifted');
  if (m.performance === 'DEGRADED') problems.push('accuracy on new days is degraded');
  if (problems.length) {
    return { key: 'MODEL_QUALITY', level: 'ALERT', message: `${capital(problems.join('; '))}.` };
  }
  if (statuses.includes('WATCH')) {
    return {
      key: 'MODEL_QUALITY',
      level: 'WARN',
      message: 'Some distributions have moved (WATCH): worth a look, not yet drift.',
    };
  }
  if (statuses.every((s) => s === 'INSUFFICIENT_DATA')) {
    return {
      key: 'MODEL_QUALITY',
      level: 'OK',
      message: `Not enough new days to judge yet (${m.currentDays} since training; 7 needed).`,
    };
  }
  return {
    key: 'MODEL_QUALITY',
    level: 'OK',
    message: statuses.includes('INSUFFICIENT_DATA')
      ? 'No drift or degradation found; some checks still need more new days.'
      : 'No drift or degradation found.',
  };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function runHealth(i: HealthInput): { overall: Level; checks: HealthCheck[] } {
  const checks = [
    freshness(i.daysBehind),
    latestRun(i.latestRun),
    monitoring(i),
    quality(i.latestSucceededMonitoring),
  ];
  return { overall: worstLevel(checks.map((c) => c.level)), checks };
}
