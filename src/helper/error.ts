import { l10n } from 'vscode';
import * as output from '../ui/output';
import logger from '../logger';
import { showErrorMessage } from '../host';

export function describeConnectError(err: any, host: string): Error {
  const raw = err && err.message ? err.message : String(err);
  let friendly: string;

  switch (err && err.code) {
    case 'ECONNREFUSED':
      friendly = l10n.t(
        'Connection refused by {0}. Check the host/port and that the SSH service is running.',
        host
      );
      break;
    case 'ETIMEDOUT':
      friendly = l10n.t(
        'Connection to {0} timed out. Check your network connection and the host address.',
        host
      );
      break;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      friendly = l10n.t('Could not resolve host {0}. Check the host address.', host);
      break;
    case 'ECONNRESET':
      friendly = l10n.t('Connection to {0} was reset by the remote host.', host);
      break;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      friendly = l10n.t('{0} is unreachable. Check your network connection.', host);
      break;
    default:
      if (err && err.level === 'client-authentication') {
        friendly = l10n.t(
          'Authentication to {0} failed. Check your username, password, or private key.',
          host
        );
      } else if (err && err.level === 'client-timeout') {
        friendly = l10n.t('Connection to {0} timed out while waiting for a response.', host);
      } else if (typeof raw === 'string' && /handshake|host key|fingerprint/i.test(raw)) {
        friendly = l10n.t('Failed to verify the host key for {0}: {1}', host, raw);
      } else {
        friendly = `[${host}]: ${raw}`;
      }
  }

  const wrapped = new Error(friendly);
  wrapped.stack = err && err.stack ? err.stack : wrapped.stack;
  return wrapped;
}

export function reportError(err: Error | string, ctx?: string) {
  let errorString: string;
  if (err instanceof Error) {
    errorString = err.message;
    logger.error(`${err.stack}`, ctx);
  } else {
    errorString = err;
    logger.error(errorString, ctx);
  }

  const detail = l10n.t('Detail');
  showErrorMessage(errorString, detail).then(result => {
    if (result === detail) {
      output.show();
    }
  });
  return;
}
