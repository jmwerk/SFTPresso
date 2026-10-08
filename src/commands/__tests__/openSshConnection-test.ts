import { terminalTargets } from '../commandOpenSshConnection';

const folder = (name: string) => ({ name, isDirectory: true } as any);
const file = (name: string) => ({ name, isDirectory: false } as any);

describe('terminalTargets', () => {
  it('is empty without a clicked item (Command Palette)', () => {
    expect(terminalTargets(undefined, undefined)).toEqual([]);
  });

  it('uses the clicked item when nothing else is selected', () => {
    const a = folder('a');

    expect(terminalTargets(a, undefined)).toEqual([a]);
    expect(terminalTargets(a, [a])).toEqual([a]);
  });

  it('opens every selected folder when the clicked one is part of the selection', () => {
    const a = folder('a');
    const b = folder('b');
    const c = folder('c');

    expect(terminalTargets(b, [a, b, c])).toEqual([a, b, c]);
  });

  it('skips files in the selection', () => {
    const a = folder('a');
    const f = file('f');

    expect(terminalTargets(a, [a, f])).toEqual([a]);
  });

  it('ignores a selection the clicked item is not part of', () => {
    const a = folder('a');
    const b = folder('b');
    const c = folder('c');

    expect(terminalTargets(c, [a, b])).toEqual([c]);
  });
});
