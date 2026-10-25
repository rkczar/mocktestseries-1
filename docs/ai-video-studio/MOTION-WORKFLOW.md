# Motion Workflow Studio

Admin → AI Video Studio → **Motion Workflow Studio** (`/admin/video-studio/motion`).
An additional, independent module next to the AI Video Generator and the AI
Video Editor. It does not replace or change them.

## What was learned from the reference

The public page (go.theonlyworkshop.com/get/motion-workflow, read 2026-10-25)
describes a 7-step workflow for storyboard reels. It links to no GitHub repo,
docs or downloads; its only links are WhatsApp booking links. Nothing was
behind a paywall, and nothing beyond the public page was used.

1. **Pick one style. Only one.** Six locked looks, each for one job (One Take,
   Levels, The Profile, Three Days, Studio Film, Crisp Original). Never mix styles.
2. **Write the script first.** Full spoken sentences, problem in the first
   sentence, three steps, one CTA, ~40 s / <110 words; one idea per sentence,
   because one sentence becomes one frame.
3. **Storyboard frame by frame.** Per frame: the spoken sentence, what is on
   screen (one idea), the one motion, the one highlighted word; safe zone
   (top 14 %, bottom 35 %, 6 % sides of 1080×1920). Fix frames with two ideas;
   change one of two frames that look alike.
4. **Record the voice once.** One generation for the whole script keeps the tone steady. No music under it.
5. **Footage only if the style needs it.**
6. **Build and render.** HTML frames, word timestamps (Whisper) so each word
   appears when spoken, headless Chrome frame capture, FFmpeg join + audio.
7. **Check it like a stranger.** Sound off, sound on, then a second opinion: hard-to-read
   text, words that appear after they are spoken, the first frame that could be cut.

## What was built (independently)

| Reference idea | Here |
| --- | --- |
| Style lock | `lib/video-studio/motion/styles.ts`: 6 styles (Concept Map Journey, Level Up Revision, Clinical Case Story, Time-Course Calendar, Big Sentence Cards, Photo Story) with a fixed layout, motion set, transition and highlight. Changing the style re-locks every frame. |
| Script + storyboard | One paid OpenRouter text request writes both (`buildMotionPrompt`), or the admin writes the script and the storyboard is planned for free (`planStoryboard`). |
| One sentence / one idea / one motion / one highlight | `MotionVisual` per frame (a `VideoScene` row of a `MOTION` job); strict parser; Question Bank questions are filled from the bank only and reveal only the stored answer. |
| Safe zone | `safeZone()`: 65 / 269 / 672 px at 9:16; the brand line and captions sit inside it. |
| Voice once | One OpenRouter speech request for the whole script (not per scene); cached by text + voice. |
| Word timestamps | Optional paid "precise sync": the narration take is transcribed once through OpenRouter; `alignTiming()` maps words to the script (monotonic, multi-token aware) and sets frame boundaries. Free "estimated sync" spreads words over the measured take. |
| HTML → Chrome → FFmpeg | The existing render container (`ops/video-worker/render.mjs`), with two additive options: one continuous narration track and a whitelisted transition type. |
| Check it like a stranger | `lib/video-studio/motion/quality.ts`: automatic checks before anything paid and again on the MP4 (one idea, highlight present, look-alike frames, motion in style, safe-zone text length, glyphs, stored answers only, flagged claims, CTA last, contrast, reading time, question time, words never after they are spoken, sync source, output size/length/audio). |
| Music | Off by default. Sound effects are not offered: no licensed library is configured. |

## Shared vs independent

**Shared (reused, unchanged):** OpenRouter key, AI Engine routing for the
`video_script` feature and its approved models, cost quotes and the ledger
(AiGatewayCall / AiCostQuote), budgets and emergency stop, Voice Studio
approvals, transcription model setting, uploads, media storage and
retention, the worker (lease, Live CBT pause, cancellation), the render
container, fonts, permissions (VIDEO_STUDIO_VIEW / USE), branding, exams,
Question Bank, Skill Library registry, history / cost pages.

**Independent:** job kind `MOTION`; its config, frame model, styles, prompt,
parser, timing/alignment, frame template, QA, worker stages
(`lib/video-studio/motion/pipeline.ts`), job service
(`lib/video-studio/motion/jobs.ts`), Server Actions
(`app/admin/(dashboard)/video-studio/motion/actions.ts`), pages and components.

## Paid steps (each shows its price and needs an explicit confirmation)

1. Script + storyboard — one text request (quote consumed once).
2. Narration — one speech request for the whole script.
3. Precise sync (optional) — one transcription of that narration; skipped (estimated sync instead) if the take turns out longer than the confirmed maximum.

Free: own script, re-planning, frame edits, style/aspect changes, QA,
silent render, re-render with the existing narration (never re-runs a paid step).

## Renderer evaluation: HyperFrames

HyperFrames (heygen-com/hyperframes, npm `hyperframes`, Apache-2.0) also
renders video from HTML. Evaluated from its package metadata and skill docs
(2026-10-25), not installed:

* pre-1.0 (0.8.193, published the same day it was evaluated); compositions pin CLI versions;
* downloads its browser at run time (`@puppeteer/browsers`) and fetches templates (`giget`)
  — conflicts with our `--network none` render container;
* its core idea (seekable HTML timeline → frames → video) is what our container already does.

Recommendation: no engine change. It stays a possible future adapter. Before
any change, run a side-by-side test in an isolated container with network only
for the install step.

## Tests

* `scripts/verify-motion-studio.ts`: pure logic + end-to-end with real renders (mock OpenRouter, loopback only).
* `scripts/motion-render-smoke.ts <style> [aspect]`: render a fixed storyboard in one style, no AI or DB.
* `scripts/verify-motion-editor-ui.mjs`: browser checks (run after `verify-video-studio-ui.mjs`).
