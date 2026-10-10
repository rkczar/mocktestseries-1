/** Test helper: open or pause Platform Controls → AI Services directly in the (scratch) DB. */
import { prisma } from "@/lib/prisma";
import { PLATFORM_CONTROLS_KEY, bumpPlatformControlsCache, defaultPlatformControls, parsePlatformControls } from "@/lib/platform-controls";

export async function savePlatformControlsForTest(aiOpen: boolean) {
  const row = await prisma.setting.findUnique({ where: { key: PLATFORM_CONTROLS_KEY } });
  const state = row ? parsePlatformControls(row.value) : defaultPlatformControls();
  state.ai = { ...state.ai, open: aiOpen };
  await prisma.setting.upsert({ where: { key: PLATFORM_CONTROLS_KEY }, update: { value: state as object }, create: { key: PLATFORM_CONTROLS_KEY, value: state as object } });
  bumpPlatformControlsCache();
}
