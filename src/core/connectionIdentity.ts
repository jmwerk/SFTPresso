import { createHash } from 'crypto';

/**
 * Identity of a pooled remote connection.
 *
 * The previous implementation joined the option values together
 * (`Object.keys(o).map(k => o[k]).join('')`), which collided in ways that could
 * route a transfer to the wrong server: object-valued options (`hop`,
 * `algorithms`, `secureOptions`) all stringify to "[object Object]", so two
 * configs reaching the same host through different bastions produced the same
 * key; without separators `{host:'foo',username:'bar'}` matched
 * `{host:'foob',username:'ar'}`; and the result depended on key insertion order,
 * so the same remote written two ways opened two connections.
 *
 * Instead we serialize the options canonically — keys sorted, values tagged with
 * their type, strings length-prefixed so no concatenation is ambiguous — and
 * hash that. Secrets still take part in the identity (a changed password must
 * invalidate the pooled connection) but are no longer recoverable from the key.
 */

const CYCLE = 'cycle';

function tagString(value: string): string {
  // length prefix: `s:3:abc` can never be confused with `s:2:ab` + `s:1:c`
  return `s:${value.length}:${value}`;
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'undefined':
      return 'undef';
    case 'boolean':
      return `b:${value}`;
    case 'number':
    case 'bigint':
      return `n:${value}`;
    case 'string':
      return tagString(value);
    case 'symbol':
    case 'function':
      // keys holding these are dropped before we get here; be defensive anyway
      return 'fn';
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    return CYCLE;
  }
  seen.add(object);

  if (Buffer.isBuffer(object)) {
    return `x:${object.toString('base64')}`;
  }

  if (Array.isArray(object)) {
    // order matters: hop: [A, B] is not hop: [B, A]
    return `a[${object.map(item => canonicalize(item, seen)).join(',')}]`;
  }

  return canonicalizeObject(object as Record<string, unknown>, seen);
}

function canonicalizeObject(
  option: Record<string, unknown>,
  seen: WeakSet<object>
): string {
  const parts = Object.keys(option)
    .filter(key => {
      const value = option[key];
      // an absent option and one explicitly set to undefined are the same
      // connection; callbacks (the injected `debug`) never are part of identity
      return value !== undefined && typeof value !== 'function';
    })
    .sort()
    .map(key => `${tagString(key)}=${canonicalize(option[key], seen)}`);

  return `o{${parts.join(',')}}`;
}

// Readable prefix, matching credentialStore's connectionToken() format, so a
// logged identity is recognizable. Never includes the password.
function describeRemote(option: Record<string, any>): string {
  const protocol = typeof option.protocol === 'string' ? option.protocol : 'sftp';
  const port =
    option.port !== undefined ? option.port : protocol === 'ftp' ? 21 : 22;
  const username = option.username !== undefined ? option.username : '';
  const host = option.host !== undefined ? option.host : '';
  return `${protocol}://${username}@${host}:${port}`;
}

export function connectionIdentity(option: Record<string, any>): string {
  const canonical = canonicalizeObject(option || {}, new WeakSet<object>());
  const digest = createHash('sha256')
    .update(canonical)
    .digest('hex');

  return `${describeRemote(option || {})}#${digest}`;
}

export default connectionIdentity;
