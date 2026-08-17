import Scheduler, { Task } from './scheduler';
import TransferTask from './transferTask';

export interface GateTicket {
  promise: Promise<void>;
  cancel(): void;
}

// A FileService may create several transfer batches at once (watcher, sync,
// Upload to All Profiles). This is the one shared gate that makes the selected
// concurrency a ceiling across those batches rather than a per-command limit.
export default class TransferSchedulerGroup {
  private _gate: Scheduler;
  private _activeBatches = 0;
  private _pendingConcurrency: number | undefined;

  constructor(concurrency: number) {
    this._gate = new Scheduler({ concurrency });
  }

  // Applied immediately when no batch currently has work in this gate. While
  // one or more batches are active, an unrelated batch calling this must not
  // change the ceiling out from under work another batch already has queued
  // or admitted -- the new value is held and applied once the gate goes idle.
  setConcurrency(concurrency: number): void {
    if (this._activeBatches === 0) {
      this._gate.setConcurrency(concurrency);
    } else {
      this._pendingConcurrency = concurrency;
    }
  }

  // Call once per batch before it starts scheduling work through this gate.
  // The returned function must be called exactly once, when that batch (all
  // of it, including anything parked in retry backoff) is completely done --
  // it is safe to call more than once, only the first call has any effect.
  beginBatch(): () => void {
    this._activeBatches += 1;
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      this._activeBatches = Math.max(0, this._activeBatches - 1);
      if (this._activeBatches === 0 && this._pendingConcurrency !== undefined) {
        this._gate.setConcurrency(this._pendingConcurrency);
        this._pendingConcurrency = undefined;
      }
    };
  }

  schedule(task: TransferTask, run: () => Promise<void>): GateTicket {
    let cancelled = false;
    let settled = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const gateTask: Task = {
      async run() {
        if (cancelled) {
          resolve();
          return;
        }
        try {
          await run();
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          reject(error);
        }
      },
    };
    this._gate.add(gateTask);

    return {
      promise,
      cancel() {
        cancelled = true;
        // A task already inside the gate must be told to stop too. A task
        // still queued will see `cancelled` before it gets to run.
        if (!settled) {
          task.cancel();
        }
      },
    };
  }
}
