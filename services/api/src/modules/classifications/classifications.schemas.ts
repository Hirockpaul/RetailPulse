import { z } from 'zod';
import { paginationSchema, searchSchema, sortSchema, uuidSchema } from '../../core/http/query';

export const CLASSES = ['AX', 'AY', 'AZ', 'BX', 'BY', 'BZ', 'CX', 'CY', 'CZ', 'NEW'] as const;

/** Without locationId: the whole network (every role). With it: one store (store-scoped). */
export const scopeQuerySchema = z.object({ locationId: uuidSchema.optional() });
export type ScopeQuery = z.output<typeof scopeQuerySchema>;

export const listClassificationsQuerySchema = paginationSchema.extend({
  locationId: uuidSchema.optional(),
  cls: z.enum(CLASSES).optional(),
  q: searchSchema,
  sort: sortSchema({ value: 'c.value', sku: 'p.sku', cv: 'c.cv', units: 'c.units' }, 'value:desc'),
});
export type ListClassificationsQuery = z.output<typeof listClassificationsQuerySchema>;

export interface ClassificationRun {
  id: string;
  calculatedAt: Date;
  windowStart: string;
  windowEnd: string;
  dataLabel: 'SYNTHETIC' | 'LEDGER' | 'MIXED';
  itemCount: number;
  triggeredBy: string | null;
}

export interface ClassifiedItem {
  productId: string;
  sku: string;
  productName: string;
  cls: (typeof CLASSES)[number];
  abc: 'A' | 'B' | 'C' | null;
  xyz: 'X' | 'Y' | 'Z' | null;
  weeksObserved: number;
  units: number;
  value: number;
  valueShare: number;
  cumulativeShare: number;
  weeklyMean: number;
  cv: number | null;
  adi: number | null;
}

export interface ClassificationSummary {
  run: ClassificationRun | null;
  scope: { locationId: string | null; locationCode: string | null };
  /** One cell per class (including NEW): how many products, and their share of the value. */
  cells: { cls: string; count: number; valueShare: number }[];
  rules: {
    windowWeeks: number;
    minWeeks: number;
    abc: { a: number; b: number };
    xyz: { x: number; y: number };
    intermittentAdi: number;
  };
  meanings: { abc: Record<string, string>; xyz: Record<string, string> };
  policies: Record<string, string>;
}
