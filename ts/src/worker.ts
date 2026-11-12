/**
 * Web Worker entry: `new Worker(new URL("./worker", import.meta.url), { type: "module" })`.
 * Thin adapter around createWorkerHandler.
 */
import type { WorkerRequest, WorkerResponse } from "./contract";
import { createWorkerHandler } from "./index";

interface WorkerScope {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const handle = createWorkerHandler((msg) => scope.postMessage(msg));
scope.onmessage = (ev) => {
  void handle(ev.data);
};
