"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getLoginPageConfig, saveLoginPageConfig, type LoginPageConfig } from "@/lib/login-page";

export interface LoginPageFormState {
  error?: string;
  success?: boolean;
}

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Must be a hex color like #06080e");
const optionalHex = z.union([hex, z.literal("")]);

const schema = z.object({
  splitLayout: z.boolean(),
  leftPanelEnabled: z.boolean(),
  rightPanelWidth: z.coerce.number().min(360).max(800),
  cardWidth: z.coerce.number().min(280).max(720),
  cardRadius: z.string().min(1).max(20),
  mobileBehavior: z.enum(["stack", "hide-left"]),
  contentAlignment: z.enum(["left", "center"]),
  canvasBg: hex,
  panelBg: hex,
  borderColor: hex,
  ambient: z.boolean(),
  heading: z.string().max(200).optional(),
  subheading: z.string().max(200).optional(),
  buttonRadius: z.string().max(20).optional(),
  buttonHeight: z.string().max(20).optional(),
  showLogo: z.boolean(),
  logoUrl: z.string().max(500).optional(),
  siteName: z.string().min(1).max(120),
  loginTitle: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  leftCanvasEnabled: z.boolean(),
  leftCanvasMode: z.enum(["blank", "content"]),
  leftCanvasBg: optionalHex.optional(),
  leftCanvasAlignment: z.enum(["left", "center"]),
  leftCanvasAmbient: z.boolean(),
  leftHeading: z.string().max(200).optional(),
  leftSubheading: z.string().max(300).optional(),
  leftText: z.string().max(2000).optional(),
  leftImageUrl: z.string().max(500).optional(),
  leftLogoUrl: z.string().max(500).optional(),
});

export async function saveLoginPageConfigAction(
  _prev: LoginPageFormState,
  formData: FormData
): Promise<LoginPageFormState> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);

  const raw = {
    splitLayout: formData.get("splitLayout") === "on",
    leftPanelEnabled: formData.get("leftPanelEnabled") === "on",
    rightPanelWidth: formData.get("rightPanelWidth"),
    cardWidth: formData.get("cardWidth"),
    cardRadius: String(formData.get("cardRadius") ?? "1rem"),
    mobileBehavior: String(formData.get("mobileBehavior") ?? "stack"),
    contentAlignment: String(formData.get("contentAlignment") ?? "center"),
    canvasBg: String(formData.get("canvasBg") ?? "#06080e"),
    panelBg: String(formData.get("panelBg") ?? "#0b0f19"),
    borderColor: String(formData.get("borderColor") ?? "#1e2639"),
    ambient: formData.get("ambient") === "on",
    heading: String(formData.get("heading") ?? ""),
    subheading: String(formData.get("subheading") ?? ""),
    buttonRadius: String(formData.get("buttonRadius") ?? ""),
    buttonHeight: String(formData.get("buttonHeight") ?? ""),
    showLogo: formData.get("showLogo") === "on",
    logoUrl: String(formData.get("logoUrl") ?? ""),
    siteName: String(formData.get("siteName") ?? "Mock Test Series.in"),
    loginTitle: String(formData.get("loginTitle") ?? "Student Login"),
    subtitle: String(formData.get("subtitle") ?? ""),
    leftCanvasEnabled: formData.get("leftCanvasEnabled") === "on",
    leftCanvasMode: String(formData.get("leftCanvasMode") ?? "blank"),
    leftCanvasBg: String(formData.get("leftCanvasBg") ?? ""),
    leftCanvasAlignment: String(formData.get("leftCanvasAlignment") ?? "left"),
    leftCanvasAmbient: formData.get("leftCanvasAmbient") === "on",
    leftHeading: String(formData.get("leftHeading") ?? ""),
    leftSubheading: String(formData.get("leftSubheading") ?? ""),
    leftText: String(formData.get("leftText") ?? ""),
    leftImageUrl: String(formData.get("leftImageUrl") ?? ""),
    leftLogoUrl: String(formData.get("leftLogoUrl") ?? ""),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;

  const existing = await getLoginPageConfig();

  const next: LoginPageConfig = {
    ...existing,
    splitLayout: v.splitLayout,
    leftPanelEnabled: v.leftPanelEnabled,
    rightPanelWidth: v.rightPanelWidth,
    cardWidth: v.cardWidth,
    cardRadius: v.cardRadius,
    mobileBehavior: v.mobileBehavior,
    contentAlignment: v.contentAlignment,
    background: {
      canvas: v.canvasBg,
      panel: v.panelBg,
      border: v.borderColor,
      ambient: v.ambient,
    },
    typography: { heading: v.heading || undefined, subheading: v.subheading || undefined },
    buttons: { radius: v.buttonRadius || undefined, height: v.buttonHeight || undefined },
    branding: {
      showLogo: v.showLogo,
      logoUrl: v.logoUrl || undefined,
      siteName: v.siteName,
      loginTitle: v.loginTitle,
      subtitle: v.subtitle || "",
    },
    leftCanvas: {
      enabled: v.leftCanvasEnabled,
      mode: v.leftCanvasMode,
      backgroundColor: v.leftCanvasBg || undefined,
      contentAlignment: v.leftCanvasAlignment,
      ambient: v.leftCanvasAmbient,
      content: {
        ...existing.leftCanvas.content,
        heading: v.leftHeading || undefined,
        subheading: v.leftSubheading || undefined,
        text: v.leftText || undefined,
        imageUrl: v.leftImageUrl || undefined,
        logoUrl: v.leftLogoUrl || undefined,
      },
    },
  };

  await saveLoginPageConfig(next);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LOGIN_PAGE_DESIGN_SAVED", entityType: "Setting", entityId: "login.page" },
  });

  revalidatePath("/admin/website/login-page");
  revalidatePath("/login");
  return { success: true };
}
