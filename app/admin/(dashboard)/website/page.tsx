import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import HomepageBuilderPage from "./homepage/page";
import ContentPage from "./content/page";
import LoginPageDesignPage from "./login-page/page";
import AnnouncementsPage from "./announcements/page";
import NavigationPage from "./navigation/page";
import FooterPage from "./footer/page";
import AppearancePage from "./appearance/page";
import WebsiteDiagramPage from "./diagram/page";

export const metadata = { title: "Website — Mock Test Series.in Admin" };

function WebsiteOverview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Website</CardTitle>
        <CardDescription>
          Homepage, pages &amp; content, navigation, appearance, and the live architecture diagram.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Everything that shapes the public-facing site and the student login experience lives under these tabs.
        </p>
      </CardContent>
    </Card>
  );
}

function PreviewLinkOut() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <CardDescription>Opens the live homepage preview in a new tab.</CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href="/admin/website/homepage/preview"
          target="_blank"
          className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Open Preview
        </Link>
      </CardContent>
    </Card>
  );
}

export default function WebsiteControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Website</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Homepage, content, navigation, appearance, and the site&apos;s live architecture diagram.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <WebsiteOverview /> },
          { value: "homepage", label: "Homepage", content: <HomepageBuilderPage /> },
          { value: "preview", label: "Preview", content: <PreviewLinkOut /> },
          {
            value: "content",
            label: "Pages & Content",
            content: (
              <div className="flex flex-col gap-8">
                <ContentPage />
                <LoginPageDesignPage />
                <AnnouncementsPage />
              </div>
            ),
          },
          {
            value: "navigation",
            label: "Navigation",
            content: (
              <div className="flex flex-col gap-8">
                <NavigationPage />
                <FooterPage />
              </div>
            ),
          },
          { value: "appearance", label: "Appearance", content: <AppearancePage /> },
          { value: "diagram", label: "Website Diagram", content: <WebsiteDiagramPage /> },
        ]}
      />
    </div>
  );
}
