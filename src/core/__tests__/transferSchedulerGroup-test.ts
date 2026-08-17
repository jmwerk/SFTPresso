import TransferSchedulerGroup from '../transferSchedulerGroup';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeTask() {
  return { cancel: jest.fn() } as any;
}

describe('TransferSchedulerGroup', () => {
  test('caps concurrent work shared by separate batches', async () => {
    const group = new TransferSchedulerGroup(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;

    const tickets = gates.map(gate =>
      group.schedule(fakeTask(), async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      })
    );

    await Promise.resolve();
    expect(peak).toBe(2);
    gates[0].resolve();
    gates[1].resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(tickets.map(ticket => ticket.promise));
  });

  test('cancels work that is waiting in the shared queue', async () => {
    const group = new TransferSchedulerGroup(1);
    const first = deferred();
    group.schedule(fakeTask(), () => first.promise);
    const secondTask = fakeTask();
    const second = group.schedule(secondTask, async () => undefined);

    second.cancel();
    first.resolve();
    await second.promise;
    expect(secondTask.cancel).toHaveBeenCalledTimes(1);
  });

  describe('setConcurrency while a batch is active', () => {
    test('a new batch starting on an idle gate applies its own setConcurrency immediately', async () => {
      const group = new TransferSchedulerGroup(4);

      // mirrors the real call order in FileService.createTransferScheduler:
      // setConcurrency() is called before this batch registers as active
      group.setConcurrency(1);
      const endBatch = group.beginBatch();

      let active = 0;
      let peak = 0;
      const gates = [deferred(), deferred()];
      const tickets = gates.map(gate =>
        group.schedule(fakeTask(), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        })
      );

      await Promise.resolve();
      expect(peak).toBe(1);
      gates.forEach(gate => gate.resolve());
      await Promise.all(tickets.map(t => t.promise));
      endBatch();
    });

    test("an unrelated batch's setConcurrency call does not throttle another batch's already-admitted work", async () => {
      const group = new TransferSchedulerGroup(4);
      const endBatchA = group.beginBatch();

      let active = 0;
      let peak = 0;
      const gates = [deferred(), deferred(), deferred()];
      const ticketsA = gates.map(gate =>
        group.schedule(fakeTask(), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        })
      );
      await Promise.resolve();
      expect(peak).toBe(3);

      // batch B starts concurrently with a much stricter setting -- it must
      // not retroactively cap batch A's three already-admitted tasks down to 1
      const endBatchB = group.beginBatch();
      group.setConcurrency(1);
      await Promise.resolve();
      expect(peak).toBe(3);

      gates.forEach(gate => gate.resolve());
      await Promise.all(ticketsA.map(t => t.promise));
      endBatchA();
      endBatchB();

      // once every batch has ended, the held-back setting takes effect for
      // whatever runs next
      let laterActive = 0;
      let laterPeak = 0;
      const laterGates = [deferred(), deferred()];
      const laterTickets = laterGates.map(gate =>
        group.schedule(fakeTask(), async () => {
          laterActive += 1;
          laterPeak = Math.max(laterPeak, laterActive);
          await gate.promise;
          laterActive -= 1;
        })
      );
      await Promise.resolve();
      expect(laterPeak).toBe(1);
      laterGates.forEach(gate => gate.resolve());
      await Promise.all(laterTickets.map(t => t.promise));
    });
  });
});
