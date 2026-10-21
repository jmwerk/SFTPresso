import { COMMAND_REMOTEEXPLORER_COMPARE_WITH_LOCAL } from '../constants';
import { checkFileCommand } from './abstract/createCommand';
import compareFolders from './fileCommandCompareFolders';
import { selectFolderFallbackToConfigContext } from './shared';

// sftp.compareFolders from the remote side, titled for where it's run
export default checkFileCommand({
  id: COMMAND_REMOTEEXPLORER_COMPARE_WITH_LOCAL,
  getFileTarget: selectFolderFallbackToConfigContext,
  handleFile: compareFolders.handleFile,
});
