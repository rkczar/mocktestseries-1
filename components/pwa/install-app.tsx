"use client";

import { useState, useSyncExternalStore } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { usePwa } from "@/components/pwa/pwa-provider";

/**
 * "Install MockTestSeries" — shown only where installing genuinely works:
 *   - Chromium (Android / desktop) after the browser fired its install
 *     event: the button opens the browser's own install dialog;
 *   - iOS/iPadOS, which has no install API: the button reveals the
 *     Share → Add to Home Screen steps instead.
 * Hidden when already running as the installed app and on every other
 * browser, so there is never a button that does nothing.
 */

const DISMISS_KEY = "mts-install-dismissed-at";
const DISMISS_DAYS = 30;

let dismissedThisVisit = false;

function dismissedRecently() {
  if (dismissedThisVisit) return true;
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

const DISMISS_EVENT = "mts:install-dismissed";
const subscribeDismiss = (onChange: () => void) => {
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => window.removeEventListener(DISMISS_EVENT, onChange);
};

function useInstallable() {
  const pwa = usePwa();
  return { ...pwa, available: !pwa.standalone && (pwa.canPrompt || pwa.ios) };
}

function IosSteps({ className }: { className?: string }) {
  return (
    <ol className={cn("list-decimal space-y-1 pl-5 text-sm text-[var(--color-muted-foreground)]", className)}>
      <li>
        Tap the <Share className="inline h-3.5 w-3.5 align-[-2px]" aria-label="Share" /> Share button.
      </li>
      <li>
        Choose <span className="font-medium text-[var(--color-foreground)]">Add to Home Screen</span>, then tap Add.
      </li>
    </ol>
  );
}

/** Student Dashboard block ("install-app"). Dismissible for 30 days. */
export function InstallAppCard() {
  const { available, canPrompt, ios, promptInstall } = useInstallable();
  const dismissed = useSyncExternalStore(subscribeDismiss, dismissedRecently, () => true);
  const [showSteps, setShowSteps] = useState(false);

  if (!available || dismissed) return null;

  const dismiss = () => {
    dismissedThisVisit = true;
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Storage unavailable (private mode): hidden for this visit only.
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  };

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
          <Download className="h-4 w-4" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-[var(--color-foreground)]">Install MockTestSeries</p>
          <p className="text-sm text-[var(--color-muted-foreground)]">Open your tests from your home screen or desktop, in their own app window.</p>
          {ios && showSteps ? <IosSteps className="mt-1" /> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 self-end sm:self-center">
        {canPrompt ? (
          <Button size="sm" onClick={() => void promptInstall()}>
            Install
          </Button>
        ) : ios && !showSteps ? (
          <Button size="sm" onClick={() => setShowSteps(true)}>
            How to install
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={dismiss}>
          <X className="h-3.5 w-3.5" aria-hidden /> Not now
        </Button>
      </div>
    </Card>
  );
}

/** Entry in the student mobile menu — shown whenever installing is possible. */
export function InstallAppMenuItem({ onDone }: { onDone?: () => void }) {
  const { available, canPrompt, promptInstall } = useInstallable();
  const [showSteps, setShowSteps] = useState(false);
  if (!available) return null;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          if (canPrompt) {
            void promptInstall().then(() => onDone?.());
          } else {
            setShowSteps((s) => !s);
          }
        }}
        className="flex items-center gap-2 rounded-[var(--radius-button)] px-3 py-2 text-left text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-background)]"
      >
        <Download className="h-4 w-4" aria-hidden /> Install MockTestSeries
      </button>
      {showSteps ? <IosSteps className="px-3 pb-2 pt-1" /> : null}
    </div>
  );
}
