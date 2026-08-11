import { COMMAND_DISCONNECT } from '../constants';
import { showInformationMessage } from '../host';
import logger from '../logger';
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

    let disconnected = 0;
    for (const service of services) {
      try {
        service.disconnect();
        disconnected += 1;
      } catch (error) {
        // one bad config shouldn't stop the others from being cleaned up
        logger.error(error, 'disconnect');
      }
    }

    logger.info(`disconnected ${disconnected} of ${services.length} configs`);
    showInformationMessage(
      disconnected === 1
        ? 'Disconnected. The next command will reconnect.'
        : `Disconnected ${disconnected} connections. The next command will reconnect.`
    );
  },
});
