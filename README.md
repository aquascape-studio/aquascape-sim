# aquascape-sim

Planted-aquarium growth simulation, exposed as a gRPC service.

Python 3.12 + [grpcio](https://grpc.io/docs/languages/python/) + numpy.

Implements `aquascape.v1.SimService`:

- `Simulate(SimRequest) returns (stream Frame)` — server-streaming. Produces
  one `Frame` per simulated tick (1 day per tick; up to ~365 ticks per call).
  Clients (currently: `aquascape-api`) backpressure via normal gRPC flow control.
- `GetSummary(SimSummaryRequest) returns (SimSummary)` — aggregate outcome
  after a simulation completes.

## Why a separate service

- The algorithm is the patent-pending core. Isolating it behind a contract lets
  us iterate without touching the API surface web/mobile depend on.
- CPU-heavy ticks, numpy-friendly. Would pollute the Rust API with a Python
  runtime dep.
- Horizontal scale is different from the API: sim workloads are bursty and
  long-running; API is request/response and latency-sensitive.

## Layout

```
.
├── pyproject.toml
├── Dockerfile
├── proto/                           # git submodule → aquascape-proto
├── src/aquascape_sim/
│   ├── __init__.py
│   ├── server.py                    # grpcio server bootstrap
│   ├── service.py                   # SimService impl
│   └── algo/
│       ├── __init__.py
│       ├── envelope.py              # compatibility scoring (plant × water params)
│       ├── light.py                 # canopy PAR attenuation
│       ├── nutrients.py             # N/P/K/Fe draw-down per tick
│       └── tick.py                  # single-tick integration
├── tests/
│   └── test_envelope.py
└── .github/workflows/ci.yml
```

`algo/` is where sim-agent spends most of its time. Everything else is plumbing.

## Proto submodule

```bash
git submodule update --init --recursive
```

Codegen runs at install-time via the `generate_proto.py` script (invoked by
`pyproject.toml`'s build hook) — outputs go to `src/aquascape_sim/_generated/`
and are gitignored.

## Local dev

```bash
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
python -m aquascape_sim.server
```

Listens on `0.0.0.0:50052`.

## Testing

```bash
pytest -q
```

The algorithm core in `algo/` is pure-Python and unit-testable without gRPC.

## Owner

sim-agent owns `algo/`. infra-agent owns `Dockerfile` / `server.py` /
deployment.
