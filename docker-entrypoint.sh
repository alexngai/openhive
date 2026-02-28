#!/bin/sh
set -e

DB_PATH="/app/data/openhive.db"
# Pass --database to skip the interactive setup wizard (which waits for stdin
# that doesn't exist in a container). The CLI checks isInitialised() for a
# .openhive-root marker file, and without --database it launches the wizard.
SERVE_CMD="node dist/cli.js serve --database ${DB_PATH}"

# ── Fetch boot-time config from SwarmHub ────────────────────────────
# When running as a managed hive, fetch secrets (OAuth client_secret, etc.)
# from SwarmHub at boot instead of relying on env vars (which are visible
# in plaintext via the Fly Machines API).
if [ -n "$SWARMHUB_API_URL" ] && [ -n "$SWARMHUB_HIVE_TOKEN" ]; then
  echo "[entrypoint] Fetching boot config from SwarmHub..."
  BOOT_CONFIG=$(node -e "
    fetch(process.env.SWARMHUB_API_URL + '/internal/hive/config', {
      headers: { Authorization: 'Bearer ' + process.env.SWARMHUB_HIVE_TOKEN },
      signal: AbortSignal.timeout(10000),
    })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(c => process.stdout.write(JSON.stringify(c)))
    .catch(e => { process.stderr.write('[entrypoint] Config fetch failed: ' + e.message + '\n'); process.exit(1); });
  " 2>&1) || true

  if [ -n "$BOOT_CONFIG" ] && [ "$BOOT_CONFIG" != "" ]; then
    # Extract OAuth credentials from the JSON response
    OAUTH_ID=$(echo "$BOOT_CONFIG" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const c=JSON.parse(d); if(c.oauth) process.stdout.write(c.oauth.client_id||''); } catch{}
      });
    ")
    OAUTH_SECRET=$(echo "$BOOT_CONFIG" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const c=JSON.parse(d); if(c.oauth) process.stdout.write(c.oauth.client_secret||''); } catch{}
      });
    ")

    if [ -n "$OAUTH_SECRET" ]; then
      export SWARMHUB_OAUTH_CLIENT_SECRET="$OAUTH_SECRET"
      echo "[entrypoint] OAuth client secret loaded from SwarmHub"
    fi
    # Update client_id too in case it was rotated
    if [ -n "$OAUTH_ID" ]; then
      export SWARMHUB_OAUTH_CLIENT_ID="$OAUTH_ID"
    fi
  else
    echo "[entrypoint] WARNING: Could not fetch boot config, continuing with env vars"
  fi
fi

# ── Litestream replication ──────────────────────────────────────────
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
    litestream replicate -exec "$SERVE_CMD" -config /tmp/litestream.yml &
    PID=$!
    wait $PID
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
      echo "[entrypoint] WARNING: Litestream exited with code $EXIT_CODE, restarting without replication"
      exec $SERVE_CMD
    fi
  else
    # Standard CLI mode — works for plain S3/GCS URLs without custom endpoints.
    # Restore from backup (best-effort)
    if ! litestream restore -if-replica-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"; then
      echo "[entrypoint] WARNING: Litestream restore failed, starting with fresh database"
    fi

    # Start app through Litestream with signal forwarding.
    trap 'kill -TERM $PID 2>/dev/null' TERM INT
    litestream replicate -exec "$SERVE_CMD" "$DB_PATH" "$LITESTREAM_REPLICA_URL" &
    PID=$!
    wait $PID
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
      echo "[entrypoint] WARNING: Litestream exited with code $EXIT_CODE, restarting without replication"
      exec $SERVE_CMD
    fi
  fi
else
  # No replication configured — start normally (local/self-hosted mode)
  exec $SERVE_CMD
fi
