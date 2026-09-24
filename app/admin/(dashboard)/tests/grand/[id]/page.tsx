import { permanentRedirect } from "next/navigation";

// Retired with the Grand Test product — see ../page.tsx.
export default function Page() {
  permanentRedirect("/admin/tests?tab=mock");
}
