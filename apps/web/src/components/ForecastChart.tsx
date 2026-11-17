import { formatDay } from '../lib/format';

interface Props {
  history: { day: string; units: number }[];
  points: {
    day: string;
    yhat: number;
    lower: number;
    upper: number;
    lower95?: number | null;
    upper95?: number | null;
  }[];
}

const W = 720;
const H = 230;
const PAD = { left: 40, right: 12, top: 12, bottom: 28 };

/**
 * Plain-SVG chart: recent daily sales (grey) and the forecast (blue) with its 80% range, and the
 * 95% range in a lighter shade when the run has one.
 */
export function ForecastChart({ history, points }: Props) {
  const days = [...history.map((h) => h.day), ...points.map((p) => p.day)];
  if (days.length < 2) return null;
  const has95 = points.length > 0 && points.every((p) => p.lower95 != null && p.upper95 != null);
  const max = Math.max(
    1,
    ...history.map((h) => h.units),
    ...points.map((p) => (has95 ? (p.upper95 as number) : p.upper)),
  );
  const top = Math.ceil(max / 5) * 5;
  const x = (i: number) => PAD.left + (i / (days.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const offset = history.length;

  const line = (values: number[], start: number) =>
    values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(start + i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');
  const bandPath = (upper: number[], lower: number[]) =>
    upper.length > 0
      ? `${upper.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(offset + i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ` +
        [...lower]
          .reverse()
          .map((v, i) => `L${x(offset + lower.length - 1 - i).toFixed(1)},${y(v).toFixed(1)}`)
          .join(' ') +
        ' Z'
      : '';
  const band = bandPath(
    points.map((p) => p.upper),
    points.map((p) => p.lower),
  );
  const band95 = has95
    ? bandPath(
        points.map((p) => p.upper95 as number),
        points.map((p) => p.lower95 as number),
      )
    : '';
  const ticks = [0, Math.round(top / 2), top];
  const labelAt = [0, Math.floor((days.length - 1) / 2), days.length - 1];

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Daily sales for the last ${history.length} days and the forecast for the next ${points.length} days`}
        className="w-full"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#64748b">
              {t}
            </text>
          </g>
        ))}
        {points.length > 0 && (
          <line
            x1={x(offset - 0.5)}
            x2={x(offset - 0.5)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="#94a3b8"
            strokeDasharray="4 3"
          />
        )}
        {band95 && <path d={band95} fill="#e0f2fe" opacity="0.9" />}
        {band && <path d={band} fill="#bae6fd" opacity="0.8" />}
        <path
          d={line(
            history.map((h) => h.units),
            0,
          )}
          fill="none"
          stroke="#64748b"
          strokeWidth="1.5"
        />
        {points.length > 0 && (
          <path
            d={line(
              points.map((p) => p.yhat),
              offset,
            )}
            fill="none"
            stroke="#0369a1"
            strokeWidth="2"
          />
        )}
        {labelAt.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            fontSize="11"
            fill="#64748b"
          >
            {formatDay(days[i])}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-slate-500">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-slate-500 align-middle" />
          units sold per day
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-sky-700 align-middle" />
          forecast
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-4 bg-sky-200 align-middle" />
          80% range
        </span>
        {has95 && (
          <span>
            <span className="mr-1 inline-block h-2 w-4 bg-sky-100 align-middle" />
            95% range
          </span>
        )}
      </figcaption>
    </figure>
  );
}
