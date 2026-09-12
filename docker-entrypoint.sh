#!/bin/sh
set -e

DATA_DIR="${RETENTION_DATA_DIR:-/data}"
SOCKET="${DOCKER_SOCKET_PATH:-/var/run/docker.sock}"

# The dashboard reads Docker's /system/df to report real volume sizes. The socket's
# group id differs between hosts, so it is resolved at start-up rather than baked
# into the image. Everything else still works without the socket; volume sizes
# simply show as unavailable.
if [ -S "$SOCKET" ]; then
  SOCKET_GID="$(stat -c '%g' "$SOCKET" 2>/dev/null || true)"
  if [ -n "$SOCKET_GID" ]; then
    if ! getent group "$SOCKET_GID" >/dev/null 2>&1; then
      addgroup -g "$SOCKET_GID" dockersock >/dev/null 2>&1 || true
    fi
    GROUP_NAME="$(getent group "$SOCKET_GID" | cut -d: -f1)"
    if [ -n "$GROUP_NAME" ]; then
      addgroup retention "$GROUP_NAME" >/dev/null 2>&1 || true
    fi
  fi
fi

# Data directories bind-mounted for size reporting belong to the uid of the
# service that owns them (ClickHouse 101:101 with a 0750 dir, MinIO, ...). Join
# each one's group so the read-only walk can actually read them. Directories with
# no group access at all (Postgres uses 0700) stay unreadable; the dashboard
# reports those as a lower bound rather than pretending the number is complete.
if [ -n "$RETENTION_DISK_PATHS" ]; then
  echo "$RETENTION_DISK_PATHS" | tr ',' '\n' | while IFS= read -r ENTRY; do
    DIR="${ENTRY#*=}"
    DIR="$(echo "$DIR" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -d "$DIR" ] || continue
    DIR_GID="$(stat -c '%g' "$DIR" 2>/dev/null || true)"
    [ -n "$DIR_GID" ] && [ "$DIR_GID" != "0" ] || continue
    getent group "$DIR_GID" >/dev/null 2>&1 || addgroup -g "$DIR_GID" "datadir$DIR_GID" >/dev/null 2>&1 || true
    GROUP_NAME="$(getent group "$DIR_GID" | cut -d: -f1)"
    [ -n "$GROUP_NAME" ] && addgroup retention "$GROUP_NAME" >/dev/null 2>&1 || true
  done
fi

mkdir -p "$DATA_DIR"
chown -R retention:retention "$DATA_DIR" 2>/dev/null || true

# Drop privileges when we can; if the container was already started as a non-root
# user, su-exec is unnecessary and would fail.
if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1; then
  exec su-exec retention "$@"
fi

exec "$@"
