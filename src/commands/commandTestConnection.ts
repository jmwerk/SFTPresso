import { l10n, Uri } from 'vscode';
import { COMMAND_TEST_CONNECTION } from '../constants';
import { showInformationMessage, showErrorMessage } from '../host';
import { testConnection } from '../modules/connectionTest';
import { checkCommand } from './abstract/createCommand';
import { resolveTargetService } from './shared';

export default checkCommand({
  id: COMMAND_TEST_CONNECTION,

  async handleCommand(uri?: Uri) {
    const service = await resolveTargetService(uri, l10n.t('Select a config to test'));
    if (!service) {
      showErrorMessage(l10n.t('No SFTP config found to test.'));
      return;
    }

    let config;
    try {
      config = service.getConfig();
    } catch (error) {
      showErrorMessage(l10n.t('Invalid config: {0}', error.message));
      return;
    }

    if (config.protocol === 'local') {
      showInformationMessage(
        l10n.t('Active profile uses the local protocol; no connection needed.')
      );
      return;
    }

    const result = await testConnection(service, config);
    if (result.ok) {
      showInformationMessage(
        l10n.t(
          'Successfully connected to {0}:{1} via {2}.',
          config.host,
          config.port,
          config.protocol.toUpperCase()
        )
      );
    } else {
      showErrorMessage(
        l10n.t('Failed to connect to {0}:{1}: {2}', config.host, config.port, result.error.message)
      );
    }
  },
});
