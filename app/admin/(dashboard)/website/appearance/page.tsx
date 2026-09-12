import { getAppearance } from "@/lib/appearance";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AppearanceForm } from "./appearance-form";

export const metadata = { title: "Appearance — Mock Test Series.in Admin" };

export default async function AppearancePage() {
  const appearance = await getAppearance();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Appearance</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Controls the global design system used across the public website, student experience, and this Admin
          Panel. Day / Night / Eye-Saver mode is a separate per-viewer toggle in the header — this page sets the
          brand tokens underneath all three.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Design Tokens</CardTitle>
          <CardDescription>Changes apply immediately, no deployment required.</CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceForm appearance={appearance} />
        </CardContent>
      </Card>
    </div>
  );
}
