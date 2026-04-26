"""SimService implementation.

Glues the algo/ core to the gRPC surface. Keep this file boring — heavy lifting
lives in algo/tick.py.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from aquascape_sim.algo.tick import TickState, run_tick

log = logging.getLogger(__name__)


class SimServicer:
    """Implements aquascape.v1.SimService.

    We intentionally don't inherit from the generated Servicer class at import
    time — we wire the methods in server.py so tests can instantiate this
    class without requiring codegen.
    """

    async def Simulate(self, request: Any, context: Any) -> AsyncIterator[Any]:
        # Imports here so unit tests on algo/ don't pull in generated code.
        import sys as _sys, os as _os, aquascape_sim as _pkg  # noqa: E401
_gen = _os.path.join(_os.path.dirname(_pkg.__file__), "_generated")
if _gen not in _sys.path:
    _sys.path.insert(0, _gen)
from aquascape.v1 import sim_pb2  # type: ignore

        horizon_days = max(1, min(int(getattr(request, "horizon_days", 30)), 365))
        log.info("sim start horizon=%d", horizon_days)

        state = TickState.from_request(request)
        for day in range(horizon_days):
            run_tick(state, day)

            frame = sim_pb2.Frame()
            frame.day = day
            # Per-plant placeholder — algo/tick writes into state.plants by id.
            for pid, pf in state.plants.items():
                f = frame.plants.add()
                f.plant_id = pid
                f.biomass_g = float(pf.biomass_g)
                f.health = float(pf.health)

            yield frame

        log.info("sim done")

    async def GetSummary(self, request: Any, context: Any) -> Any:
        import sys as _sys, os as _os, aquascape_sim as _pkg  # noqa: E401
_gen = _os.path.join(_os.path.dirname(_pkg.__file__), "_generated")
if _gen not in _sys.path:
    _sys.path.insert(0, _gen)
from aquascape.v1 import sim_pb2  # type: ignore

        return sim_pb2.SimSummary()
