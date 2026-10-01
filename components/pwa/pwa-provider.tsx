"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw, WifiOff, X } from "lucide-react";

/**
 * Installable-app (PWA) client runtime, mounted once in app/layout.tsx:
 *   - registers /sw.js (app/sw.js/route.ts) in production builds only;
 *   - keeps the browser's install event (captured before hydration by
 *     PWA_INSTALL_CAPTURE_SCRIPT) for the Install MockTestSeries CTA
 *     (components/pwa/install-app.tsx);
 *   - shows "New version available — Update" when a new deploy's worker is
 *     waiting, and an offline notice while the device has no connection.
 *
 * Test safety beats update speed: the new worker never takes over on its
 * own, and the Update banner is never shown on /student/attempt/* (the Test
 * Player keeps its own save/retry state — ops/TEST-ENGINE.md), so a student
 * mid-test is never reloaded. Nothing here runs on /admin.
 */

type InstallOutcome = "accepted" | "dismissed" | "unavailable";
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
declare global {
  interface Window {
    __mtsInstallEvent?: BeforeInstallPromptEvent | null;
  }
}

/** Runs in <head> before hydration: Chromium may fire beforeinstallprompt before React mounts. */
export const PWA_INSTALL_CAPTURE_SCRIPT = `window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__mtsInstallEvent=e;window.dispatchEvent(new Event("mts:installable"))});window.addEventListener("appinstalled",function(){window.__mtsInstallEvent=null});`;

export type PwaState = {
  /** Running as the installed app (standalone / iOS home-screen). */
  standalone: boolean;
  /** Chromium handed us an install prompt we can trigger from a button. */
  canPrompt: boolean;
  /** iOS/iPadOS: no install prompt API; the CTA shows Add to Home Screen steps. */
  ios: boolean;
  promptInstall: () => Promise<InstallOutcome>;
};

const PwaContext = createContext<PwaState>({ standalone: false, canPrompt: false, ios: false, promptInstall: async () => "unavailable" });
export const usePwa = () => useContext(PwaContext);

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos() {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Browser state read through useSyncExternalStore (server snapshot: nothing shown). */
function listen(target: EventTarget, events: string[]) {
  return (onChange: () => void) => {
    events.forEach((e) => target.addEventListener(e, onChange));
    return () => events.forEach((e) => target.removeEventListener(e, onChange));
  };
}
const subscribeStandalone = (onChange: () => void) => {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const subscribeConnectivity = (onChange: () => void) => listen(window, ["online", "offline"])(onChange);
const subscribeInstallEvent = (onChange: () => void) => listen(window, ["mts:installable", "appinstalled", "mts:install-consumed"])(onChange);
const subscribeNothing = () => () => {};
const serverFalse = () => false;
const serverNull = () => null;

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const inAttempt = pathname.startsWith("/student/attempt/");

  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone, serverFalse);
  const ios = useSyncExternalStore(subscribeNothing, isIos, serverFalse);
  const offline = useSyncExternalStore(subscribeConnectivity, () => !navigator.onLine, serverFalse);
  const installEvent = useSyncExternalStore(subscribeInstallEvent, () => window.__mtsInstallEvent ?? null, serverNull);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const reloadingRef = useRef(false);

  // Service worker: register once (never from Admin), watch for a waiting update.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || isAdmin || !("serviceWorker" in navigator)) return;
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    const sw = navigator.serviceWorker;

    const track = (reg: ServiceWorkerRegistration) => {
      // A waiting worker only matters when an older one controls this page.
      if (reg.waiting && sw.controller) setWaitingWorker(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && sw.controller) setWaitingWorker(reg.waiting ?? installing);
        });
      });
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !registration || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
      lastCheck = Date.now();
      registration.update().catch(() => undefined);
    };
    // Reload only when the student pressed Update — never on a first install's claim().
    const onControllerChange = () => {
      if (!reloadingRef.current) return;
      window.location.reload();
    };

    sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        track(reg);
      })
      .catch(() => undefined);
    sw.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Registration is per page load; navigating into /admin later is harmless (the worker ignores /admin).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    const event = installEvent;
    if (!event) return "unavailable";
    await event.prompt();
    const { outcome } = await event.userChoice;
    // A prompt event can be used once; Chromium fires a fresh one if still installable.
    window.__mtsInstallEvent = null;
    window.dispatchEvent(new Event("mts:install-consumed"));
    return outcome;
  }, [installEvent]);

  const applyUpdate = () => {
    if (!waitingWorker) return;
    reloadingRef.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  };

  const showUpdate = !!waitingWorker && !updateDismissed && !inAttempt && !isAdmin;
  const showOffline = offline && !isAdmin;

  return (
    <PwaContext.Provider value={{ standalone, canPrompt: !!installEvent, ios, promptInstall }}>
      {children}
      {showOffline ? (
        <div role="status" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
          <div className="flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-2 text-xs font-medium text-[var(--color-foreground)] shadow-[var(--shadow-card)]">
            <WifiOff className="h-3.5 w-3.5 text-[var(--color-warning)]" aria-hidden />
            {inAttempt ? "You're offline. Reconnect to keep saving your answers." : "You're offline. Reconnect to continue using MockTestSeries."}
          </div>
        </div>
      ) : null}
      {showUpdate ? (
        <div
          role="status"
          className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="flex w-full max-w-md items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 pl-4 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-card)]">
            <span className="flex-1">New version available</span>
            <button
              type="button"
              onClick={applyUpdate}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--color-action-fill)] px-3 text-xs font-medium text-[var(--color-action-ink)] hover:opacity-90"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Update
            </button>
            <button
              type="button"
              onClick={() => setUpdateDismissed(true)}
              aria-label="Dismiss"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </PwaContext.Provider>
  );
}
