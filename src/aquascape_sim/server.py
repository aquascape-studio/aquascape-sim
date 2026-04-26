"""gRPC server bootstrap."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2_grpc
from grpc_reflection.v1alpha import reflection

from aquascape_sim.service import SimServicer

# Generated protos are expected under `_generated/` after build-step codegen.
# Import lazily so unit tests on `algo/` don't require codegen.

log = logging.getLogger("aquascape_sim")


def _setup_logging() -> None:
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level,
        format='{"t":"%(asctime)s","lvl":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
    )


async def _serve_async(port: int) -> None:
    try:
        import sys as _sys
        import aquascape_sim as _pkg
        _gen_dir = os.path.join(os.path.dirname(_pkg.__file__), "_generated")
        if not os.path.isdir(_gen_dir):
            raise ImportError(f"_generated dir not found at {_gen_dir}")
        # pb2 files use absolute imports (e.g. `from aquascape.v1 import …`);
        # adding _generated to sys.path makes those resolvable.
        if _gen_dir not in _sys.path:
            _sys.path.insert(0, _gen_dir)
        from aquascape.v1 import sim_pb2, sim_pb2_grpc  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Generated protos not found. Run `python scripts/generate_proto.py` first."
        ) from e

    server = grpc.aio.server(
        futures.ThreadPoolExecutor(max_workers=8),
        options=[
            ("grpc.max_send_message_length", 16 * 1024 * 1024),
            ("grpc.max_receive_message_length", 16 * 1024 * 1024),
        ],
    )

    sim_pb2_grpc.add_SimServiceServicer_to_server(SimServicer(), server)

    health_servicer = health.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)

    service_names = (
        sim_pb2.DESCRIPTOR.services_by_name["SimService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    server.add_insecure_port(f"0.0.0.0:{port}")
    await server.start()
    log.info("aquascape-sim listening on :%d", port)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    log.info("shutdown signal received")
    await server.stop(grace=10)


def main() -> None:
    _setup_logging()
    port = int(os.getenv("PORT", "50052"))
    asyncio.run(_serve_async(port))


if __name__ == "__main__":
    main()
