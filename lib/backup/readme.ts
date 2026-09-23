import type { BackupManifest } from "@/lib/backup/package";

/**
 * README-RESTORE.md generated into every package, specific to that backup
 * (type, SHA, schema). It documents a compatible fresh-VPS restore and is
 * explicit about what must be reconfigured by hand — no blind one-command
 * promise.
 */
export function buildRestoreReadme(m: BackupManifest): string {
  const full = m.backupType !== "DATABASE";
  const sha = m.app.gitSha ?? "(see manifest.json)";
  const L: string[] = [];
  L.push(
    `# MockTestSeries.in — Restore Guide`,
    ``,
    `Backup type: **${m.backupType === "FULL" ? "FULL DISASTER RECOVERY" : m.backupType === "CLEAN" ? "CLEAN PORTABLE" : "DATABASE ONLY — NOT a complete disaster recovery backup"}**  `,
    `Created: ${m.createdAt}  `,
    `Application SHA: ${sha}  `,
    `Schema (latest Prisma migration): ${m.database.latestMigration ?? "unknown"} (${m.database.migrationCount} migrations)  `,
    `PostgreSQL at backup time: ${m.app.postgres} · Node at backup time: ${m.app.node}`,
    ``,
    `## 0. Verify the package first`,
    "```bash",
    `mkdir restore && tar -xf mocktestseries-*.tar -C restore && cd restore`,
    `sha256sum -c checksums.sha256          # every line must say OK`,
    `pg_restore --list database.dump | head  # must list the schema`,
    "```",
    ``,
    `## 1. Prepare a compatible fresh VPS`,
    ...m.restorePrerequisites.map((p) => `- ${p}`),
    "```bash",
    `apt update && apt install -y postgresql nginx certbot python3-certbot-nginx git gnupg rsync`,
    `# Node.js ${m.app.node.replace(/^v/, "").split(".")[0]}.x from NodeSource or nvm, then:`,
    `npm i -g pm2`,
    "```",
    ``,
    `## 2. Recreate the database and restore it`
  );
  L.push(
    "```bash",
    `sudo -u postgres psql -c "CREATE ROLE mocktestseries LOGIN PASSWORD '<new-strong-password>' CREATEDB;"`,
    `sudo -u postgres psql -c "CREATE DATABASE mocktestseries OWNER mocktestseries;"`,
    `PGPASSWORD='<new-strong-password>' pg_restore --no-owner --no-privileges -h 127.0.0.1 -U mocktestseries -d mocktestseries database.dump`,
    "```",
    `The dump already contains the Prisma migration history (\`_prisma_migrations\`), so do **not** run \`prisma db push\`. After deploying the source (step 4), \`npx prisma migrate status\` must report the schema up to date.`,
    ``,
    `Password hashes (argon2) and all encrypted provider credentials are restored byte-for-byte. Existing admin/student password logins keep working. Provider credentials stored in Admin → Settings/Payments/AI were encrypted with the original **AUTH_SECRET** — restore that exact value (step 3) or they must be re-entered.`,
    ``
  );
  if (m.database.excludedTableData.length) {
    L.push(`Clean Portable backup: rows of ${m.database.excludedTableData.map((t) => `\`${t}\``).join(", ")} were intentionally omitted (disposable logs/temporary state; schema is present).`, ``);
  }
  if (full) {
    L.push(
      `## 3. Environment`,
      m.secrets.included
        ? [
            "```bash",
            `gpg --decrypt secrets.env.gpg > /var/www/mocktestseries-shared/.env   # asks for the Backup Recovery Passphrase`,
            `chmod 600 /var/www/mocktestseries-shared/.env`,
            "```",
            `Then edit \`DATABASE_URL\` to use the new database password from step 2. Keep \`AUTH_SECRET\` unchanged.`,
          ].join("\n")
        : `This backup contains **no secrets**. Start from \`portable-config/env.template\` and set: ${m.secrets.variableNames.join(", ") || "(see template)"}. A new AUTH_SECRET means credentials stored in Admin settings must be re-entered and all users re-login.`,
      ``,
      `## 4. Application source and build`,
      "```bash",
      `mkdir -p /var/www/mocktestseries-releases/${sha} /var/www/mocktestseries-shared`,
      `tar -xzf source.tar.gz -C /tmp && cp -a /tmp/mocktestseries/. /var/www/mocktestseries-releases/${sha}/`,
      `cd /var/www/mocktestseries-releases/${sha}`,
      `ln -sfn /var/www/mocktestseries-shared/.env .env`,
      `npm ci && npx prisma generate && npx prisma migrate status && npm run build`,
      `ln -sfn /var/www/mocktestseries-shared/storage public/storage`,
      `ln -sfn /var/www/mocktestseries-releases/${sha} /var/www/mocktestseries-current`,
      "```",
      ``,
      `## 5. Persistent files`,
      "```bash",
      ...m.persistentAssets.map((a) =>
        a.key === "shared-storage"
          ? `tar -xzf assets-shared-storage.tar.gz -C /var/www/mocktestseries-shared/    # ${a.fileCount} files`
          : `mkdir -p /var/lib/mocktestseries && tar -xzf assets-${a.key}.tar.gz -C /var/lib/mocktestseries/    # ${a.fileCount} files`
      ),
      "```",
      ``,
      `## 6. Process manager, web server, backups`,
      "```bash",
      `cd /var/www/mocktestseries-current && pm2 start node_modules/next/dist/bin/next --name mocktestseries -i 2 -- start -p 3002 -H 127.0.0.1`,
      `pm2 save && pm2 startup`,
      `cp portable-config/nginx-mocktestseries.in.conf /etc/nginx/sites-available/mocktestseries.in   # edit server_name if the domain changes`,
      `ln -s /etc/nginx/sites-available/mocktestseries.in /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`,
      `certbot --nginx -d <domain> -d www.<domain>`,
      `cp portable-config/mocktestseries-backup-*.sh /usr/local/bin/ && chmod 700 /usr/local/bin/mocktestseries-backup-*.sh`,
      `cp portable-config/cron-mocktestseries-backups /etc/cron.d/mocktestseries-backups`,
      "```",
      ``,
      `## 7. Health check`,
      `- \`curl -I https://<domain>/\` → 200, \`pm2 list\` → online`,
      `- Admin login works with existing credentials; Question Bank, Test Series, Payments pages show data`,
      `- Admin → Backup → Verify this package again from the new server`,
      ``
    );
  } else {
    L.push(`## 3. This is a database-only backup`, `Source code, persistent files and secrets are NOT included. Deploy the application from git at SHA ${sha} and restore persistent files from another backup.`, ``);
  }
  L.push(
    `## Manual reconfiguration always required (external / infrastructure)`,
    `- DNS A/AAAA records → new VPS IP`,
    `- TLS certificates (certbot) and nginx \`server_name\``,
    `- Google OAuth: authorized redirect URI \`https://<domain>/api/student-auth/callback/google\``,
    `- MSG91: sender ID/templates, IP allowlist if enabled`,
    `- AI providers (Gemini/OpenAI): API key IP/referrer restrictions`,
    `- Razorpay: webhook URL \`https://<domain>/api/webhooks/razorpay\` (same webhook secret), dashboard settings`,
    `- Firewall (ufw: 22, 80, 443), SSH keys, OS users, PostgreSQL tuning`,
    ``,
    `## Domain change checklist (only if the domain changes)`,
    `Do not search-and-replace the database dump. Change only:`,
    `1. \`NEXTAUTH_URL\` in .env`,
    `2. Admin → SEO / site URL settings and Website Builder links that hard-code the old domain`,
    `3. nginx \`server_name\` + certbot certificate`,
    `4. Google OAuth redirect URI, Razorpay webhook URL, any provider allowlists`,
    `5. Re-submit sitemap (\`/sitemap.xml\`) in search consoles`,
    ``,
    `## Component inventory`,
    ...m.inventory.map((i) => `- **${i.status}** — ${i.item} (${i.note})`),
    ``
  );
  return L.join("\n");
}
