import * as vscode from 'vscode';
import { COMMAND_SET_PROFILE } from '../constants';
import { showInformationMessage } from '../host';
import app from '../app';
import logger from '../logger';
import { getAllFileService } from '../modules/serviceManager';
import { BASE_CONFIG, addressList, hostAddress } from '../modules/remoteExplorer/profileLabel';
import { FileService } from '../core';
import { checkCommand } from './abstract/createCommand';

// Where `service` points under `profile` (null for the base config), for the picker.
function addressUnder(service: FileService, profile: string | null): string | undefined {
  try {
    return hostAddress(service.getConfig(profile));
  } catch {
    // an invalid profile still gets listed, just without an address
    return undefined;
  }
}

export default checkCommand({
  id: COMMAND_SET_PROFILE,

  async handleCommand(definedProfile) {
    const services = getAllFileService().filter(service => service.getAvailableProfiles().length > 0);
    const baseAddresses = services
      .map(service => addressUnder(service, null))
      .filter((address): address is string => !!address);
    const profiles = services.reduce<
      Array<vscode.QuickPickItem & { value: string | null }>
    >(
      (acc, service) => {
        service.getAvailableProfiles().forEach(profile => {
          acc.push({
            value: profile,
            label: app.state.profile === profile ? `${profile} (active)` : profile,
            description: addressUnder(service, profile),
          });
        });
        return acc;
      },
      [
        {
          value: null,
          label: app.state.profile === null ? `${BASE_CONFIG} (active)` : BASE_CONFIG,
          description: addressList(baseAddresses),
          detail: "The config's top-level settings",
        },
      ]
    );

    if (profiles.length <= 1) {
      showInformationMessage('No Available Profile.');
      return;
    }

    // Only a string names a profile. A view title button passes an object, which used to be
    // taken as an unknown profile and silently reset to the base config.
    if (typeof definedProfile === 'string') {
      const index = profiles.findIndex(a => a.value === definedProfile);
      if (index !== -1) {
        app.state.profile = definedProfile;
      } else {
        app.state.profile = null;
        logger.warn(`try to set a unknown profile "${definedProfile}"`);
      }
      return;
    }

    const item = await vscode.window.showQuickPick(profiles, { placeHolder: 'Select a profile' });
    if (item === undefined) return;
    app.state.profile = item.value;
  },
});
