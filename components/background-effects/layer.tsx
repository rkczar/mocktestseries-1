import type { BackgroundEffectsConfig } from "@/lib/background-effects";
import { BackgroundEffectsRenderer } from "./renderer";
import { BackgroundScopeGate } from "./scope-gate";

/**
 * The site-side mount. Shells call getBackgroundEffectsFor(surface) and
 * render this only when it returns a config, so with Background Effects OFF
 * (or out of scope) no element, style or script is added to the page. The
 * host element must be a stacking context (`isolate`) so the fixed layer
 * paints above its background but behind all of its content.
 */
export function BackgroundEffectsLayer({ config }: { config: BackgroundEffectsConfig }) {
  return (
    <BackgroundScopeGate>
      <BackgroundEffectsRenderer config={config} />
    </BackgroundScopeGate>
  );
}
