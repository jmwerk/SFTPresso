jest.mock('vscode', () => ({
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  },
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
}));

import ConnectionStatusBar, { ConnectionState } from '../connectionStatusBar';

const text = (bar: ConnectionStatusBar) => (bar as any).statusBarItem.text;

describe('ConnectionStatusBar', () => {
  it('shows the worst state across connections', () => {
    const bar = new ConnectionStatusBar();

    bar.setState('live', ConnectionState.Error);
    bar.setState('staging', ConnectionState.Connected);

    expect(text(bar)).toBe('$(error)');
  });

  it("ignores a connection that isn't relevant, like another profile's", () => {
    const bar = new ConnectionStatusBar();
    let relevant = new Set(['staging']);
    bar.setRelevance(id => relevant.has(id));

    bar.setState('live', ConnectionState.Error);
    bar.setState('staging', ConnectionState.Connected);
    expect(text(bar)).toBe('$(vm-active)');

    // switching back to the profile whose connection failed shows its error again
    relevant = new Set(['live']);
    bar.refresh();
    expect(text(bar)).toBe('$(error)');
  });

  it('is idle when no relevant connection has a state', () => {
    const bar = new ConnectionStatusBar();
    bar.setRelevance(() => false);

    bar.setState('live', ConnectionState.Error);

    expect(text(bar)).toBe('$(plug)');
  });
});
