/**
 * Thresholds behind the Overview page. Deliberately simple and visible: the page prints them
 * next to the numbers, so nobody has to guess what "at risk" or "excess" means.
 */
export const OVERVIEW = {
  /** "At risk": available + inbound will not cover the forecast demand of this many days. */
  riskWindowDays: 7,
  /** "Excess": available + inbound covers more than this many days of forecast demand. */
  excessCoverDays: 60,
  /** How many rows each "top" list returns. */
  topN: 10,
} as const;
