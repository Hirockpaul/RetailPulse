type Tone = 'good' | 'bad' | 'warn' | 'neutral';

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-100 text-emerald-800',
  bad: 'bg-red-100 text-red-800',
  warn: 'bg-amber-100 text-amber-800',
  neutral: 'bg-slate-100 text-slate-700',
};

interface BadgeProps {
  label: string;
  /** Shorthand: ok → good, !ok → bad. */
  ok?: boolean;
  tone?: Tone;
}

export function Badge({ label, ok, tone }: BadgeProps) {
  const t: Tone = tone ?? (ok === undefined ? 'neutral' : ok ? 'good' : 'bad');
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONES[t]}`}>{label}</span>;
}

/** Stock level badge: 0 available = out, below one pack = low. */
export function StockBadge({ available, packSize }: { available: number; packSize: number }) {
  if (available <= 0) return <Badge tone="bad" label="Out" />;
  if (available < packSize) return <Badge tone="warn" label="Low" />;
  return null;
}
