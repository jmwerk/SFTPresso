import { window } from 'vscode';
import app from '../app';
import { COMMAND_REMOTEEXPLORER_FILTER } from '../constants';
import { checkCommand } from './abstract/createCommand';

const FILTER_DEBOUNCE_MS = 150;

export default checkCommand({
  id: COMMAND_REMOTEEXPLORER_FILTER,

  handleCommand() {
    const quickPick = window.createQuickPick();
    quickPick.placeholder = 'Filter Remote Explorer by name (substring match)';
    quickPick.value = app.remoteExplorer.getFilter() || '';

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    quickPick.onDidChangeValue(value => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        app.remoteExplorer.setFilter(value);
      }, FILTER_DEBOUNCE_MS);
    });

    quickPick.onDidAccept(() => quickPick.hide());
    quickPick.onDidHide(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      quickPick.dispose();
    });

    quickPick.show();
  },
});
