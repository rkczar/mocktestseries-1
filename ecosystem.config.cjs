// PM2 process definition for the production Next.js server.
// Runs "next start" (never "next dev") against the build produced by `npm run build`.
//
// cwd is a fixed path, not __dirname: it points at the "current" symlink that deploy.sh
// repoints to a new release worktree on each deploy, so `pm2 reload` picks up new code without
// this file needing to change. Cluster mode (2 instances) is what makes `pm2 reload` actually
// zero-downtime — fork mode with a single instance stops the old process before starting the
// new one, which fork mode's own "reload" cannot avoid.
module.exports = {
  apps: [
    {
      name: "mocktestseries",
      cwd: "/var/www/mocktestseries-current",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3002 -H 127.0.0.1",
      instances: 2,
      exec_mode: "cluster",
      autorestart: true,
      max_memory_restart: "500M",
      wait_ready: false,
      listen_timeout: 15000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
        PORT: "3002",
      },
      out_file: "/var/log/mocktestseries/out.log",
      error_file: "/var/log/mocktestseries/error.log",
      time: true,
    },
  ],
};
