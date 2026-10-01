import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Platform / Emergency Controls (Admin → System → Platform Controls).
 *
 * One JSON document in the existing `Setting` key-value table
 * (`platform.controls`), the same storage pattern as payments.mode and
 * seo.settings. Each control stores its CONFIGURED value; what the platform
 * actually enforces is the EFFECTIVE state computed by
 * effectivePlatformControls():
 *
 *   effective(X) = configured(X) && !lockdownActive && !maintenanceOn
 *   registrations additionally require effective login (a new account
 *   always signs in straight away, so it would otherwise be orphaned).
 *
 * Emergency Lockdown therefore never overwrites the individual settings:
 * turning it off restores exactly what was configured before. A lockdown
 * duration is a stored server timestamp (`until`) compared on every read,
 * so it survives deploys, PM2 restarts and closed browsers.
 *
 * Enforcement lives at the authoritative server entry points, never in the
 * UI alone: student sign-in providers and registration paths
 * (lib/auth-student.ts, lib/student-lifecycle.ts, app/login/actions.ts),
 * createCheckoutOrder (lib/payments/orders.ts), createAttemptFromQuestions
 * (lib/test-attempt.ts), AI generation (lib/ai-*.ts) and the Maintenance
 * gate in proxy.ts.
 *
 * Failure behaviour: a missing document means "everything open" (today's
 * behaviour, so deploying this never pauses the site). A failed read
 * re-uses the last successfully read state in this worker (so an active
 * lockdown keeps being honoured through a database blip); only a worker
 * that has never read the document falls back to "everything open".
 * Reads are cached per worker for CACHE_TTL_MS; every worker converges on
 * a change within that window.
 */

export const PLATFORM_CONTROLS_KEY = "platform.controls";
const CACHE_TTL_MS = 3_000;

export const PAUSABLE_CONTROLS = ["registrations", "login", "payments", "tests", "ai"] as const;
export type PausableControl = (typeof PAUSABLE_CONTROLS)[number];
export type PlatformControlKey = PausableControl | "maintenance" | "lockdown";

export const MAX_PUBLIC_MESSAGE_LENGTH = 240;
export const MAX_REASON_LENGTH = 500;
export const LOCKDOWN_DURATIONS = ["MANUAL", "30M", "1H", "2H"] as const;
export type LockdownDuration = (typeof LOCKDOWN_DURATIONS)[number];
export const LOCKDOWN_DURATION_MS: Record<LockdownDuration, number | null> = { MANUAL: null, "30M": 30 * 60_000, "1H": 60 * 60_000, "2H": 120 * 60_000 };

export const DEFAULT_PUBLIC_MESSAGES: Record<PausableControl, string> = {
  registrations: "New registrations are temporarily paused. Please try again later.",
  login: "Student login is temporarily paused. Please try again later.",
  payments: "New payments are temporarily paused. Please try again later.",
  tests: "Starting new tests is temporarily paused. Your existing attempts are not affected.",
  ai: "AI explanations are temporarily unavailable.",
};
export const DEFAULT_MAINTENANCE_TITLE = "We'll be back shortly";
export const DEFAULT_MAINTENANCE_MESSAGE = "We're performing scheduled maintenance. Please check back shortly.";

export interface ChangeMeta {
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
}

export interface PausableState extends ChangeMeta {
  open: boolean;
  /** Admin override for the public message; empty = default. */
  message: string;
}

export interface MaintenanceState extends ChangeMeta {
  on: boolean;
  title: string;
  message: string;
  /** Free text, e.g. "around 4:30 PM IST". Never invented by the system. */
  eta: string;
}

export interface LockdownState extends ChangeMeta {
  on: boolean;
  /** ISO time the lockdown ends by itself; null = until manually restored. */
  until: string | null;
}

export type PlatformControlsState = Record<PausableControl, PausableState> & { maintenance: MaintenanceState; lockdown: LockdownState };

const NO_META: ChangeMeta = { updatedAt: null, updatedBy: null, updatedByName: null };

export function defaultPlatformControls(): PlatformControlsState {
  return {
    registrations: { open: true, message: "", ...NO_META },
    login: { open: true, message: "", ...NO_META },
    payments: { open: true, message: "", ...NO_META },
    tests: { open: true, message: "", ...NO_META },
    ai: { open: true, message: "", ...NO_META },
    maintenance: { on: false, title: "", message: "", eta: "", ...NO_META },
    lockdown: { on: false, until: null, ...NO_META },
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

function meta(raw: Record<string, unknown>): ChangeMeta {
  return { updatedAt: iso(raw.updatedAt), updatedBy: str(raw.updatedBy, 64) || null, updatedByName: str(raw.updatedByName, 120) || null };
}

/**
 * Tolerant parse of the stored document. Anything missing or malformed
 * falls back to the default for that field only. A stored `open`/`on` must
 * be an explicit boolean to count — never coerced from strings.
 */
export function parsePlatformControls(raw: unknown): PlatformControlsState {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = defaultPlatformControls();
  for (const key of PAUSABLE_CONTROLS) {
    const r = doc[key] && typeof doc[key] === "object" ? (doc[key] as Record<string, unknown>) : null;
    if (!r) continue;
    out[key] = { open: typeof r.open === "boolean" ? r.open : true, message: str(r.message, MAX_PUBLIC_MESSAGE_LENGTH), ...meta(r) };
  }
  const m = doc.maintenance && typeof doc.maintenance === "object" ? (doc.maintenance as Record<string, unknown>) : null;
  if (m) {
    out.maintenance = { on: m.on === true, title: str(m.title, 120), message: str(m.message, MAX_PUBLIC_MESSAGE_LENGTH), eta: str(m.eta, 120), ...meta(m) };
  }
  const l = doc.lockdown && typeof doc.lockdown === "object" ? (doc.lockdown as Record<string, unknown>) : null;
  if (l) out.lockdown = { on: l.on === true, until: iso(l.until), ...meta(l) };
  return out;
}

export interface EffectivePlatformControls {
  lockdownActive: boolean;
  /** Lockdown was switched on with a duration that has now passed. */
  lockdownExpired: boolean;
  maintenanceOn: boolean;
  registrationsOpen: boolean;
  loginOpen: boolean;
  paymentsOpen: boolean;
  testsOpen: boolean;
  aiOpen: boolean;
  /** LIVE: nothing paused. DEGRADED: something paused. MAINTENANCE / LOCKDOWN: those modes. */
  status: "LIVE" | "DEGRADED" | "MAINTENANCE" | "LOCKDOWN";
}

export function effectivePlatformControls(state: PlatformControlsState, now: Date = new Date()): EffectivePlatformControls {
  const until = state.lockdown.until ? Date.parse(state.lockdown.until) : null;
  const lockdownExpired = state.lockdown.on && until !== null && now.getTime() >= until;
  const lockdownActive = state.lockdown.on && !lockdownExpired;
  const maintenanceOn = state.maintenance.on;
  const gate = (open: boolean) => open && !lockdownActive && !maintenanceOn;
  const loginOpen = gate(state.login.open);
  const eff = {
    lockdownActive,
    lockdownExpired,
    maintenanceOn,
    loginOpen,
    registrationsOpen: gate(state.registrations.open) && loginOpen,
    paymentsOpen: gate(state.payments.open),
    testsOpen: gate(state.tests.open),
    aiOpen: gate(state.ai.open),
  };
  const anyPaused = !(eff.registrationsOpen && eff.loginOpen && eff.paymentsOpen && eff.testsOpen && eff.aiOpen);
  const status = lockdownActive ? "LOCKDOWN" : maintenanceOn ? "MAINTENANCE" : anyPaused ? "DEGRADED" : "LIVE";
  return { ...eff, status };
}

let cache: { at: number; state: PlatformControlsState; version: string } | null = null;
let lastGood: { state: PlatformControlsState; version: string } | null = null;

export function bumpPlatformControlsCache() {
  cache = null;
}

async function readStored(): Promise<{ state: PlatformControlsState; version: string }> {
  const row = await prisma.setting.findUnique({ where: { key: PLATFORM_CONTROLS_KEY } });
  return { state: parsePlatformControls(row?.value), version: row ? row.updatedAt.getTime().toString(36) : "0" };
}

/** Configured state (shared DB, cached per worker for a few seconds). */
export async function getPlatformControls(): Promise<PlatformControlsState> {
  return (await getPlatformControlsWithVersion()).state;
}

/** Same as getPlatformControls plus a version token that changes on every save (for propagation checks). */
export async function getPlatformControlsWithVersion(): Promise<{ state: PlatformControlsState; version: string }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  try {
    const fresh = await readStored();
    cache = { at: Date.now(), ...fresh };
    lastGood = fresh;
    return fresh;
  } catch (error) {
    console.error("[platform-controls] read failed; using last known state", error);
    return lastGood ?? { state: defaultPlatformControls(), version: "unavailable" };
  }
}

export async function getEffectivePlatformControls(): Promise<EffectivePlatformControls> {
  return effectivePlatformControls(await getPlatformControls());
}

/** Thrown by server entry points when an action is paused. `message` is safe to show to students. */
export class PlatformPausedError extends Error {
  constructor(
    public readonly control: PausableControl,
    message: string
  ) {
    super(message);
    this.name = "PlatformPausedError";
  }
}

const EFFECTIVE_KEY: Record<PausableControl, keyof EffectivePlatformControls> = {
  registrations: "registrationsOpen",
  login: "loginOpen",
  payments: "paymentsOpen",
  tests: "testsOpen",
  ai: "aiOpen",
};

/** Public message for a paused control: the admin override, else the default. Maintenance/lockdown use the default. */
export function pausedMessage(state: PlatformControlsState, control: PausableControl): string {
  return state[control].message.trim() || DEFAULT_PUBLIC_MESSAGES[control];
}

export async function isPlatformOpen(control: PausableControl): Promise<boolean> {
  return effectivePlatformControls(await getPlatformControls())[EFFECTIVE_KEY[control]] === true;
}

/** Throws PlatformPausedError when `control` is effectively paused (configured, lockdown or maintenance). */
export async function assertPlatformOpen(control: PausableControl): Promise<void> {
  const state = await getPlatformControls();
  if (effectivePlatformControls(state)[EFFECTIVE_KEY[control]] !== true) {
    throw new PlatformPausedError(control, pausedMessage(state, control));
  }
}
