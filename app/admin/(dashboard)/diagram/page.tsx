import type { Metadata } from "next";

import { DiagramDashboard } from "@/components/diagram/DiagramDashboard";
import { getDiagramSnapshot } from "@/lib/diagram/snapshot";

export const metadata: Metadata = { title: "Website Diagram · Admin", robots: { index: false, follow: false } };

export default async function WebsiteDiagramPage() {
  const graph = await getDiagramSnapshot();
  return <DiagramDashboard initialGraph={graph} />;
}
