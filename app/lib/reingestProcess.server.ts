import { fork } from "node:child_process";
import { resolve } from "node:path";
import type { ReingestLease } from "./reingestQueue";
import type { TrainOutcome } from "./kbTrain";
import { processReingestLease } from "./reingestWorker";
import { reingestStore } from "./reingestStore.server";

/** Terminate only this freshly created attempt child; never signal other processes. */
export function runReingestChild(lease: ReingestLease, signal: AbortSignal, attemptPath = resolve("scripts/kb-reingest-attempt.ts")): Promise<TrainOutcome> {
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new Error("attempt_aborted")); return; }
    const child = fork(attemptPath, [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let outcome: TrainOutcome | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    const abort = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("message", (value) => { if (value && typeof value === "object" && "ok" in value) outcome = value as TrainOutcome; });
    let transportFailed = false;
    const fail = () => {
      transportFailed = true;
      if (child.pid) abort(); // Wait for exit before the worker retries this lease.
      else { signal.removeEventListener("abort", abort); reject(new Error("attempt_spawn_failed")); }
    };
    child.once("error", fail);
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (transportFailed || signal.aborted || code !== 0 || !outcome) reject(new Error("attempt_failed"));
      else resolveResult(outcome);
    });
    child.send(lease, (error) => { if (error) fail(); });
  });
}

export const runReingestAttempt = (lease: ReingestLease) => processReingestLease(lease, { store: reingestStore, run: runReingestChild });
