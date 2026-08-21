import { FileService, ServiceConfig } from '../core';
import logger from '../logger';

export type TestConnectionResult = { ok: true } | { ok: false; error: Error };

// Connects and does a minimal round-trip (lstat the remote root). Shared by
// the `SFTP: Test Connection` command and the config wizard, which needs the
// outcome back as a value rather than as a notification.
export async function testConnection(
  service: FileService,
  config: ServiceConfig
): Promise<TestConnectionResult> {
  if (config.protocol === 'local') {
    return { ok: true };
  }

  try {
    const fs = await service.getRemoteFileSystem(config);
    await fs.lstat('/');
    return { ok: true };
  } catch (error) {
    logger.error(error, 'testConnection');
    return { ok: false, error };
  }
}
