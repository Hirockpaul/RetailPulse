import { CHART } from './theme';
import { useTooltip } from './useTooltip';

export interface HBar {
  id: string;
  label: string;
  value: number;
  /** Printed at the bar's tip. */
  valueText: string;
  /** Optional plain-text note after the value (e.g. "below the 75 threshold"). */
  note?: string;
}

/**
 * Horizontal bars, one series: ≤ 16 px thick, square at the baseline, 4 px rounded data-end,
 * value at the tip. Hover and focus repeat the value with the label.
 */
export function HBarChart({
  bars,
  max,
  labelWidth = 'w-24',
}: {
  bars: HBar[];
  max?: number;
  /** Tailwind width class for the label column; labels wrap, never clip. */
  labelWidth?: string;
}) {
  const tip = useTooltip();
  const top = Math.max(max ?? 0, ...bars.map((b) => b.value), 1e-9);
  return (
    <div className="space-y-2">
      {bars.map((b) => {
        const text = `${b.label}: ${b.valueText}${b.note ? ` — ${b.note}` : ''}`;
        return (
          <div key={b.id} className="flex items-center gap-3">
            <span className={`${labelWidth} shrink-0 text-xs leading-tight text-slate-600`}>
              {b.label}
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div
                role="img"
                tabIndex={0}
                aria-label={text}
                className="h-4 shrink-0 rounded-r outline-offset-2 hover:brightness-110 focus:outline-2 focus:outline-sky-500"
                style={{
                  width: `calc(${(Math.max(b.value, 0) / top) * 100}% * 0.7)`,
                  minWidth: b.value > 0 ? 2 : 0,
                  backgroundColor: CHART.series1,
                }}
                onPointerMove={(e) => tip.showAt(e.clientX, e.clientY, text)}
                onPointerLeave={tip.hide}
                onFocus={(e) => tip.showFor(e.currentTarget, text)}
                onBlur={tip.hide}
              />
              <span className="shrink-0 text-xs tabular-nums text-slate-800">{b.valueText}</span>
              {b.note && (
                <span className="min-w-0 text-xs leading-tight text-slate-500">{b.note}</span>
              )}
            </div>
          </div>
        );
      })}
      {tip.layer}
    </div>
  );
}
