#!/bin/sh
set -e

DB_PATH="/app/data/openhive.db"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  echo "[entrypoint] Litestream replication enabled: $LITESTREAM_REPLICA_URL"

  # If a custom S3 endpoint is configured, generate a litestream config file.
  # Litestream CLI mode (replicate <db> <url>) does NOT support custom endpoints
  # via env vars or URL query params — only via YAML config.
  if [ -n "$LITESTREAM_S3_ENDPOINT" ]; then
    BUCKET=$(echo "$LITESTREAM_REPLICA_URL" | sed 's|s3://\([^/]*\)/.*|\1|')
    REPLICA_PATH=$(echo "$LITESTREAM_REPLICA_URL" | sed 's|s3://[^/]*/\([^?]*\).*|\1|')
    REGION="${AWS_REGION:-us-east-1}"

    cat > /tmp/litestream.yml <<YAML
dbs:
  - path: ${DB_PATH}
    replicas:
      - type: s3
        bucket: ${BUCKET}
        path: ${REPLICA_PATH}
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        region: ${REGION}
        force-path-style: true
YAML

    echo "[entrypoint] Using config mode (endpoint: $LITESTREAM_S3_ENDPOINT, region: $REGION)"

    # Restore from backup (best-effort)
    if ! litestream restore -if-replica-exists -config /tmp/litestream.yml "$DB_PATH"; then
      echo "[entrypoint] WARNING: Litestream restore failed, starting with fresh database"
    fi

    # Start app through Litestream with signal forwarding.
    # If Litestream fails to start, fall back to running without replication.
    trap 'kill -TERM $PID 2>/dev/null' TERM INT
    litestream replicate -exec "node dist/cli.js serve" -config /tmp/litestream.yml &
    PID=$!
    wait $PID
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
      echo "[entrypoint] WARNING: Litestream exited with code $EXIT_CODE, restarting without replication"
      exec node dist/cli.js serve
    fi
  else
    # Standard CLI mode — works for plain S3/GCS URLs without custom endpoints.
    # Restore from backup (best-effort)
    if ! litestream restore -if-replica-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"; then
      echo "[entrypoint] WARNING: Litestream restore failed, starting with fresh database"
    fi

    # Start app through Litestream with signal forwarding.
    trap 'kill -TERM $PID 2>/dev/null' TERM INT
    litestream replicate -exec "node dist/cli.js serve" "$DB_PATH" "$LITESTREAM_REPLICA_URL" &
    PID=$!
    wait $PID
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
      echo "[entrypoint] WARNING: Litestream exited with code $EXIT_CODE, restarting without replication"
      exec node dist/cli.js serve
    fi
  fi
else
  # No replication configured — start normally (local/self-hosted mode)
  exec node dist/cli.js serve
fi
