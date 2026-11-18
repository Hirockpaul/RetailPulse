"""Precision and recall of anomaly detection against the INJECTED labels (synthetic ground truth).

Only days with at least 8 weeks of history are scored. A natural, very rare sales day that was
not injected counts as a false positive: that is the honest cost of any threshold.
"""

from __future__ import annotations

import numpy as np

from app.anomalies.detect import DROP_DAYS, RULE, SPIKE_METHODS, Baseline, baseline, drops
from app.data import History

MIN_HISTORY_DAYS = 56


def label_masks(hist: History, labels) -> tuple[np.ndarray, np.ndarray]:
    """(spike_days, drop_days) boolean matrices from rows product_id, location_id, day, kind."""
    index = {
        (p, loc): i
        for i, (p, loc) in enumerate(zip(hist.product_ids, hist.location_ids, strict=True))
    }
    day0 = hist.days[0].astype("datetime64[D]")
    spike = np.zeros(hist.y.shape, bool)
    drop = np.zeros(hist.y.shape, bool)
    for row in labels.itertuples(index=False):
        s = index.get((row.product_id, row.location_id))
        t = int((np.datetime64(row.day, "D") - day0).astype(int))
        if s is None or not 0 <= t < hist.n_days:
            continue
        (spike if row.kind == "SPIKE" else drop)[s, t] = True
    return spike, drop


def scored_days(hist: History, b: Baseline) -> np.ndarray:
    old_enough = np.arange(hist.n_days)[None, :] - hist.start_idx[:, None] >= MIN_HISTORY_DAYS
    return b.judged & old_enough


def prf(predicted: int, true_positive: int, actual: int) -> dict:
    precision = true_positive / predicted if predicted else float("nan")
    recall = true_positive / actual if actual else float("nan")
    f1 = (
        2 * precision * recall / (precision + recall)
        if predicted and actual and (precision + recall) > 0
        else float("nan")
    )
    return {
        "predicted": predicted,
        "true_positive": true_positive,
        "actual": actual,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def evaluate(hist: History, labels, rule: str = RULE) -> dict[str, dict]:
    """Per spike method and for drops: predicted, hits, labels, precision, recall, F1."""
    b = baseline(hist, rule)
    scored = scored_days(hist, b)
    spike_true, drop_true = label_masks(hist, labels)
    out: dict[str, dict] = {}
    for name, method in SPIKE_METHODS.items():
        pred = method(hist, b) & scored
        out[f"spike:{name}"] = prf(
            int(pred.sum()), int((pred & spike_true).sum()), int((spike_true & scored).sum())
        )
    # Drops are events: a detected run counts if it overlaps an injected drop; an injected drop
    # (a block of DROP_DAYS labelled days) counts as found if any detected run overlaps it.
    starts = drops(hist, b) & scored
    covered = np.zeros_like(starts)
    for k in range(DROP_DAYS):
        covered[:, k:] |= starts[:, : hist.n_days - k]
    label_start = drop_true & ~np.pad(drop_true, ((0, 0), (1, 0)))[:, :-1]
    hit_detect = sum(bool(drop_true[s, t : t + DROP_DAYS].any()) for s, t in np.argwhere(starts))
    found_labels = sum(
        bool(covered[s, t : t + DROP_DAYS].any()) for s, t in np.argwhere(label_start & scored)
    )
    actual = int((label_start & scored).sum())
    result = prf(int(starts.sum()), hit_detect, actual)
    result["recall"] = found_labels / actual if actual else float("nan")
    p, r = result["precision"], result["recall"]
    result["f1"] = 2 * p * r / (p + r) if actual and starts.sum() and (p + r) > 0 else float("nan")
    out["drop"] = result
    return out
