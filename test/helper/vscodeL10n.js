// vscode.l10n stand-in for unit tests: English source strings, formatted like the real one.
function t(message, ...rest) {
  let args = rest;
  if (typeof message === 'object') {
    args = message.args || [];
    message = message.message;
  }
  const values =
    args.length === 1 && args[0] !== null && typeof args[0] === 'object' ? args[0] : args;
  return message.replace(/\{([^}]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

module.exports = { t, bundle: undefined, uri: undefined };
