import { inkOn } from './theme';
import { useTooltip } from './useTooltip';

export interface Segment {
  key: string;
  label: string;
  color: string;
}

export interface SegmentedRow {
  id: string;
  label: string;
  values: Record<string, number>;
}

/**
 * Tall segmented bars (28 px): one whole per row, split into parts in a fixed order, 2 px surface
 * gaps, a count printed inside a part only when it is wide enough (else hover / focus / table).
 */
export function SegmentedBars({
  rows,
  segments,
  describe,
}: {
  rows: SegmentedRow[];
  segments: Segment[];
  describe: (row: SegmentedRow, segment: Segment, value: number, share: number) => string;
}) {
  const tip = useTooltip();
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const total = segments.reduce((n, s) => n + (row.values[s.key] ?? 0), 0);
        return (
          <div key={row.id} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-slate-600">{row.label}</span>
            <div className="flex h-7 min-w-0 flex-1 gap-[2px]">
              {segments.map((s) => {
                const value = row.values[s.key] ?? 0;
                if (value <= 0 || total === 0) return null;
                const share = value / total;
                const text = describe(row, s, value, share);
                return (
                  <div
                    key={s.key}
                    role="img"
                    tabIndex={0}
                    aria-label={text}
                    className="flex items-center overflow-visible rounded px-1 text-xs font-medium outline-offset-2 hover:brightness-110 focus:outline-2 focus:outline-sky-500"
                    style={{
                      width: `${share * 100}%`,
                      backgroundColor: s.color,
                      color: inkOn(s.color),
                    }}
                    onPointerMove={(e) => tip.showAt(e.clientX, e.clientY, text)}
                    onPointerLeave={tip.hide}
                    onFocus={(e) => tip.showFor(e.currentTarget, text)}
                    onBlur={tip.hide}
                  >
                    {share >= 0.09 ? value : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {tip.layer}
    </div>
  );
}
