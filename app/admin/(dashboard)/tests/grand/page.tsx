import { permanentRedirect } from "next/navigation";

// Retired: Mock Test is the one canonical admin-created test (scheduling,
// fixed windows and result release live in its editor). Old links and
// bookmarks land on the Mock Test workflow instead of a 404.
export default function Page() {
  permanentRedirect("/admin/tests?tab=mock");
}
