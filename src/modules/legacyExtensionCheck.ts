import * as vscode from 'vscode';
import { showWarningMessage, executeCommand } from '../host';
import logger from '../logger';

// Both extensions register commands under the same `sftp.*` namespace as us,
// so VS Code resolves the collision unpredictably and `SFTP: Upload` can
// silently run the other extension's handler against the same sftp.json.
const LEGACY_EXTENSION_IDS = ['liximomo.sftp', 'Natizyskunk.sftp'];

const SUPPRESS_KEY = 'sftp.legacyExtensionCheck.suppressed';

const SHOW_LABEL = 'Show Me';
const DONT_SHOW_LABEL = "Don't Show Again";

export function checkForLegacyExtensions(context: vscode.ExtensionContext) {
  if (context.workspaceState.get<boolean>(SUPPRESS_KEY)) {
    return;
  }

  // vscode.extensions.getExtension() only ever returns *enabled* extensions —
  // an installed-but-disabled extension is invisible to this API, so no
  // separate enabled-check is needed and disabled installs never trigger this.
  const legacyId = LEGACY_EXTENSION_IDS.find(id => !!vscode.extensions.getExtension(id));
  if (!legacyId) {
    return;
  }

  const legacyExtension = vscode.extensions.getExtension(legacyId)!;
  const displayName = legacyExtension.packageJSON?.displayName || legacyId;

  logger.warn(`Detected legacy SFTP extension "${legacyId}" alongside SFTPresso.`);

  showWarningMessage(
    `SFTPresso and ${displayName} both register sftp.* commands. Only one will run. ` +
      `Disable ${displayName} to avoid conflicts.`,
    SHOW_LABEL,
    DONT_SHOW_LABEL
  ).then(choice => {
    switch (choice) {
      case SHOW_LABEL:
        executeCommand('workbench.extensions.action.showExtensionsWithIds', [legacyId]);
        break;
      case DONT_SHOW_LABEL:
        context.workspaceState.update(SUPPRESS_KEY, true);
        break;
    }
  });
}
