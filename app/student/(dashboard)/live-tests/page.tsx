import { permanentRedirect } from "next/navigation";

// Live Tests are retired: fixed-window tests are now Mock Tests (LIVE NOW /
// CLOSED states) listed in Test Series. Old links and announcement CTAs land
// there instead of a 404.
export default function Page() {
  permanentRedirect("/student/test-series");
}
