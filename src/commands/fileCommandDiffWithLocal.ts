import { COMMAND_REMOTEEXPLORER_DIFF_WITH_LOCAL } from '../constants';
import { diff } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

// sftp.diff from the remote side, titled for where it's run
export default checkFileCommand({
  id: COMMAND_REMOTEEXPLORER_DIFF_WITH_LOCAL,
  getFileTarget: uriFromExplorerContextOrEditorContext,
  handleFile: diff,
});
