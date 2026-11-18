"""Model monitoring (V2 step 3c-1): drift statistics, windows, a known shift, accuracy."""

from __future__ import annotations

import math
from datetime import timedelta

import numpy as np
import pytest

from app.monitoring import monitor
from app.monitoring.drift import FLOOR, compare, psi, status_of, worst
from app.monitoring.monitor import PointsSample, compute, windows_for
from app.pipeline import BASELINE_FUNCS
from tests.helpers import make_history

MA28 = BASELINE_FUNCS["moving_average_28"]


def ma_predict(hist):  # noqa: ANN001, ANN201
    return lambda builder, origin: MA28(hist.y, origin, 1)[:, 0]


def day(hist, idx: int):  # noqa: ANN001, ANN201
    return hist.days[idx].astype("datetime64[D]").item()


NO_POINTS = PointsSample([], [], [], np.empty(0))

# ---------------------------------------------------------------- PSI / KS


def test_psi_is_zero_for_identical_samples() -> None:
    x = np.random.default_rng(1).poisson(3, 5000).astype(float)
    assert psi(x, x) == pytest.approx(0.0, abs=1e-12)


def test_psi_by_hand_on_a_small_sample() -> None:
    # Reference 0..9: deciles 0.9, 1.8, … 8.1 → 10 bins of one value each (share 0.1).
    # Current: ten zeros → bin 0 has share 1, the other nine are floored at 1e-4.
    ref, cur = np.arange(10.0), np.zeros(10)
    expected = (1 - 0.1) * math.log(1 / 0.1) + 9 * (FLOOR - 0.1) * math.log(FLOOR / 0.1)
    assert psi(ref, cur) == pytest.approx(expected, rel=1e-12)
    assert expected == pytest.approx(8.2831, abs=1e-4)


def test_count_data_with_many_zeros_merges_duplicate_bin_edges() -> None:
    ref = np.array([0.0] * 80 + [1.0] * 15 + [2.0] * 5)  # deciles: many edges at 0
    assert psi(ref, ref.copy()) == pytest.approx(0.0, abs=1e-12)
    assert psi(ref, np.array([0.0] * 40 + [1.0] * 40 + [2.0] * 20)) > 0.25


@pytest.mark.parametrize(
    ("value", "status"),
    [(0.0, "STABLE"), (0.0999, "STABLE"), (0.10, "WATCH"), (0.2499, "WATCH"), (0.25, "DRIFT")],
)
def test_status_thresholds(value: float, status: str) -> None:
    assert status_of(value) == status


def test_compare_reports_ks_for_context_and_refuses_too_little_data() -> None:
    rng = np.random.default_rng(2)
    d = compare(rng.normal(0, 1, 2000), rng.normal(1, 1, 2000))
    assert d.status == "DRIFT" and d.ks_d is not None and d.ks_d > 0.3 and d.ks_p < 1e-6
    for empty in (compare(np.ones(10), np.empty(0)), compare(np.ones(10), np.ones(10), False)):
        assert empty.status == "INSUFFICIENT_DATA" and empty.psi is None


def test_worst_status_ignores_insufficient_unless_nothing_is_known() -> None:
    assert worst(["STABLE", "WATCH", "INSUFFICIENT_DATA"]) == "WATCH"
    assert worst(["STABLE", "DRIFT", "WATCH"]) == "DRIFT"
    assert worst(["INSUFFICIENT_DATA", "INSUFFICIENT_DATA"]) == "INSUFFICIENT_DATA"
    assert worst([]) == "INSUFFICIENT_DATA"


# ---------------------------------------------------------------- windows


def test_windows_reference_ends_at_training_current_follows() -> None:
    hist = make_history(days=200)
    w = windows_for(hist, day(hist, 189))
    assert w.reference == (162, 189) and w.current == (190, 199)
    assert w.current_days == 10 and w.enough

    latest = windows_for(hist, day(hist, 199))  # trained through the latest day: nothing new
    assert latest.current is None and latest.current_days == 0 and not latest.enough

    few = windows_for(hist, day(hist, 193))  # 6 new days: fewer than 7
    assert few.current_days == 6 and not few.enough

    long_ago = windows_for(hist, day(hist, 100))  # current = at most the latest 28 days
    assert long_ago.current == (172, 199)


def test_too_few_new_days_means_insufficient_data_never_stable() -> None:
    hist = make_history(days=200)
    out = compute(hist, day(hist, 195), "moving_average_28", ma_predict(hist), NO_POINTS, 0.5, {})
    assert out.data_drift_status == "INSUFFICIENT_DATA"
    assert out.prediction_drift_status == "INSUFFICIENT_DATA"
    assert out.performance_status == "INSUFFICIENT_DATA"
    assert all(r.status == "INSUFFICIENT_DATA" for r in out.results)


# ---------------------------------------------------------------- a known shift


def _shifted(stores: tuple[str, ...]):  # noqa: ANN202
    """+50 % demand from day 212 on (after training) at the given stores."""
    hist = make_history(n_products=40, n_stores=3, days=240, new_share=0.0)
    rows = np.array([loc in stores for loc in hist.location_ids])
    hist.y[rows, 212:] = np.round(hist.y[rows, 212:] * 1.5)
    return hist


CODES = {"s0": "STR-A", "s1": "STR-B", "s2": "STR-C"}


def _monitor(hist):  # noqa: ANN001, ANN202
    out = compute(
        hist, day(hist, 211), "moving_average_28", ma_predict(hist), NO_POINTS, None, CODES
    )
    return out, {(r.check_kind, r.subject): r for r in out.results}


def test_unshifted_control_is_stable() -> None:
    out, by = _monitor(_shifted(()))
    assert out.data_drift_status == "STABLE", [(k, r.drift) for k, r in by.items()]
    assert out.prediction_drift_status == "STABLE"


def test_a_network_wide_shift_is_drift_on_short_window_inputs_and_every_store() -> None:
    out, by = _monitor(_shifted(("s0", "s1", "s2")))
    # Measured (pre-registration expected DRIFT on all demand inputs): short-window inputs
    # react; 28- and 56-day means still average pre-shift days inside a 28-day window.
    for f in ("mean_7d", "std_28d", "last_same_weekday", "ratio_7d_28d"):
        assert by[("FEATURE", f)].status == "DRIFT", (f, by[("FEATURE", f)].drift)
    assert by[("FEATURE", "mean_28d")].status == "WATCH"
    assert by[("FEATURE", "mean_56d")].status == "STABLE"
    for code in CODES.values():
        assert by[("STORE_SALES", code)].status == "DRIFT"
    assert out.data_drift_status == "DRIFT"
    assert out.prediction_drift_status in ("WATCH", "DRIFT")  # a 28-day average lags too


def test_a_one_store_shift_is_caught_by_that_store_not_by_pooled_inputs() -> None:
    out, by = _monitor(_shifted(("s0",)))
    assert by[("STORE_SALES", "STR-A")].status == "DRIFT"
    assert by[("STORE_SALES", "STR-B")].status == "STABLE"
    assert by[("STORE_SALES", "STR-C")].status == "STABLE"
    assert out.data_drift_status == "DRIFT"  # the overall status still flags it


# ---------------------------------------------------------------- accuracy on new days


def _points(hist, series: int, days: range, factor: float) -> PointsSample:  # noqa: ANN001
    return PointsSample(
        [hist.product_ids[series]] * len(days),
        [hist.location_ids[series]] * len(days),
        [day(hist, k) for k in days],
        np.array([hist.y[series, k] * factor for k in days]),
    )


def test_accuracy_by_hand(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor, "MIN_ACCURACY_POINTS", 1)
    hist = make_history(days=200, new_share=0.0)
    s = int(np.argmax(np.nansum(hist.y[:, 190:197], axis=1)))
    span = range(190, 197)  # 7 days
    exact = monitor.accuracy(hist, _points(hist, s, span, 1.0), backtest_wape=0.5)
    assert (exact.wape, exact.bias, exact.n_days, exact.n_points, exact.status) == (
        0.0,
        0.0,
        7,
        7,
        "OK",
    )
    high = monitor.accuracy(hist, _points(hist, s, span, 1.2), backtest_wape=0.5)
    assert high.wape == pytest.approx(0.2) and high.bias == pytest.approx(0.2)
    assert high.status == "DEGRADED"  # |bias| 20 % > 10 %

    # WAPE 8 % with no bias: fine against a 5 % backtest + 5 points, degraded against 2 %.
    mixed = _points(hist, s, span, 1.0)
    yhat = mixed.yhat.copy()
    yhat[::2] *= 1.08
    yhat[1::2] *= 0.92
    total = float(np.sum(mixed.yhat))
    expected_wape = float(np.sum(np.abs(yhat - mixed.yhat))) / total
    sample = PointsSample(mixed.product_ids, mixed.location_ids, mixed.target_days, yhat)
    ok = monitor.accuracy(hist, sample, backtest_wape=expected_wape - 0.04)
    assert ok.wape == pytest.approx(expected_wape) and ok.status in ("OK", "DEGRADED")
    assert ok.status == ("DEGRADED" if abs(ok.bias) > 0.10 else "OK")
    assert monitor.accuracy(hist, sample, backtest_wape=expected_wape - 0.06).status == "DEGRADED"


def test_accuracy_needs_seven_days_and_skips_days_without_data() -> None:
    hist = make_history(days=200, new_share=0.0)
    six = monitor.accuracy(hist, _points(hist, 0, range(190, 196), 1.0), 0.5)
    assert six.status == "INSUFFICIENT_DATA" and six.n_days == 6
    future = PointsSample(
        [hist.product_ids[0]],
        [hist.location_ids[0]],
        [day(hist, 199) + timedelta(days=3)],
        np.ones(1),
    )
    assert monitor.accuracy(hist, future, 0.5).n_points == 0
