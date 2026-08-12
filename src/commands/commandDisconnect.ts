import { COMMAND_DISCONNECT } from '../constants';
import { showInformationMessage } from '../host';
import logger from '../logger';
import { removeAllRemoteFs } from '../core/remoteFs';
import { getAllFileService } from '../modules/serviceManager';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_DISCONNECT,

  async handleCommand() {
    // Every config, not just the active one: this is the escape hatch for a
    // connection that has stopped answering, and picking the right one out of
    // a list is not something you should have to do to get unstuck.
    const services = getAllFileService();
    if (!services.length) {
      showInformationMessage('No SFTP config found.');
      return;
    }

    let closed = 0;
    for (const service of services) {
      try {
        closed += service.disconnect();
      } catch (error) {
        // one bad config shouldn't stop the others from being cleaned up
        logger.error(error, 'disconnect');
      }
    }

    // Backstop for anything the loop above couldn't reach: a connection opened
    // under a config that has since been edited is still in the pool, but no
    // config resolves to its identity any more. Leaving it open would defeat
    // the whole point of the command.
    const orphaned = removeAllRemoteFs();
    if (orphaned > 0) {
      logger.info(`closed ${orphaned} connection(s) no config still resolves to`);
    }
    closed += orphaned;

    logger.info(`disconnected ${closed} connections across ${services.length} configs`);
    showInformationMessage(
      closed === 0
        ? 'Nothing was connected.'
        : closed === 1
        ? 'Disconnected. The next command will reconnect.'
        : `Disconnected ${closed} connections. The next command will reconnect.`
    );
  },
});
