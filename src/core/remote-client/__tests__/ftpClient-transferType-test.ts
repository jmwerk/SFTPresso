const sent: string[] = [];

jest.mock('basic-ftp', () => {
  const { EventEmitter } = jest.requireActual('events');
  class Client {
    ftp: any = { socket: new EventEmitter() };
    availableListCommands: string[] = [];
    access = jest.fn(async () => ({}));
    features = jest.fn(async () => new Map([['MLSD', '']]));
    send = jest.fn(async (command: string) => {
      sent.push(command);
      return { code: 200, message: 'OK' };
    });
  }
  class FTPError extends Error {}
  return { Client, FTPError };
});

import FTPClient from '../ftpClient';

const baseOption = { host: 'example.test', port: 21, username: 'u', password: 'p' };

async function connectWith(option: object): Promise<string[]> {
  sent.length = 0;
  const client = new FTPClient({ ...baseOption, ...option } as any);
  await client.connect({ ...baseOption, ...option } as any, {} as any);
  return [...sent];
}

describe('FTPClient ftpTransferType', () => {
  it('leaves the session in binary when unset', async () => {
    expect(await connectWith({})).not.toContain('TYPE A');
  });

  it('leaves the session in binary when "binary"', async () => {
    expect(await connectWith({ ftpTransferType: 'binary' })).not.toContain('TYPE A');
  });

  it('switches to ASCII when "ascii"', async () => {
    expect(await connectWith({ ftpTransferType: 'ascii' })).toEqual(['TYPE A']);
  });

  it('switches to ASCII after the PROT C downgrade for secure: "control"', async () => {
    expect(await connectWith({ ftpTransferType: 'ascii', secure: 'control' })).toEqual([
      'PROT C',
      'TYPE A',
    ]);
  });
});
