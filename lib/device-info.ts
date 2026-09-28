/**
 * Human-readable device labels from a User-Agent string, for display only
 * ("Samsung Galaxy / Chrome / Android", "Windows PC / Chrome",
 * "iPhone / Safari"). Never used for identity (see lib/device-cookie.ts).
 * When the model can't be determined reliably — modern Chrome sends a
 * reduced UA like "Android 10; K" — the generic category is shown instead
 * of a guess. iPadOS Safari reports itself as a Mac and is labelled as one.
 */

export type DeviceType = "MOBILE" | "TABLET" | "DESKTOP" | "UNKNOWN";

export interface DeviceInfo {
  deviceType: DeviceType;
  /** e.g. "iPhone", "Samsung Galaxy", "Windows PC", "Android Phone". */
  device: string;
  browser: string | null;
  os: string | null;
  displayName: string;
}

const ANDROID_BRANDS: [RegExp, string][] = [
  [/\bSM-[A-Z0-9]+|\bSAMSUNG\b|\bGalaxy\b/i, "Samsung Galaxy"],
  [/\bPixel\b/, "Google Pixel"],
  [/\bRedmi\b|\bPOCO\b|\bXiaomi\b|\bMi \d/i, "Xiaomi"],
  [/\bONEPLUS\b|\bOnePlus\b/, "OnePlus"],
  [/\bRMX\d+/, "realme"],
  [/\bvivo\b|\bV2\d{3}\b/i, "vivo"],
  [/\bOPPO\b|\bCPH\d+/i, "OPPO"],
  [/\bmoto\b|\bMotorola\b/i, "Motorola"],
  [/\bNokia\b/i, "Nokia"],
];

function detectBrowser(ua: string): string | null {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bCriOS\/|\bChrome\//.test(ua)) return "Chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "Safari";
  return null;
}

export function describeUserAgent(uaInput: string | null | undefined): DeviceInfo {
  const ua = (uaInput ?? "").slice(0, 512);
  const browser = detectBrowser(ua);
  let os: string | null = null;
  let device = "Unknown device";
  let deviceType: DeviceType = "UNKNOWN";

  if (/\biPhone\b/.test(ua)) {
    os = "iOS";
    device = "iPhone";
    deviceType = "MOBILE";
  } else if (/\biPad\b/.test(ua)) {
    os = "iPadOS";
    device = "iPad";
    deviceType = "TABLET";
  } else if (/\bAndroid\b/.test(ua)) {
    os = "Android";
    const mobile = /\bMobile\b/.test(ua);
    deviceType = mobile ? "MOBILE" : "TABLET";
    const brand = ANDROID_BRANDS.find(([re]) => re.test(ua));
    device = brand ? brand[1] : mobile ? "Android Phone" : "Android Tablet";
  } else if (/\bCrOS\b/.test(ua)) {
    os = "ChromeOS";
    device = "Chromebook";
    deviceType = "DESKTOP";
  } else if (/\bWindows\b/.test(ua)) {
    os = "Windows";
    device = "Windows PC";
    deviceType = "DESKTOP";
  } else if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) {
    os = "macOS";
    device = "Mac";
    deviceType = "DESKTOP";
  } else if (/\bLinux\b/.test(ua)) {
    os = "Linux";
    device = "Linux PC";
    deviceType = "DESKTOP";
  }

  // "iPhone / Safari" and "Windows PC / Chrome" already name the OS; only
  // Android devices (whose label is a brand) get the OS appended.
  const parts = [device];
  if (browser) parts.push(browser);
  if (os === "Android") parts.push("Android");
  return { deviceType, device, browser, os, displayName: parts.join(" / ") };
}
