# AI Video Studio — third-party material

Nothing below is copied code. Ideas from public material were re-implemented
in this codebase; bundled files keep their own licences.

## Ideas adapted (no code or data copied)

| Source | Licence | What was adapted | Where |
| --- | --- | --- | --- |
| charlie947/social-media-skills (reels-scripting) | MIT | hook-first structure, one idea per Reel, on-screen text as its own track | `lib/video-studio/skills.ts` (Generator Skills) |
| Jakeschincariol/instagram-agent-skill (ig-reel / ig-human) | MIT | two key points, "never fabricate", human tone | `lib/video-studio/skills.ts` |
| "Motion Graphics Workflow" guide, The Only Workshop — go.theonlyworkshop.com/get/motion-workflow (public page, read 2026-10-25) | no licence stated; public web page | the publicly described workflow only: one style per reel, script first, one sentence = one frame (sentence / on-screen idea / one motion / one highlighted word), Instagram safe zone (top 14 %, bottom 35 %, 6 % sides), one narration take, word timestamps so words appear when spoken, HTML frames captured by headless Chrome + FFmpeg, "check it like a stranger" | `lib/video-studio/motion/*` — see MOTION-WORKFLOW.md |

From the Motion Graphics Workflow page, no prompt text, artwork, frames,
example scripts or brand elements were reproduced. Its six style names are
credited ("Idea: …") next to our own differently named, medically adapted styles.

## Bundled files

| File | Licence |
| --- | --- |
| `public/video-studio/fonts/Geist-*.ttf` | SIL OFL 1.1 (Vercel) |
| `public/video-studio/fonts/NotoSansDevanagari-*.ttf` | SIL OFL 1.1 (Noto Project) |
| `public/video-studio/fonts/Kalam-*.ttf` | SIL OFL 1.1 (Indian Type Foundry) |
| `public/video-studio/fonts/LiberationSans-*.ttf` | SIL OFL 1.1 (Red Hat) |

## Render container (`ops/video-worker/Dockerfile`, built locally, not distributed)

| Component | Licence | Note |
| --- | --- | --- |
| node:24 bookworm-slim | MIT (Node) / Debian | base image |
| Chromium (Debian package) | BSD-3 and others | frame drawing |
| FFmpeg (Debian package, with libx264) | GPL-2.0+ build | run as a separate program inside the container; no linking into the app; the image is not distributed |
| playwright-core 1.62.1 | Apache-2.0 | drives Chromium inside the container |

## Evaluated, not used

| Tool | Licence | Decision |
| --- | --- | --- |
| Robust Video Matting (background removal) | GPL-3.0 | not used (copyleft + run-time downloads) |
| HyperFrames (heygen-com/hyperframes, npm `hyperframes` 0.8.x) | Apache-2.0 | optional adapter, not installed — see MOTION-WORKFLOW.md § Renderer evaluation |
