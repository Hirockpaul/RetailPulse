/**
 * Replenishment assumptions. They are deliberately simple, visible and stored with every
 * recommendation, so a manager can see exactly what a suggestion was based on.
 * Service levels and lead-time rules: docs/V2-PLAN.md step 2b (fixed before measuring).
 */
export const REPLENISHMENT = {
  /** How often we review: the order-up-to level covers lead time PLUS this many days. */
  reviewPeriodDays: 7,
  /** Days for stock to arrive from a distribution centre (no measured history: spread 0). */
  transferLeadTimeDays: 2,
  /** A supplier needs at least this many deliveries before its measured delay is used. */
  minSupplierDeliveries: 20,
  /** Service level for products that are NEW or not classified yet. */
  defaultServiceLevel: 0.95,
  /** Expected stockout dates further away than this are not shown (V2 2d-1). */
  stockoutHorizonDays: 90,
} as const;

export type ServiceLevel = 0.9 | 0.95 | 0.97 | 0.99;

/**
 * Target share of replenishment cycles without a stock-out, by ABC/XYZ class at the store.
 * Value (A/B/C) sets how costly a stock-out is; erratic demand (Z) gets one step less, because
 * its safety stock is the largest and the normal approximation is weakest there.
 */
export const SERVICE_LEVEL_BY_CLASS: Record<string, ServiceLevel> = {
  AX: 0.99,
  AY: 0.99,
  AZ: 0.97,
  BX: 0.97,
  BY: 0.97,
  BZ: 0.95,
  CX: 0.95,
  CY: 0.95,
  CZ: 0.9,
};

/** z = standard normal quantile of the service level (fixed table, checked by hand). */
export const Z_BY_SERVICE_LEVEL: Record<ServiceLevel, number> = {
  0.9: 1.2816,
  0.95: 1.6449,
  0.97: 1.8808,
  0.99: 2.3263,
};
