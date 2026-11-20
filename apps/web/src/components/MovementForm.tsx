import { type FormEvent, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { listLocations } from '../api/locations';
import {
  createReservation,
  recordAdjustment,
  recordReceipt,
  recordReturn,
  recordSale,
} from '../api/movements';
import { useUser } from '../lib/auth';
import { canAccessLocation } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';
import { field } from './table';

type Action = 'SELL' | 'RECEIVE' | 'RETURN_SELLABLE' | 'RETURN_DAMAGED' | 'ADJUST' | 'RESERVE';

const ACTIONS: { value: Action; label: string; hint: string }[] = [
  { value: 'SELL', label: 'Sell (simulated POS)', hint: 'Stores only. Lowers on hand.' },
  { value: 'RECEIVE', label: 'Receive stock', hint: 'Adds to on hand.' },
  { value: 'RETURN_SELLABLE', label: 'Return — sellable', hint: 'Goes back on the shelf.' },
  { value: 'RETURN_DAMAGED', label: 'Return — damaged', hint: 'Logged, but not restocked.' },
  { value: 'ADJUST', label: 'Adjust (correction)', hint: 'Signed change; a reason is required.' },
  { value: 'RESERVE', label: 'Reserve', hint: 'Lowers available, keeps on hand.' },
];

type Result =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string };

/**
 * Records one stock movement for the product. Every submit sends an Idempotency-Key; the key is
 * kept while the inputs are unchanged (so a retry after a network error cannot apply twice) and
 * replaced as soon as the user edits anything or the request succeeds.
 */
export function MovementForm({ productId, onDone }: { productId: string; onDone: () => void }) {
  const locations = useAsync(listLocations);
  const [action, setAction] = useState<Action>('SELL');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const key = useRef(crypto.randomUUID());

  const touch = () => {
    key.current = crypto.randomUUID();
    setResult({ kind: 'idle' });
  };

  const user = useUser();
  // Store managers may only act in their own stores (the API enforces this too).
  const allowed = (locations.status === 'success' ? locations.data.data : []).filter((l) =>
    canAccessLocation(user, l.id),
  );
  const options = action === 'SELL' ? allowed.filter((l) => l.type === 'STORE') : allowed;
  const selected = options.find((l) => l.id === locationId) ?? options[0];
  const meta = ACTIONS.find((a) => a.value === action)!;
  const isAdjust = action === 'ADJUST';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty === 0 || (!isAdjust && qty < 1)) {
      setResult({
        kind: 'error',
        text: isAdjust
          ? 'Enter a whole number other than 0.'
          : 'Enter a whole number of 1 or more.',
      });
      return;
    }
    if (isAdjust && note.trim().length < 3) {
      setResult({ kind: 'error', text: 'An adjustment needs a reason (at least 3 characters).' });
      return;
    }

    const k = { idempotencyKey: key.current };
    const text = note.trim() || undefined;
    const base = { locationId: selected.id, productId };
    setResult({ kind: 'busy' });
    try {
      let summary: string;
      switch (action) {
        case 'SELL': {
          const o = await recordSale(
            { locationId: selected.id, lines: [{ productId, quantity: qty }] },
            k,
          );
          summary = `Sold ${qty} at ${selected.code} (order total ${o.totalAmount}).`;
          break;
        }
        case 'RECEIVE': {
          const r = await recordReceipt(
            { locationId: selected.id, reference: text, lines: [{ productId, quantity: qty }] },
            k,
          );
          summary = `Received ${qty} at ${selected.code}; on hand is now ${r.data[0].onHandAfter}.`;
          break;
        }
        case 'RETURN_SELLABLE':
        case 'RETURN_DAMAGED': {
          const r = await recordReturn(
            {
              ...base,
              quantity: qty,
              condition: action === 'RETURN_SELLABLE' ? 'SELLABLE' : 'DAMAGED',
              reason: text,
            },
            k,
          );
          summary = `Return recorded at ${selected.code}; on hand is now ${r.data[0].onHandAfter}.`;
          break;
        }
        case 'ADJUST': {
          const r = await recordAdjustment({ ...base, delta: qty, reason: note.trim() }, k);
          summary = `Adjusted ${qty > 0 ? '+' : ''}${qty} at ${selected.code}; on hand is now ${r.data[0].onHandAfter}.`;
          break;
        }
        case 'RESERVE': {
          await createReservation({ ...base, quantity: qty, reference: text }, k);
          summary = `Reserved ${qty} at ${selected.code}.`;
          break;
        }
      }
      key.current = crypto.randomUUID();
      setResult({ kind: 'ok', text: summary });
      onDone();
    } catch (err) {
      setResult({
        kind: 'error',
        text:
          err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'
            ? `Not enough available stock at ${selected.code} for that quantity.`
            : err instanceof ApiError
              ? err.message
              : 'Unexpected error.',
      });
    }
  };

  return (
    <section aria-labelledby="movement-heading" className="space-y-2">
      <h3 id="movement-heading" className="font-semibold">
        Record a stock movement
      </h3>
      <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-slate-500">
            Action
            <select
              className={field}
              value={action}
              onChange={(e) => {
                setAction(e.target.value as Action);
                setLocationId('');
                touch();
              }}
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-slate-500">
            Location
            <select
              className={field}
              value={selected?.id ?? ''}
              disabled={options.length === 0}
              onChange={(e) => {
                setLocationId(e.target.value);
                touch();
              }}
            >
              {options.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-slate-500">
            {isAdjust ? 'Change (+/−)' : 'Quantity'}
            <input
              className={`${field} w-24`}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                touch();
              }}
            />
          </label>

          <label className="flex min-w-48 flex-1 flex-col text-xs text-slate-500">
            {isAdjust ? 'Reason (required)' : 'Reference / note (optional)'}
            <input
              className={field}
              maxLength={200}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                touch();
              }}
            />
          </label>

          <button
            type="submit"
            disabled={result.kind === 'busy' || !selected}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
          >
            {result.kind === 'busy' ? 'Saving…' : 'Record'}
          </button>
        </div>

        <p className="text-xs text-slate-500">{meta.hint} Synthetic demo data.</p>
        {result.kind === 'ok' && (
          <p role="status" className="text-sm text-emerald-700">
            {result.text}
          </p>
        )}
        {result.kind === 'error' && (
          <p role="alert" className="text-sm text-red-700">
            {result.text}
          </p>
        )}
      </form>
    </section>
  );
}
