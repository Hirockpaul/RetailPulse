import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import {
  type BatchSummary,
  createScenario,
  listScenarios,
  runScenario,
  type Scenario,
} from '../api/scenarios';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatInt } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';

const MAX_COMPARE = 3;
const money = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number, fmt: (x: number) => string = formatInt) =>
  n === 0 ? '±0' : `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;

/** "Demand +20 %, suppliers +5 days, DC stock −50 %" — or "No change". */
export function describeParameters(
  s: Pick<Scenario, 'demandPct' | 'supplierLeadTimeDays' | 'dcAvailabilityPct'>,
) {
  const parts: string[] = [];
  if (s.demandPct !== 0)
    parts.push(`demand ${s.demandPct > 0 ? '+' : '−'}${Math.abs(s.demandPct)} %`);
  if (s.supplierLeadTimeDays !== 0) parts.push(`suppliers +${s.supplierLeadTimeDays} days`);
  if (s.dcAvailabilityPct !== 0) parts.push(`DC stock −${s.dcAvailabilityPct} %`);
  if (parts.length === 0) return 'No change';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The metrics compared, in reading order. */
const METRICS: { label: string; get: (s: BatchSummary) => number; money?: boolean }[] = [
  { label: 'Recommendations', get: (s) => s.recommendations },
  { label: '· critical', get: (s) => s.byRisk.CRITICAL },
  { label: '· flagged for review', get: (s) => s.flaggedForReview },
  { label: 'Transfers', get: (s) => s.byAction.TRANSFER },
  { label: '· from a distribution centre', get: (s) => s.transfersFromDc },
  { label: '· from another store’s excess', get: (s) => s.fromStoreExcess },
  { label: 'Transfer units', get: (s) => s.units.TRANSFER },
  { label: 'Purchase orders', get: (s) => s.byAction.PURCHASE_ORDER },
  { label: 'Purchase-order units', get: (s) => s.units.PURCHASE_ORDER },
  { label: 'Purchase-order value at cost', get: (s) => s.purchaseOrderValueAtCost, money: true },
  { label: 'Excess moves to a DC', get: (s) => s.byAction.REDISTRIBUTE_EXCESS },
  { label: 'Out of stock now', get: (s) => s.outOfStockNow },
  { label: 'Run out within 7 days', get: (s) => s.stockoutWithin7 },
  { label: 'Run out within 14 days', get: (s) => s.stockoutWithin14 },
];

/** What-if scenarios (V2 4b-2): create, run, and compare up to three side by side. */
export function ScenariosPage() {
  const user = useUser();
  const list = useAsync(listScenarios);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayRun = canApprove(user);

  const runIds = async (ids: string[]) => {
    setError(null);
    try {
      for (const id of ids) {
        setBusy(id);
        await runScenario(id);
      }
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_COMPARE ? [...s, id] : s,
    );

  const scenarios = list.status === 'success' ? list.data : [];
  const chosen = selected
    .map((id) => scenarios.find((s) => s.id === id))
    .filter((s): s is Scenario => s !== undefined);

  return (
    <section aria-labelledby="scenarios-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="scenarios-heading" className="text-xl font-semibold">
          What-if scenarios
        </h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Change demand, supplier lead times or distribution-centre stock and see what the
          replenishment calculation would suggest — the same calculation as real recommendations,
          run in memory. A scenario never creates a recommendation, transfer or order and never
          moves stock. Totals only (not per product), with stock as it was when the scenario ran; a
          change the calculation does not use (for example longer supplier lead times when
          distribution centres cover every need) shows no effect. Synthetic data.
        </p>
      </div>

      {mayRun && <CreateForm onCreated={list.reload} />}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {list.status === 'loading' && <Loading />}
      {list.status === 'error' && <ErrorMessage message={list.error} onRetry={list.reload} />}
      {list.status === 'success' && scenarios.length === 0 && (
        <Empty>No scenarios yet{mayRun ? ': create one above.' : '.'}</Empty>
      )}
      {list.status === 'success' && scenarios.length > 0 && (
        <section aria-labelledby="list-heading" className="space-y-2">
          <h3 id="list-heading" className="font-semibold">
            Scenarios
          </h3>
          <p className="text-xs text-slate-500">
            Tick up to {MAX_COMPARE} to compare them below ({selected.length} selected).
          </p>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>
                    <span className="sr-only">Compare</span>
                  </th>
                  <th className={table.th}>Scenario</th>
                  <th className={table.thNum}>Recommendations</th>
                  <th className={table.thNum}>Order value at cost</th>
                  <th className={table.thNum}>Run out ≤ 7 days</th>
                  <th className={table.th}>Latest run</th>
                  {mayRun && (
                    <th className={table.th}>
                      <span className="sr-only">Run</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => {
                  const r = s.latestResult;
                  const checked = selected.includes(s.id);
                  const full = !checked && selected.length >= MAX_COMPARE;
                  return (
                    <tr key={s.id} className={table.row}>
                      <td className={table.td}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={full || !r}
                          onChange={() => toggle(s.id)}
                          aria-label={`Compare ${s.name}`}
                          title={!r ? 'Run it first' : full ? `At most ${MAX_COMPARE}` : undefined}
                        />
                      </td>
                      <td className={table.td}>
                        <span className="font-medium">{s.name}</span>
                        <span className="block text-xs text-slate-500">
                          {describeParameters(s)} · by {s.createdBy}
                        </span>
                        {s.description && (
                          <span className="block text-xs text-slate-500">{s.description}</span>
                        )}
                      </td>
                      <td className={table.tdNum}>
                        {r ? (
                          <>
                            {formatInt(r.result.recommendations)}{' '}
                            <span className="text-xs text-slate-500">
                              ({signed(r.result.recommendations - r.baseline.recommendations)})
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={table.tdNum}>
                        {r ? (
                          <>
                            {money(r.result.purchaseOrderValueAtCost)}{' '}
                            <span className="text-xs text-slate-500">
                              (
                              {signed(
                                r.result.purchaseOrderValueAtCost -
                                  r.baseline.purchaseOrderValueAtCost,
                                money,
                              )}
                              )
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={table.tdNum}>
                        {r ? (
                          <>
                            {formatInt(r.result.stockoutWithin7)}{' '}
                            <span className="text-xs text-slate-500">
                              ({signed(r.result.stockoutWithin7 - r.baseline.stockoutWithin7)})
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={table.td}>
                        {r ? (
                          formatDateTime(r.runAt)
                        ) : (
                          <span className="text-slate-500">never run</span>
                        )}
                      </td>
                      {mayRun && (
                        <td className={table.td}>
                          <button
                            type="button"
                            onClick={() => runIds([s.id])}
                            disabled={busy !== null}
                            className="rounded border px-3 py-1 text-sm enabled:hover:bg-slate-100 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                          >
                            {busy === s.id ? 'Running…' : 'Run'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Numbers in brackets: change against the same calculation without the scenario’s changes,
            computed at the same moment.
          </p>
        </section>
      )}

      {chosen.length > 0 && (
        <Comparison
          scenarios={chosen}
          onRunAll={mayRun ? () => runIds(chosen.map((s) => s.id)) : undefined}
          busy={busy !== null}
        />
      )}
    </section>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [demandPct, setDemandPct] = useState('0');
  const [leadDays, setLeadDays] = useState('0');
  const [dcPct, setDcPct] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createScenario({
        name: name.trim(),
        description: description.trim() || undefined,
        demandPct: Number(demandPct),
        supplierLeadTimeDays: Number(leadDays),
        dcAvailabilityPct: Number(dcPct),
      });
      setName('');
      setDescription('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const number = (
    label: string,
    value: string,
    set: (v: string) => void,
    min: number,
    max: number,
    hint: string,
  ) => (
    <label className="flex flex-col text-xs text-slate-500">
      {label}
      <input
        className={`${field} w-28`}
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        required
        value={value}
        onChange={(e) => set(e.target.value)}
      />
      <span className="mt-0.5">{hint}</span>
    </label>
  );

  return (
    <form
      onSubmit={submit}
      aria-labelledby="create-heading"
      className="space-y-3 rounded-lg border bg-white p-4"
    >
      <h3 id="create-heading" className="font-semibold">
        New scenario
      </h3>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-0 flex-1 flex-col text-xs text-slate-500">
          Name
          <input
            className={field}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Holiday rush"
          />
        </label>
        <label className="flex min-w-0 flex-[2] flex-col text-xs text-slate-500">
          Description (optional)
          <input
            className={field}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {number('Demand change (%)', demandPct, setDemandPct, -50, 200, '−50 to +200')}
        {number('Extra supplier lead time (days)', leadDays, setLeadDays, 0, 30, '0 to 30')}
        {number('DC stock unavailable (%)', dcPct, setDcPct, 0, 100, '0 to 100')}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
      >
        {busy ? 'Saving…' : 'Save scenario'}
      </button>
      <p className="text-xs text-slate-500">
        Scenarios are never edited: a different idea is a new scenario, so every stored result keeps
        the parameters it was computed with.
      </p>
    </form>
  );
}

function Comparison({
  scenarios,
  onRunAll,
  busy,
}: {
  scenarios: Scenario[];
  onRunAll?: () => void;
  busy: boolean;
}) {
  const results = scenarios.map((s) => s.latestResult!);
  const first = results[0];
  // One baseline column only when every result came from the same forecast and the same stock.
  const sameBaseline = results.every(
    (r) =>
      r.forecastRunId === first.forecastRunId &&
      JSON.stringify(r.baseline) === JSON.stringify(first.baseline),
  );
  return (
    <section aria-labelledby="compare-heading" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="compare-heading" className="font-semibold">
          Comparison
        </h3>
        {onRunAll && (
          <button
            type="button"
            onClick={onRunAll}
            disabled={busy}
            className="rounded border px-3 py-1 text-sm enabled:hover:bg-slate-100 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
          >
            {busy ? 'Running…' : 'Run selected now'}
          </button>
        )}
      </div>
      {!sameBaseline && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          These results were computed at different moments (different stock or forecast), so each
          change is shown against that scenario’s own baseline. Use “Run selected now” to bring them
          together.
        </p>
      )}
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.thead}>
            <tr>
              <th className={table.th}>Metric</th>
              {sameBaseline && <th className={table.thNum}>Baseline</th>}
              {scenarios.map((s) => (
                <th key={s.id} className={table.thNum}>
                  {s.name}
                  <span className="block font-normal normal-case text-slate-500">
                    {describeParameters(s)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const fmt = m.money ? money : formatInt;
              return (
                <tr key={m.label} className={table.row}>
                  <td className={table.td}>{m.label}</td>
                  {sameBaseline && <td className={table.tdNum}>{fmt(m.get(first.baseline))}</td>}
                  {results.map((r) => {
                    const delta = m.get(r.result) - m.get(r.baseline);
                    return (
                      <td key={r.id} className={table.tdNum}>
                        {fmt(m.get(r.result))}{' '}
                        <span className="text-xs text-slate-500">({signed(delta, fmt)})</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {sameBaseline
          ? `Computed from forecast data up to ${first.forecastHistoryEnd ?? '—'}; changes in brackets are against the baseline.`
          : 'Changes in brackets are against each scenario’s own baseline.'}{' '}
        Positions: {formatInt(first.baseline.positions)} product × store pairs.
      </p>
    </section>
  );
}
