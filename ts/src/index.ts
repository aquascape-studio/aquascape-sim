/**
 * @aquascape/sim-core public API.
 *
 * Self-contained: only relative, extensionless imports inside ts/src so the
 * folder can be vendor-copied verbatim (Next.js / bundler resolution).
 */

export * from "./contract";
export * as algo from "./algo";
export { createPrng } from "./prng";
export type { Prng } from "./prng";
export { Engine, envelopeAxis, canopyTransmission } from "./engine";

import type { Frame, SimInput, SimResult, WorkerRequest, WorkerResponse } from "./contract";
import { Engine, summarize } from "./engine";

/** Lazily simulate day by day. Yields frames for day 0..days inclusive; returns the full result. */
export function* simulateIter(input: SimInput): Generator<Frame, SimResult, void> {
  const engine = new Engine(input);
  const days = Math.max(0, Math.floor(input.days));
  const frames: Frame[] = [];
  const f0 = engine.start();
  frames.push(f0);
  yield f0;
  for (let d = 1; d <= days; d++) {
    const f = engine.step();
    frames.push(f);
    yield f;
  }
  return summarize(frames, engine.lowLightPar);
}

/** Run the whole simulation synchronously. */
export function simulate(input: SimInput): SimResult {
  const it = simulateIter(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface WorkerHandlerOptions {
  /** max ms of simulation between yields to the event loop (lets `cancel` through). Default 8. */
  sliceMs?: number;
}

/**
 * Implements the WorkerRequest/WorkerResponse protocol.
 *
 * `run` streams one `frame` message per day, then `done` (with the full result).
 * `cancel` stops a running request at the next slice boundary; the handler then
 * posts `{ type: "error", message: "cancelled" }` so callers can settle promises.
 * Exceptions are reported as `error`. The returned function resolves when the
 * request has been fully handled (useful for tests).
 */
export function createWorkerHandler(
  postMessage: (msg: WorkerResponse) => void,
  options: WorkerHandlerOptions = {},
): (req: WorkerRequest) => Promise<void> {
  const sliceMs = options.sliceMs ?? 8;
  const cancelled = new Set<number>();
  const running = new Set<number>();

  return async (req: WorkerRequest): Promise<void> => {
    if (req.type === "cancel") {
      if (running.has(req.requestId)) cancelled.add(req.requestId);
      return;
    }
    if (req.type !== "run") return;
    const { requestId } = req;
    running.add(requestId);
    const t0 = now();
    try {
      const it = simulateIter(req.input);
      let sliceStart = now();
      for (;;) {
        if (cancelled.has(requestId)) {
          postMessage({ type: "error", requestId, message: "cancelled" });
          return;
        }
        const r = it.next();
        if (r.done) {
          postMessage({ type: "done", requestId, result: r.value, elapsedMs: now() - t0 });
          return;
        }
        postMessage({ type: "frame", requestId, frame: r.value });
        if (now() - sliceStart >= sliceMs) {
          await yieldToEventLoop();
          sliceStart = now();
        }
      }
    } catch (e) {
      postMessage({ type: "error", requestId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      running.delete(requestId);
      cancelled.delete(requestId);
    }
  };
}
