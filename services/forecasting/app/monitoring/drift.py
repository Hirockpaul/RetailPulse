"""Distribution drift between a reference and a current sample (V2 step 3c-1, decision D2).

PSI (population stability index) sets the status; KS is reported for context only, because with
tens of thousands of points almost any difference is "significant".

  bins     = the reference sample's deciles, duplicate edges merged (sales are counts with many
             zeros); bin i holds values in (edge[i-1], edge[i]]
  r_i, c_i = share of reference / current values in bin i, floored at 1e-4
  PSI      = sum over bins of (c_i - r_i) * ln(c_i / r_i)
  status   = STABLE < 0.10 <= WATCH < 0.25 <= DRIFT
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats

PSI_WATCH = 0.10
PSI_DRIFT = 0.25
FLOOR = 1e-4
INSUFFICIENT = "INSUFFICIENT_DATA"


@dataclass(frozen=True)
class Drift:
    n_reference: int
    n_current: int
    psi: float | None
    ks_d: float | None
    ks_p: float | None
    status: str  # INSUFFICIENT_DATA | STABLE | WATCH | DRIFT


def decile_edges(reference: np.ndarray) -> np.ndarray:
    return np.unique(np.quantile(reference, np.linspace(0.1, 0.9, 9)))


def shares(sample: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Share of `sample` in each bin (len(edges) + 1 bins), floored at FLOOR."""
    counts = np.bincount(np.searchsorted(edges, sample, side="left"), minlength=len(edges) + 1)
    return np.maximum(counts / max(sample.size, 1), FLOOR)


def psi(reference: np.ndarray, current: np.ndarray) -> float:
    edges = decile_edges(reference)
    r, c = shares(reference, edges), shares(current, edges)
    return float(np.sum((c - r) * np.log(c / r)))


def status_of(value: float) -> str:
    if value >= PSI_DRIFT:
        return "DRIFT"
    return "WATCH" if value >= PSI_WATCH else "STABLE"


def compare(reference: np.ndarray, current: np.ndarray, enough: bool = True) -> Drift:
    """PSI + KS for two samples; INSUFFICIENT_DATA when `enough` is False or a sample is empty."""
    ref = np.asarray(reference, dtype=float)
    cur = np.asarray(current, dtype=float)
    ref, cur = ref[np.isfinite(ref)], cur[np.isfinite(cur)]
    if not enough or ref.size == 0 or cur.size == 0:
        return Drift(int(ref.size), int(cur.size), None, None, None, INSUFFICIENT)
    value = psi(ref, cur)
    ks = stats.ks_2samp(ref, cur)
    return Drift(
        int(ref.size), int(cur.size), value, float(ks.statistic), float(ks.pvalue), status_of(value)
    )


def worst(statuses: list[str]) -> str:
    """Overall status of a family of checks: the worst informative one, else INSUFFICIENT_DATA."""
    order = ["STABLE", "WATCH", "DRIFT"]
    known = [s for s in statuses if s in order]
    return max(known, key=order.index) if known else INSUFFICIENT
