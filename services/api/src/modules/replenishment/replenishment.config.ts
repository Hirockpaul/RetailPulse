/**
 * Replenishment assumptions. They are deliberately simple, visible and stored with every
 * recommendation, so a manager can see exactly what a suggestion was based on.
 */
export const REPLENISHMENT = {
  /** z for a ~95% service level: safety stock covers demand swings 95% of the time. */
  serviceLevelZ: 1.645,
  /** How often we review: the order-up-to level covers lead time PLUS this many days. */
  reviewPeriodDays: 7,
  /** Days for stock to arrive from a distribution centre. */
  transferLeadTimeDays: 2,
} as const;
