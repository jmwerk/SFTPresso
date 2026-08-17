import { window } from 'vscode';
import debounce from 'lodash.debounce';
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

    const debouncedSetFilter = debounce(
      (value: string) => app.remoteExplorer.setFilter(value),
      FILTER_DEBOUNCE_MS
    );
    quickPick.onDidChangeValue(debouncedSetFilter);

    quickPick.onDidAccept(() => quickPick.hide());
    quickPick.onDidHide(() => {
      debouncedSetFilter.cancel();
      quickPick.dispose();
    });

    quickPick.show();
  },
});
