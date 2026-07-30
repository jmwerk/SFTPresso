# Throwaway OpenSSH server for the SFTP integration suite.
#
# Built here rather than pulled so the pieces the extension depends on are
# pinned and identical on every machine: the sftp subsystem itself, OpenSSH's
# posix-rename extension (used by `useTempFile` + `openSsh`), and a test user
# whose home directory is writable and NOT chrooted (the mode/permission tests
# need real ownership). Alpine is multi-arch, so this builds the same on CI
# (amd64) and on Apple Silicon.
#
# Everything in here is throwaway and test-only. Never reuse it anywhere else.
FROM alpine:3.22

RUN apk add --no-cache openssh openssh-sftp-server

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 2222

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
