/**
 * Turns the stored SHAP contributions (log units, see services/forecasting app/models/explain.py)
 * into manager-friendly factors. Pure functions, unit-tested.
 *
 *   forecast = startingPoint × factor_1 × factor_2 × …     with factor = exp(contribution)
 *
 * Wording rule: a factor says how much the MODEL's forecast moved because of an input. It never
 * claims the input caused real demand.
 */

export interface StoredContribution {
  feature: string;
  value: number;
  contribution: number;
}

export interface Factor {
  feature: string;
  label: string;
  /** The input's value for this forecast, ready to show ("4.3 per day", "Saturday", "STR-01"). */
  display: string;
  /** Contribution in log units (signed); 0 = no effect. */
  contribution: number;
  /** exp(contribution): 1.25 = raised the forecast by 25 %, 0.8 = lowered it by 20 %. */
  factor: number;
}

export interface FactorContext {
  categoryName: string;
  locationCode: string;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const one = (v: number) => (Math.round(v * 10) / 10).toString();

/** Label and displayed value of every model input. Unknown inputs are shown as they are. */
const DESCRIBE: Record<string, (v: number, ctx: FactorContext) => [string, string]> = {
  mean_7d: (v) => ['Average sales, last 7 days', `${one(v)} per day`],
  mean_28d: (v) => ['Average sales, last 28 days', `${one(v)} per day`],
  mean_56d: (v) => ['Average sales, last 56 days', `${one(v)} per day`],
  std_28d: (v) => ['Day-to-day variation, last 28 days', `± ${one(v)}`],
  last_same_weekday: (v) => ['Sales on the same weekday last week', `${one(v)} units`],
  mean_4_same_weekdays: (v) => ['Average of the last 4 same weekdays', `${one(v)} per day`],
  ratio_7d_28d: (v) => [
    'Recent trend (7-day vs 28-day average)',
    `× ${(Math.round(v * 100) / 100).toFixed(2)}`,
  ],
  weekday: (v) => ['Day of the week', WEEKDAYS[Math.round(v)] ?? one(v)],
  horizon: (v) => ['Days ahead', one(v)],
  season: (v) => ['Time of year', monthOfDay(v)],
  promo_target: (v) => [
    'Promotion planned for that day',
    v > 1 ? `yes (× ${one(v)} expected)` : 'no',
  ],
  promo_days_7d: (v) => ['Promotion days in the last 7 days', one(v)],
  category: (_v, ctx) => ['Product category', ctx.categoryName],
  store: (_v, ctx) => ['Store', ctx.locationCode],
};

/** Day of the year (1-366) → month name, for the "time of year" factor. */
export function monthOfDay(dayOfYear: number): string {
  const date = new Date(Date.UTC(2025, 0, 1) + (Math.round(dayOfYear) - 1) * 86_400_000);
  return MONTHS[date.getUTCMonth()];
}

export function describeFactor(c: StoredContribution, ctx: FactorContext): Factor {
  const describe = DESCRIBE[c.feature];
  const [label, display] = describe ? describe(c.value, ctx) : [c.feature, one(c.value)];
  return {
    feature: c.feature,
    label,
    display,
    contribution: c.contribution,
    factor: Math.exp(c.contribution),
  };
}

export function featureLabel(feature: string): string {
  const describe = DESCRIBE[feature];
  return describe ? describe(0, { categoryName: '', locationCode: '' })[0] : feature;
}
