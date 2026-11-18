/**
 * Thresholds of the operational-anomaly rules (V2 step 1e-2). Plain rules, not ML: each finding
 * says which rule fired and on which numbers. Chosen as reasonable defaults for the synthetic
 * store sizes (a store holds ~1-80 units of a product), not tuned on data.
 */
export const OPERATIONS_RULES = {
  /** One adjustment removing at least this many units… */
  writeOffUnits: 20,
  /** …or at least this share of what was on hand just before (if at least 10 were on hand). */
  writeOffShare: 0.5,
  writeOffMinOnHand: 10,
  /** HIGH if at least this many units or this share. */
  writeOffHighUnits: 50,
  writeOffHighShare: 0.8,

  /** At least this many stock-reducing adjustments of one product at one location… */
  frequentAdjustments: 3,
  /** …within this many days (one finding per window). */
  frequentWindowDays: 7,
  frequentHigh: 5,

  /** At least this many returns, and returns ≥ this share of sale lines… */
  returnMin: 5,
  returnShare: 0.25,
  /** …within this many days (one finding per window). */
  returnWindowDays: 30,
  returnHighShare: 0.5,
} as const;

/** Measured on synthetic data (docs/ARCHITECTURE.md §7.3, held-out seed); shown on the page. */
export const SALES_PRECISION = {
  spikeHigh: 'about half (47–80 % in three test datasets)',
  spikeMedium: 'about 1 in 25',
  drop: 'about 1 in 5',
} as const;
