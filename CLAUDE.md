# aquascape-sim

**Owner**: sim-agent  
**Language**: Python 3.12 + grpcio asyncio  
**Port**: 50052 (internal only, Cloud Map: aquascape-sim.aquascape.local)

## Layout

```
aquascape-sim/
├── src/
│   ├── algo/
│   │   ├── envelope.py      # trapezoidal growth envelopes
│   │   ├── light.py         # Beer-Lambert PAR attenuation
│   │   ├── nutrients.py     # Liebig minimum
│   │   └── tick.py          # simulation step
│   └── server.py            # grpcio asyncio entry point
├── proto/                   # pinned submodule → aquascape-proto
├── scripts/
│   └── generate_proto.py    # runs grpc_tools.protoc
├── tests/
├── Dockerfile
└── pyproject.toml
```

## Path note

Agent definitions reference `packages/sim/` — the actual root is `aquascape-sim/`. When delegating, use paths relative to this directory.

## Key commands

```bash
pip install -e ".[dev]"
pytest
python -m src.server
python scripts/generate_proto.py   # after proto submodule bump
```

## Contracts

- Reads species data from bundled `plants.json` (sourced from aquascape-botany)
- Emits `SimFrame` records consumed by aquascape-render
- Proto stubs generated from `proto/` submodule (aquascape-proto)
