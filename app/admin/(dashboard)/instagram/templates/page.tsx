import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getStudioSettings } from "@/lib/instagram/config";
import { TEMPLATES } from "@/lib/instagram/templates";
import { MODULE_LABELS, DEFAULT_LAYOUTS, TEMPLATE_KEYS } from "@/lib/instagram/types";

export const metadata = { title: "Templates & Branding — Instagram — Mock Test Series.in Admin" };

/**
 * Admin → Instagram → Templates & Branding. Shows each template rendered with
 * a SYNTHETIC sample question (never a real one) and the live studio
 * settings, so the Follow slide uses the actual configured handle and links.
 */
export default async function InstagramTemplatesPage() {
  const settings = await getStudioSettings();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Branding</CardTitle>
          <CardDescription>Taken from the live website: Geist type, black background, brand green #008209, the MockTestSeries.in wordmark.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 px-5 pb-5 text-sm sm:grid-cols-2" data-testid="branding">
          <div>
            Instagram handle: <span className="font-semibold">{settings.instagramHandle ? `@${settings.instagramHandle}` : "not set"}</span>{" "}
            <Badge variant="neutral">{settings.instagramSource === "footer" ? "from website footer" : settings.instagramSource === "studio" ? "studio setting" : "missing"}</Badge>
          </div>
          <div>
            Telegram: <span className="font-semibold">{settings.telegramUrl || "not set"}</span>{" "}
            <Badge variant="neutral">{settings.telegramSource === "website" ? "from Website → Telegram" : settings.telegramSource === "studio" ? "studio setting" : "missing"}</Badge>
          </div>
          <div>
            Website: <span className="font-semibold">{settings.websiteLabel}</span>
          </div>
          <div>
            Default: <span className="font-semibold">{`${TEMPLATES[settings.defaultTemplate].name}, ${settings.defaultSlideCount} slides`}</span>{" "}
            <Link href="/admin/instagram/settings" className="text-xs underline">
              Change in Settings
            </Link>
          </div>
          <div className="sm:col-span-2 text-xs text-[var(--color-muted-foreground)]">
            {`Default ${settings.defaultSlideCount}-slide order: ${DEFAULT_LAYOUTS[settings.defaultSlideCount].map((m) => MODULE_LABELS[m]).join(" → ")}`}
          </div>
        </CardContent>
      </Card>
      {TEMPLATE_KEYS.map((key) => {
        const t = TEMPLATES[key];
        return (
          <Card key={key} data-testid={`template-${key}`}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2">
                {t.name}
                {key === "midnight" ? <Badge variant="primary">Matches the website</Badge> : null}
                {key === settings.defaultTemplate ? <Badge variant="success">Default</Badge> : null}
              </CardTitle>
              <CardDescription>{t.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-3 overflow-x-auto px-5 pb-5">
              {[0, 1, 2, 3, 4].map((i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={`/api/admin/instagram/template-sample?t=${key}&i=${i}`}
                  alt={`${t.name} sample slide ${i + 1}`}
                  width={216}
                  height={270}
                  loading="lazy"
                  className="h-[270px] w-[216px] shrink-0 rounded-md border border-[var(--color-border)]"
                />
              ))}
            </CardContent>
          </Card>
        );
      })}
      <p className="text-xs text-[var(--color-muted-foreground)]">Sample slides use a made-up example question, not one from the Question Bank.</p>
    </div>
  );
}
