#!/bin/sh
# Generates the throwaway keypair the SFTP key-auth tests use.
#
# Run before `docker compose up` (npm run test:integration:up does this): the
# public half is bind-mounted into the ssh container as the test user's
# authorized_keys, the private half stays on the host for the client. The keys
# are generated locally and gitignored rather than committed, so no private key
# ever lands in the repository.
set -e

KEY_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/keys"
KEY_FILE="$KEY_DIR/id_ed25519"

mkdir -p "$KEY_DIR"

if [ ! -f "$KEY_FILE" ]; then
  echo "[prepare-keys] generating test keypair at $KEY_FILE"
  ssh-keygen -q -t ed25519 -N '' -C 'sftpresso-integration-test' -f "$KEY_FILE"
fi

chmod 600 "$KEY_FILE"
chmod 644 "$KEY_FILE.pub"
