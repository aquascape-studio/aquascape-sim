FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

FROM base AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir ".[dev]" \
 && python scripts/generate_proto.py \
 && pip wheel --no-deps --wheel-dir /wheels .

FROM base AS runtime
RUN useradd --system --uid 65532 --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /wheels /wheels
# Stage generated protos; the wheel may exclude them due to .gitignore
COPY --from=builder /build/src/aquascape_sim/_generated /tmp/_generated
RUN pip install --no-cache-dir /wheels/*.whl \
 && pip install --no-cache-dir "grpcio>=1.66" "grpcio-health-checking>=1.66" \
      "grpcio-reflection>=1.66" "protobuf>=5.27" "numpy>=2.1" "structlog>=24.4" \
 && rm -rf /wheels \
 && python -c "import aquascape_sim, os, shutil; \
               dst=os.path.join(os.path.dirname(aquascape_sim.__file__),'_generated'); \
               shutil.copytree('/tmp/_generated', dst, dirs_exist_ok=True); \
               print('protos installed to', dst)" \
 && python -c "import sys,aquascape_sim,os; sys.path.insert(0,os.path.join(os.path.dirname(aquascape_sim.__file__),'_generated')); from aquascape.v1 import sim_pb2; print('proto import OK')" \
 && rm -rf /tmp/_generated

USER app
EXPOSE 50052
CMD ["python", "-m", "aquascape_sim.server"]
