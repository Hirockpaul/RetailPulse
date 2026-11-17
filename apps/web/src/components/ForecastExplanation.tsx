import { useCallback } from 'react';
import { type ExplanationFactor, fetchForecastExplanation } from '../api/forecasts';
import { formatDay, formatDecimal } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { ErrorMessage, Loading } from './Status';

const SHOWN = 5;

const NOT_EXPLAINED: Record<string, string> = {
  NOT_ML:
    'This forecast comes from a simple method (the machine-learning model did not beat it), so its rule is the explanation: see the model name above.',
  FALLBACK:
    'This product has too little sales history at this store, so the forecast is the average of similar products — there are no model inputs to explain.',
  FAILED_CHECK:
    'The explanation did not add up exactly to the forecast in the last run, so it was not stored. A wrong explanation would be worse than none.',
  NOT_AVAILABLE:
    'The latest forecast run was made before explanations existed. Run a new forecast.',
};

/** "Why this forecast?": the model's inputs as factors that multiply up to the first forecast day. */
export function ForecastExplanation({
  productId,
  locationId,
}: {
  productId: string;
  locationId: string;
}) {
  const result = useAsync(
    useCallback(() => fetchForecastExplanation(productId, locationId), [productId, locationId]),
  );

  return (
    <details className="rounded border bg-white px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Why this forecast?</summary>
      <div className="mt-2 space-y-2">
        {result.status === 'loading' && <Loading />}
        {result.status === 'error' && (
          <ErrorMessage message={result.error} onRetry={result.reload} />
        )}
        {result.status === 'success' &&
          (result.data.explanation ? (
            <Factors e={result.data.explanation} />
          ) : (
            <p className="text-slate-600">{NOT_EXPLAINED[result.data.status]}</p>
          ))}
      </div>
    </details>
  );
}

function Factors({
  e,
}: {
  e: { targetDay: string; startingPoint: number; forecast: number; factors: ExplanationFactor[] };
}) {
  const shown = e.factors.slice(0, SHOWN);
  const rest = e.factors.slice(SHOWN);
  const restFactor = rest.reduce((p, f) => p * f.factor, 1);
  const widest = Math.max(0.01, ...e.factors.map((f) => Math.abs(f.contribution)));

  return (
    <>
      <p>
        Forecast for <strong>{formatDay(e.targetDay)}</strong>:{' '}
        <strong>{formatDecimal(e.forecast)} units</strong>. The model starts from its typical
        forecast of {formatDecimal(e.startingPoint)} units and each input multiplies it:
      </p>
      <ul className="space-y-1" aria-label="Contributions to the forecast">
        {shown.map((f) => (
          <FactorRow key={f.feature} f={f} widest={widest} />
        ))}
        {rest.length > 0 && (
          <li className="flex items-center gap-3 text-slate-500">
            <span className="w-64 shrink-0">All {rest.length} other inputs together</span>
            <span className="w-16 text-right tabular-nums">× {restFactor.toFixed(2)}</span>
          </li>
        )}
      </ul>
      <p className="text-xs text-slate-500">
        {formatDecimal(e.startingPoint)} × factors = {formatDecimal(e.forecast)} units (exact).
        These show how much each input moved the <em>model&apos;s forecast</em> (SHAP values) — not
        what makes customers buy.
      </p>
    </>
  );
}

function FactorRow({ f, widest }: { f: ExplanationFactor; widest: number }) {
  const width = `${(Math.abs(f.contribution) / widest) * 50}%`;
  const up = f.contribution >= 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3">
      <span className="w-64 shrink-0">
        {f.label}: <span className="text-slate-600">{f.display}</span>
      </span>
      <span className="w-16 text-right font-medium tabular-nums">× {f.factor.toFixed(2)}</span>
      <span className="relative h-2 min-w-24 flex-1 rounded bg-slate-100" aria-hidden="true">
        <span
          className={`absolute top-0 h-2 rounded ${up ? 'left-1/2 bg-sky-600' : 'right-1/2 bg-amber-500'}`}
          style={{ width }}
        />
      </span>
    </li>
  );
}
