"""SimService implementation.

Glues the algo/ core to the gRPC surface. Keep this file boring — heavy lifting
lives in algo/tick.py.
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import AsyncIterator
from typing import Any

import aquascape_sim
from aquascape_sim.algo.tick import TickState, run_tick

# pb2 files use absolute imports (from aquascape.v1 import …).
# Add _generated to sys.path so those imports resolve.
_gen_dir = os.path.join(os.path.dirname(aquascape_sim.__file__), "_generated")
if os.path.isdir(_gen_dir) and _gen_dir not in sys.path:
    sys.path.insert(0, _gen_dir)

log = logging.getLogger(__name__)


class SimServicer:
    """Implements aquascape.v1.SimService.

    We intentionally don't inherit from the generated Servicer class at import
    time — we wire the methods in server.py so tests can instantiate this
    class without requiring codegen.
    """

    async def Simulate(self, request: Any, context: Any) -> AsyncIterator[Any]:
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
        from aquascape.v1 import sim_pb2  # type: ignore

        return sim_pb2.SimSummary()
