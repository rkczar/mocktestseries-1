# nginx — media serving

The production site config (`/etc/nginx/sites-available/mocktestseries.in`) is
not tracked in this repo. This folder tracks the **media** part of it, added
in NEET Phase 0 (2026-10-05).

## Why

`next start` indexes `public/` once at boot
(`next/dist/server/lib/router-utils/filesystem.js`). Question/option images
live in the shared storage that `public/storage` symlinks to, so an image
uploaded after the server started returned **404 until the next PM2
restart/deploy**. This was confirmed on a scratch server: a file present at
start returned 200, a file added afterwards returned 404, and it returned 200
again after a restart. Next also served `public/` with `max-age=0` through
Node, so every image request went through Node.

nginx now serves media directly from the shared persistent storage. It never
serves from a release directory.

| Path | Directory | Use |
|---|---|---|
| `/storage/question-images/` | `/var/www/mocktestseries-shared/storage/question-images/` | today's `Question.imageUrl` / `QuestionOption.imageUrl` URLs (random-UUID names) |
| `/media/` | `/var/www/mocktestseries-shared/storage/media/` | reserved for the future immutable, content-addressed assets (e.g. `/media/q/<sha256>.webp`) |

`/storage/test-resources/` is deliberately **not** included. Paper and
Solution PDFs stay behind Next (`proxy.ts` limits them to admins, and students
download them through the access-checked API route).

Rules, from `mocktestseries-media.conf`:
- Only `webp`, `png`, `jpg`/`jpeg` and `avif` are served. Every other
  extension, SVG, dot-files, directories and anything missing returns 404 and
  never reaches Next.
- Only GET and HEAD are allowed.
- Success responses get `Cache-Control: public, max-age=31536000, immutable`.
  Filenames are unique and never rewritten.
- The server-level security headers are repeated, plus HSTS.

## Site config (inside the `server_name mocktestseries.in` HTTPS block, before `location /`)

```nginx
    location ^~ /storage/question-images/ {
        alias /var/www/mocktestseries-shared/storage/question-images/;
        include /etc/nginx/snippets/mocktestseries-media.conf;
    }

    location ^~ /media/ {
        alias /var/www/mocktestseries-shared/storage/media/;
        include /etc/nginx/snippets/mocktestseries-media.conf;
    }
```

## Install / rollback

```bash
cp /etc/nginx/sites-available/mocktestseries.in /etc/nginx/sites-available/mocktestseries.in.bak-<stamp>   # rollback copy
install -m 644 ops/nginx/mocktestseries-media.conf /etc/nginx/snippets/mocktestseries-media.conf
# add the two location blocks above, then:
nginx -t && systemctl reload nginx

# Rollback: restore the .bak copy, then
nginx -t && systemctl reload nginx
```

## Image history safety (Phase 2 must fix)

`TestAttemptQuestion.questionSnapshot` stores only the image **URL**.
`app/api/admin/questions/images/route.ts` currently unlinks the old file when an
image is replaced (`previousUrl`) or removed (DELETE). Any submitted attempt
whose snapshot points at that file then shows a broken image in Review
forever.

No production question has an image yet, so nothing is affected today. Phase 2
replaces this with immutable, content-addressed assets: replace = a new file,
and a file is garbage-collected only when no question and no snapshot
references it. Do not add any new code path that deletes or overwrites a media
file before then.
