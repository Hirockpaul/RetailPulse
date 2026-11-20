import { type KeyboardEvent, type PointerEvent, useCallback, useState } from 'react';
import type { DayUnits } from '../../api/overview';
import { formatDay, formatInt } from '../../lib/format';
import { CHART } from './theme';

/** Drawing width before the first measurement (and in tests, where nothing has a size). */
const DEFAULT_W = 480;
const H = 220;
const PAD = { left: 44, right: 58, top: 12, bottom: 26 };

/** Round the axis top up to a clean step (1, 2 or 5 × a power of ten). */
function niceTop(max: number): { top: number; step: number } {
  const raw = Math.max(max, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return { top: Math.ceil(Math.max(max, 1) / step) * step, step };
}

const tick = (v: number, top: number) =>
  top >= 10_000 ? `${(v / 1000).toLocaleString()}K` : formatInt(v);

/**
 * Units sold per day (series 1) followed by the forecast (series 2) on one y-axis.
 * A crosshair snaps to the nearest day; arrow keys move it when the chart has focus.
 */
export function SalesLineChart({
  history,
  forecast,
}: {
  history: DayUnits[];
  forecast: DayUnits[];
}) {
  const days = [...history, ...forecast];
  const [active, setActive] = useState<number | null>(null);
  // Drawn at its real width, so text stays 11 px instead of growing with a wide card.
  const [W, setW] = useState(DEFAULT_W);
  const measure = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (days.length < 2) return null;

  const { top, step } = niceTop(Math.max(...days.map((d) => d.units)));
  const plotW = W - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (i / (days.length - 1)) * plotW;
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const path = (pts: DayUnits[], start: number) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(start + i).toFixed(1)},${y(p.units).toFixed(1)}`)
      .join(' ');
  // The forecast line starts from the last sold day so the two read as one continuous story.
  const forecastPath =
    forecast.length > 0
      ? path(
          history.length ? [history[history.length - 1], ...forecast] : forecast,
          Math.max(history.length - 1, 0),
        )
      : '';
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const xLabels = [0, history.length - 1, days.length - 1].filter(
    (v, i, a) => v >= 0 && a.indexOf(v) === i,
  );

  const nearest = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    return Math.min(
      days.length - 1,
      Math.max(0, Math.round(((sx - PAD.left) / plotW) * (days.length - 1))),
    );
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setActive((a) =>
        Math.min(days.length - 1, Math.max(0, (a ?? (d > 0 ? -1 : days.length)) + d)),
      );
    } else if (e.key === 'Escape') setActive(null);
  };

  const isForecast = (i: number) => i >= history.length;
  const readout =
    active === null
      ? null
      : `${formatDay(days[active].day)} · ${isForecast(active) ? 'forecast' : 'sold'} ${formatInt(Math.round(days[active].units))} units`;
  const lastH = history[history.length - 1];
  const lastF = forecast[forecast.length - 1];

  return (
    <figure ref={measure} className="space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded outline-offset-2 focus:outline-2 focus:outline-sky-500"
        role="img"
        tabIndex={0}
        aria-label={`Units sold per day for ${history.length} days and forecast for ${forecast.length} days. Use the arrow keys to read each day.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? CHART.axis : CHART.grid}
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize="11"
              fill={CHART.inkMuted}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {tick(t, top)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            fontSize="11"
            fill={CHART.inkMuted}
          >
            {formatDay(days[i].day)}
          </text>
        ))}
        {history.length > 0 && (
          <path
            d={path(history, 0)}
            fill="none"
            stroke={CHART.series1}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {forecastPath && (
          <path
            d={forecastPath}
            fill="none"
            stroke={CHART.series2}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {/* Direct end labels, in text ink; the coloured end-dot carries identity. */}
        {lastH && (
          <g>
            <circle
              cx={x(history.length - 1)}
              cy={y(lastH.units)}
              r="4"
              fill={CHART.series1}
              stroke={CHART.surface}
              strokeWidth="2"
            />
          </g>
        )}
        {lastF && (
          <g>
            <circle
              cx={x(days.length - 1)}
              cy={y(lastF.units)}
              r="4"
              fill={CHART.series2}
              stroke={CHART.surface}
              strokeWidth="2"
            />
            <text
              x={x(days.length - 1) + 8}
              y={y(lastF.units) + 4}
              fontSize="11"
              fill={CHART.inkSecondary}
            >
              Forecast
            </text>
          </g>
        )}
        {active !== null && (
          <g>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke={CHART.inkMuted}
              strokeWidth="1"
            />
            <circle
              cx={x(active)}
              cy={y(days[active].units)}
              r="4"
              fill={isForecast(active) ? CHART.series2 : CHART.series1}
              stroke={CHART.surface}
              strokeWidth="2"
            />
          </g>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={H - PAD.top - PAD.bottom}
          fill="transparent"
          onPointerMove={(e) => setActive(nearest(e))}
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      <p className="h-5 text-xs text-slate-700" aria-live="polite">
        {readout ??
          (lastH
            ? `Latest day sold: ${formatInt(lastH.units)} units (${formatDay(lastH.day)}). Hover or use the arrow keys for any day.`
            : '')}
      </p>
    </figure>
  );
}
