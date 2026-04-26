#!/usr/bin/env python3
"""Generate Python gRPC stubs from the aquascape-proto submodule.

Outputs to `src/aquascape_sim/_generated/`. That path is gitignored.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROTO_ROOT = ROOT / "proto" / "proto"
OUT = ROOT / "src" / "aquascape_sim" / "_generated"


def main() -> int:
    if not PROTO_ROOT.exists():
        print(f"ERR: proto submodule missing at {PROTO_ROOT}", file=sys.stderr)
        print("Run: git submodule update --init --recursive", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "__init__.py").write_text('"""Generated protos — do not edit."""\n')

    files = sorted(PROTO_ROOT.rglob("*.proto"))
    if not files:
        print(f"ERR: no .proto files under {PROTO_ROOT}", file=sys.stderr)
        return 1

    cmd = [
        sys.executable,
        "-m",
        "grpc_tools.protoc",
        f"-I{PROTO_ROOT}",
        f"--python_out={OUT}",
        f"--grpc_python_out={OUT}",
        f"--pyi_out={OUT}",
        *[str(f) for f in files],
    ]
    print(" ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        return rc

    # grpc_tools.protoc does not create __init__.py for intermediate directories.
    # Add them so Python treats each level as a regular package.
    for d in sorted(OUT.rglob("*/")):
        init = d / "__init__.py"
        if not init.exists():
            init.write_text('"""Generated — do not edit."""\n')

    return 0


if __name__ == "__main__":
    sys.exit(main())
