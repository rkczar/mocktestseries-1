import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Student login page design settings, stored in the existing `Setting` table
 * under the key `login.page`. Mirrors the "Website/Homepage Builder" pattern
 * (AppearanceConfig / HomepageSection both store their config as JSON); the
 * login page needs no dedicated model. Defaults are defined here so a fresh
 * install gets: split layout, blank left canvas, dark canvas — nothing
 * promotional is ever forced into the left panel.
 */

const SETTING_KEY = "login.page";

export interface LoginLeftCanvasContent {
  logoUrl?: string;
  heading?: string;
  subheading?: string;
  text?: string;
  imageUrl?: string;
  cards?: { title: string; text: string }[];
}

export interface LoginLeftCanvas {
  enabled: boolean;
  mode: "blank" | "content";
  backgroundColor?: string;
  contentAlignment: "left" | "center";
  ambient: boolean;
  content: LoginLeftCanvasContent;
}

export interface LoginBackground {
  canvas: string;
  panel: string;
  border: string;
  ambient: boolean;
}

export interface LoginBranding {
  showLogo: boolean;
  loginTitle: string;
  subtitle: string;
}

export interface LoginPageConfig {
  splitLayout: boolean;
  leftPanelEnabled: boolean;
  rightPanelWidth: number;
  cardWidth: number;
  cardRadius: string;
  mobileBehavior: "stack" | "hide-left";
  contentAlignment: "left" | "center";
  background: LoginBackground;
  typography: { heading?: string; subheading?: string };
  buttons: { radius?: string; height?: string };
  branding: LoginBranding;
  leftCanvas: LoginLeftCanvas;
  updatedAt?: string;
}

export const DEFAULT_LOGIN_PAGE_CONFIG: LoginPageConfig = {
  splitLayout: true,
  leftPanelEnabled: true,
  rightPanelWidth: 520,
  cardWidth: 440,
  cardRadius: "1rem",
  mobileBehavior: "stack",
  contentAlignment: "center",
  background: {
    canvas: "#06080e",
    panel: "#0b0f19",
    border: "#1e2639",
    ambient: false,
  },
  typography: { heading: undefined, subheading: undefined },
  buttons: { radius: undefined, height: undefined },
  branding: {
    showLogo: true,
    loginTitle: "Student Login",
    subtitle: "Sign in to access your test portal",
  },
  leftCanvas: {
    enabled: false,
    mode: "blank",
    backgroundColor: undefined,
    contentAlignment: "left",
    ambient: false,
    content: {},
  },
};

export async function getLoginPageConfig(): Promise<LoginPageConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    if (!row?.value) return DEFAULT_LOGIN_PAGE_CONFIG;
    const saved = row.value as Partial<LoginPageConfig>;
    const merged: LoginPageConfig = {
      ...DEFAULT_LOGIN_PAGE_CONFIG,
      ...saved,
      background: { ...DEFAULT_LOGIN_PAGE_CONFIG.background, ...(saved.background ?? {}) },
      branding: { ...DEFAULT_LOGIN_PAGE_CONFIG.branding, ...(saved.branding ?? {}) },
      typography: { ...(saved.typography ?? {}) },
      buttons: { ...(saved.buttons ?? {}) },
      leftCanvas: {
        ...DEFAULT_LOGIN_PAGE_CONFIG.leftCanvas,
        ...(saved.leftCanvas ?? {}),
        content: { ...(saved.leftCanvas?.content ?? {}) },
      },
    };
    return merged;
  } catch {
    return DEFAULT_LOGIN_PAGE_CONFIG;
  }
}

export async function saveLoginPageConfig(config: LoginPageConfig): Promise<void> {
  const value: LoginPageConfig = { ...config, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: value as unknown as object },
    create: { key: SETTING_KEY, value: value as unknown as object },
  });
}