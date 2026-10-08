const showWarningMessage = jest.fn();
const executeCommand = jest.fn();
const reportError = jest.fn();

jest.mock('fs');

jest.mock('../../host', () => ({
  showWarningMessage,
  executeCommand,
  showTextDocument: jest.fn(),
}));

jest.mock('../../helper', () => ({ reportError }));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, critical() {} },
}));

import { vol } from 'memfs';
import { parse } from 'jsonc-parser';
import { readConfigsFromFile, validateConfig } from '../config';

let configCount = 0;

// The warning is deduped per path for the session, so each test reads a fresh path
function writeConfig(content: object | string): string {
  const configPath = `/ws${++configCount}/.vscode/sftp.json`;
  vol.fromJSON({
    [configPath]: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  });
  return configPath;
}

function readBack(configPath: string) {
  return parse(vol.readFileSync(configPath, 'utf8') as string);
}

const base = { host: 'example.com', username: 'bob', remotePath: '/var/www' };
const withPassword = { ...base, password: 'hunter2' };

// lets the .then() on the notification and the sequential file edits settle
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('plaintext password warning', () => {
  beforeEach(() => {
    vol.reset();
    showWarningMessage.mockReset().mockResolvedValue(undefined);
    executeCommand.mockReset();
    reportError.mockReset();
  });

  it('shows the notification by default', async () => {
    await readConfigsFromFile(writeConfig(withPassword));

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('plaintext password'),
      'Migrate Password',
      "Don't Show Again"
    );
  });

  it('warns for a password inside a profile', async () => {
    await readConfigsFromFile(writeConfig({ ...base, profiles: { dev: { password: 'x' } } }));

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('does not warn when there is no password', async () => {
    await readConfigsFromFile(writeConfig(base));

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('does not warn when warnPlaintextPassword is false', async () => {
    await readConfigsFromFile(writeConfig({ ...withPassword, warnPlaintextPassword: false }));

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('accepts warnPlaintextPassword in schema validation', () => {
    expect(validateConfig({ ...withPassword, warnPlaintextPassword: false })).toBeUndefined();
    expect(validateConfig({ ...withPassword, warnPlaintextPassword: 'no' })).toBeDefined();
  });

  it('still warns for other configs in an array when one opts out', async () => {
    await readConfigsFromFile(
      writeConfig([
        { ...withPassword, name: 'a', warnPlaintextPassword: false },
        { ...withPassword, name: 'b' },
      ])
    );

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('runs the migrate command when "Migrate Password" is chosen', async () => {
    showWarningMessage.mockResolvedValue('Migrate Password');
    const configPath = writeConfig(withPassword);

    await readConfigsFromFile(configPath);
    await flush();

    expect(executeCommand).toHaveBeenCalledWith('sftp.migratePassword');
    expect(readBack(configPath).warnPlaintextPassword).toBeUndefined();
  });

  it('writes warnPlaintextPassword: false on "Don\'t Show Again", keeping comments', async () => {
    showWarningMessage.mockResolvedValue("Don't Show Again");
    const configPath = writeConfig(`{
  // production box
  "host": "example.com",
  "username": "bob",
  "password": "hunter2",
  "remotePath": "/var/www"
}`);

    await readConfigsFromFile(configPath);
    await flush();

    const text = vol.readFileSync(configPath, 'utf8') as string;
    expect(text).toContain('// production box');
    expect(readBack(configPath).warnPlaintextPassword).toBe(false);
    expect(reportError).not.toHaveBeenCalled();

    showWarningMessage.mockClear();
    await readConfigsFromFile(writeConfig(text));
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('only marks the array entries that have a password on "Don\'t Show Again"', async () => {
    showWarningMessage.mockResolvedValue("Don't Show Again");
    const configPath = writeConfig([
      { ...withPassword, name: 'a' },
      { ...base, name: 'b' },
      { ...withPassword, name: 'c' },
    ]);

    await readConfigsFromFile(configPath);
    await flush();

    expect(readBack(configPath).map(c => c.warnPlaintextPassword)).toEqual([
      false,
      undefined,
      false,
    ]);
  });
});
