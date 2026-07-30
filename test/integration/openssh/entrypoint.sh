#!/bin/sh
# Provisions the throwaway SSH server the SFTP integration suite connects to:
# fresh host keys, a password-authenticating test user, and — when the host has
# generated one via prepare-keys.sh — an authorized public key for the key-auth
# tests. Runs sshd in the foreground so the container's lifetime is its own.
set -e

USER_NAME="${SSH_USER:-testuser}"
USER_PASSWORD="${SSH_PASSWORD:-testpass}"
USER_HOME="/home/$USER_NAME"
PUBKEY="/pubkey/id_ed25519.pub"

# Host keys are regenerated per container; the tests do not pin fingerprints.
ssh-keygen -A >/dev/null

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "[entrypoint] creating test user $USER_NAME"
  adduser -D -h "$USER_HOME" -s /bin/sh "$USER_NAME"
  printf '%s:%s\n' "$USER_NAME" "$USER_PASSWORD" | chpasswd
fi

mkdir -p "$USER_HOME/.ssh"
if [ -f "$PUBKEY" ]; then
  echo "[entrypoint] installing authorized key from $PUBKEY"
  cp "$PUBKEY" "$USER_HOME/.ssh/authorized_keys"
  chmod 600 "$USER_HOME/.ssh/authorized_keys"
else
  echo "[entrypoint] no $PUBKEY mounted; key auth will be unavailable"
fi
chmod 700 "$USER_HOME/.ssh"
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME"

cat > /etc/ssh/sshd_config <<EOF
Port 2222
PermitRootLogin no
PasswordAuthentication yes
PubkeyAuthentication yes
PermitEmptyPasswords no
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp /usr/lib/ssh/sftp-server
UsePAM no
PrintMotd no
EOF

echo "[entrypoint] starting sshd on 2222"
exec /usr/sbin/sshd -D -e
