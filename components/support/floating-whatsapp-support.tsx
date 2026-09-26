import { getPublicWhatsAppSupport, type WhatsAppSupportSurface } from "@/lib/whatsapp-support";
import { WhatsAppSupportButton } from "./whatsapp-support-button";

/**
 * The ONE floating WhatsApp Support entry point, mounted on exactly two
 * pages: the homepage (app/page.tsx) and the Student Dashboard. Reads the admin config per request (Admin -> Website
 * -> Footer -> WhatsApp Support) and renders nothing when the feature, the
 * surface, or the number is off/missing/invalid. Only the finished wa.me
 * link and tooltip label reach the client.
 */
export async function FloatingWhatsAppSupport({ surface }: { surface: WhatsAppSupportSurface }) {
  const support = await getPublicWhatsAppSupport(surface);
  if (!support) return null;
  return <WhatsAppSupportButton href={support.href} label={support.label} />;
}
