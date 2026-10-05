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
| `/media/` | `/var/www/mocktestseries-shared/storage/media/` | immutable, content-addressed rich-question media `/media/q/<aa>/<sha256>.webp` (lib/media-storage.ts) |

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

## Image history safety (fixed in NEET Phase 2)

`TestAttemptQuestion.questionSnapshot` stores image URLs/keys, so a file an
attempt froze must outlive any later edit.

- **Rich media (`/media/`)**: `lib/media-storage.ts` writes immutable,
  content-addressed files `q/<aa>/<sha256>.webp` (hard-link into place, never
  overwritten, verified on reuse). There is no delete. Replacing an image on a
  question creates a NEW file + reference; removing drops the reference only.
  `MediaObject` lists every physical file.
- **Legacy images (`/storage/question-images/`)**: the admin route no longer
  unlinks the old file on replace or remove.
- A future garbage collector must check `QuestionAsset`, legacy `imageUrl`
  columns AND every `TestAttemptQuestion.questionSnapshot` before deleting
  anything. None exists today, by design.
