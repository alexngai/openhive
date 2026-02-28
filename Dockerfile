# OpenHive Dockerfile
# Multi-stage build for minimal production image
#
# Build:  docker build -t openhive .
# Run:    docker run -d -p 3000:3000 -v openhive-data:/app/data openhive

# =============================================================================
# Stage 1: Builder - Install dependencies and build the application
# =============================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, sharp, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
# Delete lockfile to force fresh resolution of platform-specific optional deps
# (macOS-generated lockfile omits @rollup/rollup-linux-x64-gnu)
RUN rm -f package-lock.json && npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove devDependencies — use prune (not ci) to preserve platform-specific
# optional deps like @img/sharp-linux-x64 that npm ci would re-resolve away
RUN npm prune --omit=dev && npm cache clean --force

# =============================================================================
# Stage 2: Production - Minimal runtime image
# =============================================================================
FROM node:20-bookworm-slim AS production

WORKDIR /app

# Install runtime dependencies only
# libvips is needed for sharp image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Litestream for SQLite WAL replication to S3/GCS
ARG TARGETARCH
RUN wget -q "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${TARGETARCH:-amd64}.deb" -O /tmp/litestream.deb \
    && dpkg -i /tmp/litestream.deb \
    && rm /tmp/litestream.deb

# Create non-root user for security
RUN groupadd -r openhive && useradd -r -g openhive openhive

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy entrypoint script (handles Litestream restore + replicate)
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

# Create data directories with correct ownership
RUN chmod +x /app/docker-entrypoint.sh && \
    mkdir -p /app/data /app/uploads && \
    chown -R openhive:openhive /app

# Switch to non-root user
USER openhive

# Environment defaults
ENV NODE_ENV=production \
    OPENHIVE_HOST=0.0.0.0 \
    OPENHIVE_PORT=3000 \
    OPENHIVE_DATABASE=/app/data/openhive.db

# Expose the default port
EXPOSE 3000

# Health check - verify the server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start via entrypoint (handles Litestream if configured, else starts normally)
CMD ["/app/docker-entrypoint.sh"]
