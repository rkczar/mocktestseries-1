import { AiImporterSubnav } from "@/components/admin/ai-importer/subnav";

/**
 * Admin → AI Question Importer: one section switcher above every page. A
 * preprocessing and verification layer in front of the existing Bulk Import
 * (lib/ai-import/*); access is checked per page and in every action.
 */
export default function AiImporterLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <AiImporterSubnav />
      {children}
    </div>
  );
}
