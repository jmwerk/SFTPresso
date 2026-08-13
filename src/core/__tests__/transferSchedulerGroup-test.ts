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
});
