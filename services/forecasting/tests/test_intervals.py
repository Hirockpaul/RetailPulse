"""Forecast ranges from measured errors (split conformal, by forecast level)."""

import numpy as np
import pytest

from app.evaluation import intervals


def poisson_world(seed: int, n_series: int = 600, n_days: int = 40):
    """Forecasts equal to the true mean; actual sales are Poisson draws around it."""
    rng = np.random.default_rng(seed)
    mean = rng.choice([0.3, 0.8, 1.5, 3.0, 6.0, 12.0], n_series)
    forecast = np.repeat(mean[:, None], n_days, axis=1)
    return forecast, rng.poisson(forecast).astype(float)


def test_ranges_hold_their_level_in_every_forecast_level_group_on_new_data() -> None:
    f_cal, a_cal = poisson_world(1)
    f_new, a_new = poisson_world(2)  # independent data: the honest check
    cal = intervals.calibrate(f_cal, a_cal, np.ones_like(f_cal, bool))
    for level in (80, 95):
        cov, n = intervals.coverage_by_group(cal, f_new, a_new, np.ones_like(f_new, bool), level)
        checked = n > 0
        # Never clearly below the level, in any group.
        assert (cov[checked] >= level / 100 - 0.03).all(), (level, cov)
        # Close to it where sales are not tiny. For a 0.3/day seller sales are 0 or 1, so the
        # narrowest honest range is "0 to 1 unit", which holds ~96 %: counts cannot hit 80 %.
        # The effect of whole units shrinks as volume grows.
        start = np.array(cal.edges[:-1])
        assert (cov[checked & (start >= 2.0)] <= level / 100 + 0.10).all(), (level, cov)
        assert (cov[checked & (start >= 8.0)] <= level / 100 + 0.03).all(), (level, cov)


def test_a_symmetric_normal_band_would_mis_cover_slow_and_fast_sellers() -> None:
    """Why the method exists: one sigma per series misjudges skewed counts by level."""
    f_cal, a_cal = poisson_world(3)
    f_new, a_new = poisson_world(4)
    sigma = np.sqrt(np.mean((a_cal - f_cal) ** 2, axis=1))
    lower, upper = intervals.normal_band(f_new, sigma, 1.2816)
    inside = (a_new >= lower) & (a_new <= upper)
    slow, fast = f_new[:, 0] == 0.3, f_new[:, 0] == 12.0
    assert inside[slow].mean() > 0.90  # far too wide for slow sellers (target 0.80)
    assert inside[fast].mean() < inside[slow].mean() - 0.1


def test_ranges_are_nested_never_negative_and_contain_the_forecast() -> None:
    f, a = poisson_world(5)
    cal = intervals.calibrate(f, a, np.ones_like(f, bool))
    lo80, hi80 = intervals.apply(cal, f, 80)
    lo95, hi95 = intervals.apply(cal, f, 95)
    assert (lo95 >= 0).all()
    assert (lo95 <= lo80).all() and (lo80 <= f).all() and (f <= hi80).all() and (hi80 <= hi95).all()
    assert (hi95 - lo95 > hi80 - lo80).any()


def test_upper_bound_grows_with_the_forecast_level() -> None:
    f, a = poisson_world(6)
    cal = intervals.calibrate(f, a, np.ones_like(f, bool))
    widths = [cal.high[80][g] - cal.low[80][g] for g in range(len(cal.edges) - 1)]
    used = cal.n_points > 0
    assert np.all(np.diff(np.array(widths)[used]) >= 0)


def test_groups_with_too_few_points_use_all_residuals() -> None:
    forecast = np.array([[0.2] * 500 + [20.0] * 10])  # only 10 points in the top group
    actual = forecast + np.tile(np.linspace(-1, 1, 510), (1, 1))
    cal = intervals.calibrate(forecast, actual, np.ones_like(forecast, bool))
    top = cal.group_of(np.array([20.0]))[0]
    assert cal.pooled[top] and cal.n_points[top] == 10
    assert cal.low[80][top] == pytest.approx(np.quantile((actual - forecast), 0.1, method="lower"))


def test_only_masked_points_are_used_and_an_empty_mask_is_an_error() -> None:
    f, a = poisson_world(7, n_series=50)
    mask = np.zeros_like(f, bool)
    with pytest.raises(ValueError):
        intervals.calibrate(f, a, mask)
    mask[:, :10] = True
    cal = intervals.calibrate(f, a, mask)
    assert cal.n_points.sum() == mask.sum()
