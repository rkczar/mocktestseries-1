import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getStudioSettings } from "@/lib/instagram/config";
import { listPresets } from "@/lib/instagram/presets";
import { TEMPLATES, templatesForMode } from "@/lib/instagram/templates";
import { DESIGN_MODE_LABELS, MODULE_LABELS, DEFAULT_LAYOUTS, modeOfTemplate, type DesignMode } from "@/lib/instagram/types";
import { SetDefaultDesignButton, DeletePresetButton } from "@/components/admin/instagram/design-admin-buttons";

export const metadata = { title: "Design Mode — Instagram — Mock Test Series.in Admin" };

const MODE_TEXT: Record<DesignMode, string> = {
  professional: "Premium medical-education carousels: clean modern type, structured infographics, professional diagrams, elegant tables, minimal clutter.",
  handwritten: "Natural handwritten revision notes: cream notebook paper, handwriting, blue/black ink, red annotations, yellow highlights and hand-drawn arrows and diagrams.",
};

/**
 * Admin → Instagram → Design Mode. Both modes rendered with the same
 * SYNTHETIC sample (7-slide universal carousel), the default design for new
 * posts, and saved presets. Every post can still override its design in the
 * editor; Bulk Studio can mix modes in one batch.
 */
export default async function DesignModePage() {
  const [settings, presets] = await Promise.all([getStudioSettings(), listPresets()]);
  const defaultMode = modeOfTemplate(settings.defaultTemplate);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Default design for new posts</CardTitle>
          <CardDescription>
            {`Currently: ${TEMPLATES[settings.defaultTemplate].name} (${DESIGN_MODE_LABELS[defaultMode]}). Each post can override it, and switching design never changes the medical content.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 text-xs text-[var(--color-muted-foreground)]">
          {`Samples below use the 7-slide universal carousel: ${DEFAULT_LAYOUTS[7].map((m) => MODULE_LABELS[m]).join(" → ")}. They use a made-up example question.`}
        </CardContent>
      </Card>
      {(["professional", "handwritten"] as DesignMode[]).map((mode) => (
        <section key={mode} className="flex flex-col gap-3" data-testid={`mode-section-${mode}`}>
          <div>
            <h2 className="text-base font-semibold">{`Mode ${mode === "handwritten" ? "A" : "B"} — ${DESIGN_MODE_LABELS[mode]}`}</h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">{MODE_TEXT[mode]}</p>
          </div>
          {templatesForMode(mode).map((key) => {
            const t = TEMPLATES[key];
            return (
              <Card key={key} data-testid={`design-${key}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {t.name}
                    {key === settings.defaultTemplate ? <Badge variant="success">Default</Badge> : null}
                    {["midnight", "academic", "clinical", "premium"].includes(key) ? <Badge variant="neutral">Original template</Badge> : null}
                  </CardTitle>
                  <CardDescription>{t.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 px-5 pb-5">
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={`/api/admin/instagram/template-sample?t=${key}&n=7&i=${i}`}
                        alt={`${t.name} sample slide ${i + 1}: ${MODULE_LABELS[DEFAULT_LAYOUTS[7][i]]}`}
                        width={176}
                        height={220}
                        loading="lazy"
                        className="h-[220px] w-[176px] shrink-0 rounded-md border border-[var(--color-border)]"
                      />
                    ))}
                  </div>
                  {key !== settings.defaultTemplate ? <SetDefaultDesignButton template={key} /> : null}
                </CardContent>
              </Card>
            );
          })}
        </section>
      ))}
      <Card data-testid="preset-list">
        <CardHeader className="pb-2">
          <CardTitle>Saved design presets</CardTitle>
          <CardDescription>Create presets in the editor (Design tab → Saved design presets). Applying a preset copies its template, colours, font and text sizes into a post.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-5 pb-5 text-sm">
          {presets.length === 0 ? <p className="text-[var(--color-muted-foreground)]">No saved presets yet.</p> : null}
          {presets.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="flex-1">{`${p.name} · ${TEMPLATES[p.template].name} (${DESIGN_MODE_LABELS[modeOfTemplate(p.template)]})${p.overrides ? " · custom colours/font" : ""}`}</span>
              <DeletePresetButton id={p.id} name={p.name} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
