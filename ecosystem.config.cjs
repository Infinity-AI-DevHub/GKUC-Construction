/*
 * PM2 process definition for the production server.
 *
 * One process serves everything: the JSON API under /api and the built frontend from
 * frontend/dist. There is no second process for the interface — the Vite dev server on
 * 3400 is a development tool and must never run on the server.
 *
 * Secrets live in backend/.env, not here, so this file is safe to commit. Anything set
 * below wins over backend/.env, because dotenv fills gaps rather than overriding an
 * environment that is already set.
 *
 *   pm2 start ecosystem.config.cjs --env production
 */
module.exports = {
  apps: [{
    name: 'gkuc-siteops',
    cwd: '/www/wwwroot/siteops/backend',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    /*
     * Single instance, deliberately. The rate limiters and the alert scheduler both hold
     * state in memory, so a second instance would double the alerts and halve the
     * effectiveness of every throttle. Clustering needs shared state first.
     */
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    max_memory_restart: '600M',
    time: true,
    merge_logs: true,
    error_file: '/www/wwwlogs/siteops-error.log',
    out_file: '/www/wwwlogs/siteops-out.log',
    env_production: {
      NODE_ENV: 'production',
      PORT: 4400,
      TRUST_PROXY: 1,
      /*
       * The company works in Sri Lanka. Set here rather than left to the host, so a
       * server in any datacentre reports the same working day the sites do.
       */
      TZ: 'Asia/Colombo'
    }
  }]
};
