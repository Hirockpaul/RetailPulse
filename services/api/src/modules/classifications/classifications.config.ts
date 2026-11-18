/**
 * ABC/XYZ thresholds and the suggested policy per class (V2 step 2a). Fixed before any data was
 * classified (docs/V2-PLAN.md step 2a). Policies are advice shown to managers; service levels per
 * class are decided in step 2b.
 */
export const CLASSIFICATION = {
  windowWeeks: 52,
  minWeeks: 13,
  abc: { a: 0.8, b: 0.95 },
  xyz: { x: 0.5, y: 1.0 },
  /** Average demand interval above this = intermittent demand (Syntetos–Boylan). */
  intermittentAdi: 1.32,
  keepRuns: 5,
} as const;

export type Abc = 'A' | 'B' | 'C';
export type Xyz = 'X' | 'Y' | 'Z';

export const ABC_MEANING: Record<Abc, string> = {
  A: 'the products making up the first 80 % of consumption value',
  B: 'the next 15 % of value',
  C: 'the last 5 % of value (often many products)',
};

export const XYZ_MEANING: Record<Xyz, string> = {
  X: 'steady weekly demand (variation ≤ 50 % of the average)',
  Y: 'moderately variable demand (variation 50–100 %)',
  Z: 'highly variable or intermittent demand',
};

/** Suggested stocking policy per class: what to do, not a rule the system enforces. */
export const POLICIES: Record<`${Abc}${Xyz}`, string> = {
  AX: 'High value, steady: monitor closely, replenish reliably and often; keep safety stock lean because demand is predictable.',
  AY: 'High value, variable: review often; size safety stock from forecast uncertainty.',
  AZ: 'High value, erratic: manage case by case; uncertainty-aware safety stock and frequent review of forecasts.',
  BX: 'Medium value, steady: routine automatic replenishment.',
  BY: 'Medium value, variable: routine replenishment with periodic review of safety stock.',
  BZ: 'Medium value, erratic: avoid overstocking; consider ordering closer to demand.',
  CX: 'Low value, steady: simple policy, larger and fewer orders.',
  CY: 'Low value, variable: simple policy; accept occasional stock-outs rather than tie up stock.',
  CZ: 'Low value, erratic: review whether to stock at all; avoid unnecessary excess.',
};
