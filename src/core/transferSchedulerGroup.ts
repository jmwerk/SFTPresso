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

  constructor(concurrency: number) {
    this._gate = new Scheduler({ concurrency });
  }

  setConcurrency(concurrency: number): void {
    this._gate.setConcurrency(concurrency);
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
