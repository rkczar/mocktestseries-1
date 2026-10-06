// PM2 definition of the production app (source of truth since 2026-10-06; before
// that the process existed only in ~/.pm2/dump.pm2). Apply with:
//   pm2 start ops/pm2/ecosystem.config.cjs --only mocktestseries   (first time / after delete)
//   pm2 save
// The deploy script keeps using `pm2 reload mocktestseries` (zero-downtime).
//
// Live CBT capacity (2026-10-06): workers were killed at max_memory_restart
// 500 MB (61 restarts in 6 days, each dropping in-flight saves/submits) while
// V8's default heap limit on this 8 GB host is ~2.2 GB, so V8 never had a
// reason to collect before PM2 killed the process. --max-old-space-size=768
// makes V8 collect early; max_memory_restart 1200M remains a backstop only.
// 2 workers × ≤1.2 GB fits comfortably in the ~5.8 GB available RAM.
module.exports = {
  apps: [
    {
      name: "mocktestseries",
      cwd: "/var/www/mocktestseries-current",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3002 -H 127.0.0.1",
      exec_mode: "cluster",
      instances: 2,
      node_args: "--max-old-space-size=768",
      max_memory_restart: "1200M",
      kill_timeout: 5000,
      listen_timeout: 15000,
    },
  ],
};
