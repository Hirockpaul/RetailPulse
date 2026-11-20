import { type FormEvent, useRef, useState } from 'react';
import { listProducts, type ProductSummary } from '../api/catalog';
import { ApiError } from '../api/client';
import { listLocations } from '../api/locations';
import { createTransfer } from '../api/transfers';
import { useUser } from '../lib/auth';
import { canAccessLocation, isStoreScoped } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';
import { field } from './table';

interface Line {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
}

/**
 * Request a stock transfer. Nothing moves until it is approved and dispatched.
 * Store managers can only request transfers into their own store (the API enforces this too).
 */
export function TransferForm({ onCreated }: { onCreated: (id: string) => void }) {
  const user = useUser();
  const locations = useAsync(listLocations);
  const all = locations.status === 'success' ? locations.data.data : [];

  const [sourceId, setSourceId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ProductSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());

  const destinations = all.filter((l) => canAccessLocation(user, l.id));
  const destination = destinations.find((l) => l.id === destinationId) ?? destinations[0];
  const sources = all.filter((l) => l.id !== destination?.id);
  const source = sources.find((l) => l.id === sourceId) ?? sources[0];

  // Any edit means a different request, so it gets a new idempotency key.
  const touch = () => {
    key.current = crypto.randomUUID();
    setError(null);
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      setMatches((await listProducts({ q: query.trim(), pageSize: 8 })).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    }
  };

  const addLine = (p: ProductSummary) => {
    if (lines.some((l) => l.productId === p.id)) return;
    setLines([
      ...lines,
      { productId: p.id, sku: p.sku, name: p.name, quantity: String(p.packSize) },
    ]);
    touch();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!source || !destination) return;
    const parsed = lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    if (parsed.length === 0) return setError('Add at least one product.');
    if (parsed.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1)) {
      return setError('Every quantity must be a whole number of 1 or more.');
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createTransfer(
        {
          sourceLocationId: source.id,
          destinationLocationId: destination.id,
          notes: notes.trim() || undefined,
          lines: parsed,
        },
        key.current,
      );
      key.current = crypto.randomUUID();
      setLines([]);
      setNotes('');
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="transfer-form-heading" className="space-y-2">
      <h3 id="transfer-form-heading" className="font-semibold">
        Request a transfer
      </h3>
      <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 max-w-full flex-col text-xs text-slate-500">
            From
            <select
              className={field}
              value={source?.id ?? ''}
              onChange={(e) => {
                setSourceId(e.target.value);
                touch();
              }}
            >
              {sources.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col text-xs text-slate-500">
            To {isStoreScoped(user) && '(your store)'}
            <select
              className={field}
              value={destination?.id ?? ''}
              onChange={(e) => {
                setDestinationId(e.target.value);
                touch();
              }}
            >
              {destinations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col text-xs text-slate-500">
            Note (optional)
            <input
              className={field}
              maxLength={200}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                touch();
              }}
            />
          </label>
        </div>

        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-slate-500">
              Find a product to add
              <input
                className={`${field} w-64`}
                placeholder="SKU or name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search(e)}
              />
            </label>
            <button type="button" onClick={search} className={`${field} hover:bg-slate-100`}>
              Search
            </button>
          </div>
          {matches && (
            <ul className="divide-y rounded border text-sm">
              {matches.length === 0 && <li className="px-3 py-2 text-slate-500">No matches.</li>}
              {matches.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span>
                    <span className="font-medium">{p.sku}</span> {p.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => addLine(p)}
                    disabled={lines.some((l) => l.productId === p.id)}
                    className="rounded border px-2 py-0.5 text-xs enabled:hover:bg-slate-100 disabled:opacity-40"
                  >
                    {lines.some((l) => l.productId === p.id) ? 'Added' : 'Add'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <ul className="space-y-1 text-sm">
              {lines.map((l) => (
                <li key={l.productId} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{l.sku}</span> {l.name}
                  </span>
                  <label className="flex items-center gap-1 text-xs text-slate-500">
                    Qty
                    <input
                      className={`${field} w-20`}
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => {
                        setLines(
                          lines.map((x) =>
                            x.productId === l.productId ? { ...x, quantity: e.target.value } : x,
                          ),
                        );
                        touch();
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setLines(lines.filter((x) => x.productId !== l.productId));
                      touch();
                    }}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !source || !destination}
          className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
        >
          {busy ? 'Requesting…' : 'Request transfer'}
        </button>
      </form>
    </section>
  );
}
