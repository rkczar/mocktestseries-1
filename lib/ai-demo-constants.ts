/**
 * Shared between server (lib/ai-settings.ts, lib/homepage-ai-demo.ts) and
 * client (homepage-demo-picker.tsx) code — deliberately has no
 * "server-only" import and no Prisma import, so a client component can pull
 * this constant in without dragging the Prisma/pg server bundle into the
 * browser build.
 */
export const HOMEPAGE_DEMO_MAX = 10;
