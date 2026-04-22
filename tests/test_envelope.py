from aquascape_sim.algo.envelope import Axis, compat


def test_score_inside_optimum():
    a = Axis(min=10, opt_min=20, opt_max=30, max=40)
    assert a.score(25) == 1.0


def test_score_ramp_up():
    a = Axis(min=10, opt_min=20, opt_max=30, max=40)
    assert a.score(15) == 0.5


def test_score_out_of_range():
    a = Axis(min=10, opt_min=20, opt_max=30, max=40)
    assert a.score(5) == 0.0
    assert a.score(45) == 0.0


def test_compat_geometric_mean_penalizes_weakest():
    axes = {
        "temp": Axis(10, 20, 30, 40),
        "ph": Axis(5, 6, 7, 8),
    }
    # temp ideal, pH way off → overall low
    weak = compat(axes, {"temp": 25, "ph": 4.5})
    strong = compat(axes, {"temp": 25, "ph": 6.5})
    assert weak < strong
    assert strong == 1.0


def test_compat_empty_returns_one():
    assert compat({}, {"temp": 25}) == 1.0
