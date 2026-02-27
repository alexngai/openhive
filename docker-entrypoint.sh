#!/bin/sh
set -e

DB_PATH="/app/data/openhive.db"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  echo "[entrypoint] Litestream replication enabled: $LITESTREAM_REPLICA_URL"

  # Restore from backup if one exists (first boot = no backup, that's OK).
  # If restore fails (bad credentials, corrupt backup), start with a fresh DB
  # rather than crashing the container.
  if ! litestream restore -if-replica-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"; then
    echo "[entrypoint] WARNING: Litestream restore failed, starting with fresh database"
  fi

  # Start the app through Litestream (wraps the process, replicates WAL)
  exec litestream replicate -exec "node dist/cli.js serve" "$DB_PATH" "$LITESTREAM_REPLICA_URL"
else
  # No replication configured — start normally (local/self-hosted mode)
  exec node dist/cli.js serve
fi
