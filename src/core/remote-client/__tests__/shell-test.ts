import { openShell, shellQuote, startInDirectoryCommand } from '../shell';

function fakeClient(openError?: Error) {
  const calls: { method: string; args: any[] }[] = [];
  const channel = {};
  const client = {
    shell: (pty: any, cb: (err: Error | undefined, stream: any) => void) => {
      calls.push({ method: 'shell', args: [pty] });
      cb(openError, channel);
    },
    exec: (command: string, options: any, cb: (err: Error | undefined, stream: any) => void) => {
      calls.push({ method: 'exec', args: [command, options] });
      cb(openError, channel);
    },
  } as any;
  return { client, calls, channel };
}

describe('shellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/var/www/html')).toBe(`'/var/www/html'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`/srv/it's here`)).toBe(`'/srv/it'\\''s here'`);
  });

  it('leaves $ and backticks inert', () => {
    expect(startInDirectoryCommand('/a/$(rm -rf ~)/`x`')).toBe(
      `cd '/a/$(rm -rf ~)/\`x\`'; exec "\${SHELL:-/bin/sh}" -l`
    );
  });
});

describe('openShell', () => {
  it('opens a plain shell with a pty when no cwd is given', async () => {
    const { client, calls, channel } = fakeClient();

    await expect(openShell(client, { cols: 120, rows: 40 })).resolves.toBe(channel);

    expect(calls).toEqual([
      { method: 'shell', args: [{ term: 'xterm-256color', cols: 120, rows: 40 }] },
    ]);
  });

  it('treats "/" as no cwd', async () => {
    const { client, calls } = fakeClient();

    await openShell(client, { cols: 80, rows: 24, cwd: '/' });

    expect(calls[0].method).toBe('shell');
  });

  it('execs a login shell in cwd over a pty', async () => {
    const { client, calls } = fakeClient();

    await openShell(client, { cols: 80, rows: 24, cwd: '/home/site/public', term: 'xterm' });

    expect(calls).toEqual([
      {
        method: 'exec',
        args: [
          `cd '/home/site/public'; exec "\${SHELL:-/bin/sh}" -l`,
          { pty: { term: 'xterm', cols: 80, rows: 24 } },
        ],
      },
    ]);
  });

  it('rejects when the channel cannot be opened', async () => {
    const error = new Error('no more sessions');
    const { client } = fakeClient(error);

    await expect(openShell(client, { cols: 80, rows: 24 })).rejects.toBe(error);
  });
});
