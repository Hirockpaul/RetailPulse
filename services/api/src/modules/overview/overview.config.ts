/**
 * Thresholds behind the Overview page. Deliberately simple and visible: the page prints them
 * next to the numbers, so nobody has to guess what "at risk" or "excess" means.
 */
export const OVERVIEW = {
  /** "At risk": available + inbound will not cover the forecast demand of this many days. */
  riskWindowDays: 7,
  /** "Excess": available + inbound covers more than this many days of forecast demand. */
  excessCoverDays: 60,
  /** Control Tower: the second, longer "at risk" window (V2 4a-1). */
  riskWindowLongDays: 14,
  /** Control Tower: transfers approved/dispatched longer ago than this are "delayed". */
  transferDelayDays: 2,
  /** Control Tower: suppliers scoring below this (0–100, step 2c) are a supply risk. */
  supplierRiskScore: 75,
  /** Control Tower: days of sales history in the sales chart. */
  salesHistoryDays: 28,
  /** How many rows each "top" list returns. */
  topN: 10,
} as const;
