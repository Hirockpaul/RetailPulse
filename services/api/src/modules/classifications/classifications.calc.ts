import { type Abc, CLASSIFICATION as C, type Xyz } from './classifications.config';

const EPS = 1e-9;

/**
 * ABC/XYZ classification as pure functions (unit-tested, numbers checkable by hand).
 * Rules: docs/V2-PLAN.md step 2a.
 */

export interface ItemInput {
  key: string;
  /** Units sold per week, oldest first, only the weeks the item existed (≤ windowWeeks). */
  weekly: number[];
  unitCost: number;
}

export interface ItemResult {
  key: string;
  weeksObserved: number;
  units: number;
  value: number;
  /** This item's share of the total value, and the cumulative share up to and including it. */
  valueShare: number;
  cumulativeShare: number;
  weeklyMean: number;
  /** Coefficient of variation of weekly units; null when nothing was sold. */
  cv: number | null;
  /** Average demand interval: weeks ÷ weeks with a sale; null when nothing was sold. */
  adi: number | null;
  abc: Abc | null;
  xyz: Xyz | null;
  /** e.g. "AX"; "NEW" when there are fewer than minWeeks weeks of history. */
  cls: string;
}

export function variability(weekly: number[]): {
  mean: number;
  cv: number | null;
  adi: number | null;
} {
  const n = weekly.length;
  const mean = n ? weekly.reduce((s, v) => s + v, 0) / n : 0;
  if (mean === 0) return { mean: 0, cv: null, adi: null };
  const sd = Math.sqrt(weekly.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const withSales = weekly.filter((v) => v > 0).length;
  return { mean, cv: sd / mean, adi: n / withSales };
}

export function xyzOf(cv: number | null, adi: number | null): Xyz {
  if (cv === null || adi === null || adi > C.intermittentAdi) return 'Z';
  if (cv <= C.xyz.x) return 'X';
  if (cv <= C.xyz.y) return 'Y';
  return 'Z';
}

/** Classify one scope (the whole network, or one store). Items are returned by value, highest first. */
export function classify(items: ItemInput[]): ItemResult[] {
  const rows = items.map((i) => {
    const units = i.weekly.reduce((s, v) => s + v, 0);
    return { ...i, units, value: units * i.unitCost, ...variability(i.weekly) };
  });
  const judged = rows.filter((r) => r.weekly.length >= C.minWeeks);
  const total = judged.reduce((s, r) => s + r.value, 0);
  judged.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));

  const out: ItemResult[] = [];
  let before = 0;
  for (const r of judged) {
    const share = total > 0 ? r.value / total : 0;
    // A tiny tolerance so a share of exactly 80 % (or 95 %) is not misread through float rounding.
    const abc: Abc =
      r.value <= 0 ? 'C' : before < C.abc.a - EPS ? 'A' : before < C.abc.b - EPS ? 'B' : 'C';
    before += share;
    const xyz = xyzOf(r.cv, r.adi);
    out.push(result(r, share, before, abc, xyz, `${abc}${xyz}`));
  }
  for (const r of rows.filter((x) => x.weekly.length < C.minWeeks)) {
    out.push(result(r, 0, 0, null, null, 'NEW'));
  }
  return out;
}

function result(
  r: ItemInput & {
    units: number;
    value: number;
    mean: number;
    cv: number | null;
    adi: number | null;
  },
  valueShare: number,
  cumulativeShare: number,
  abc: Abc | null,
  xyz: Xyz | null,
  cls: string,
): ItemResult {
  return {
    key: r.key,
    weeksObserved: r.weekly.length,
    units: r.units,
    value: r.value,
    valueShare,
    cumulativeShare,
    weeklyMean: r.mean,
    cv: r.cv,
    adi: r.adi,
    abc,
    xyz,
    cls,
  };
}
