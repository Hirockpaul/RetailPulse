from app.repository import eligibility


def test_candidate_needs_a_half_point_validation_wape_gain() -> None:
    assert eligibility(0.400, 0.395)[0] == "ELIGIBLE"
    assert eligibility(0.400, 0.396)[0] == "REJECTED"


def test_unmeasured_candidate_is_rejected() -> None:
    status, reason = eligibility(0.4, float("nan"))
    assert status == "REJECTED"
    assert "unavailable" in reason
