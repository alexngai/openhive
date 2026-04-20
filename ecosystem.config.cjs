// OpenHive PM2 Ecosystem Configuration
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 stop openhive
//   pm2 restart openhive
//   pm2 logs openhive
//   pm2 monit
//
// Setup auto-start on boot:
//   pm2 startup
//   pm2 save
//
// Note: Using .cjs extension for CommonJS compatibility with ES modules project

module.exports = {
  apps: [{
    name: 'openhive',
    script: './dist/cli.js',
    args: 'serve',
    cwd: __dirname,

    // Environment configuration
    env: {
      NODE_ENV: 'production',
      OPENHIVE_HOST: '0.0.0.0',
      OPENHIVE_PORT: 3000,
      OPENHIVE_DATABASE: './data/openhive.db',
    },

    // Development environment (use with: pm2 start ecosystem.config.cjs --env development)
    env_development: {
      NODE_ENV: 'development',
      OPENHIVE_HOST: 'localhost',
      OPENHIVE_PORT: 3000,
      OPENHIVE_DATABASE: './data/openhive-dev.db',
    },

    // Process configuration
    instances: 1,           // SQLite requires single instance
    exec_mode: 'fork',      // Fork mode (not cluster) for SQLite compatibility
    autorestart: true,      // Auto-restart on crash
    max_restarts: 10,       // Max restarts before stopping
    min_uptime: '10s',      // Min uptime to consider "started"
    restart_delay: 1000,    // Delay between restarts

    // Graceful shutdown
    kill_timeout: 5000,     // Time to wait for graceful shutdown
    wait_ready: false,      // Don't wait for process.send('ready')
    listen_timeout: 10000,  // Time to wait for app to listen

    // Memory management
    max_memory_restart: '256M',  // Restart if memory exceeds this

    // Logging
    log_file: './logs/openhive-combined.log',
    out_file: './logs/openhive-out.log',
    error_file: './logs/openhive-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,       // Merge logs from all instances

    // File watching (disabled in production)
    watch: false,
    ignore_watch: [
      'node_modules',
      'logs',
      'data',
      'uploads',
      '.git',
      '*.log',
    ],

    // Source maps for better error traces
    source_map_support: true,
  }],
};
