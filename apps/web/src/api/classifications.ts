import { getJson, type Page, postJson, qs } from './client';

export type ClassCode = 'AX' | 'AY' | 'AZ' | 'BX' | 'BY' | 'BZ' | 'CX' | 'CY' | 'CZ' | 'NEW';

export interface ClassificationSummary {
  run: {
    id: string;
    calculatedAt: string;
    windowStart: string;
    windowEnd: string;
    dataLabel: 'SYNTHETIC' | 'LEDGER' | 'MIXED';
    itemCount: number;
    triggeredBy: string | null;
  } | null;
  scope: { locationId: string | null; locationCode: string | null };
  cells: { cls: ClassCode; count: number; valueShare: number }[];
  rules: {
    windowWeeks: number;
    minWeeks: number;
    abc: { a: number; b: number };
    xyz: { x: number; y: number };
    intermittentAdi: number;
  };
  meanings: { abc: Record<'A' | 'B' | 'C', string>; xyz: Record<'X' | 'Y' | 'Z', string> };
  policies: Record<Exclude<ClassCode, 'NEW'>, string>;
}

export interface ClassifiedItem {
  productId: string;
  sku: string;
  productName: string;
  cls: ClassCode;
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

export const fetchClassificationSummary = (locationId?: string) =>
  getJson<ClassificationSummary>(`/classifications/summary${qs({ locationId })}`);

export const listClassified = (p: {
  locationId?: string;
  cls?: ClassCode;
  q?: string;
  page?: number;
  pageSize?: number;
}) => getJson<Page<ClassifiedItem>>(`/classifications${qs({ ...p })}`);

export const recalculateClassifications = () =>
  postJson<ClassificationSummary>('/classifications/recalculate', {});
