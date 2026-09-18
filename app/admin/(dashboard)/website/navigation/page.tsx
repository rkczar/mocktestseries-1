import { AvailableElsewhere } from "@/components/admin/available-elsewhere";

export const metadata = { title: "Navigation — Mock Test Series.in Admin" };

export default function Page() {
  return (
    <AvailableElsewhere
      title="Navigation"
      message="Site navigation (nav items, login button) is edited on the Header section of the Homepage Builder, not here."
      linkHref="/admin/website?tab=homepage"
      linkLabel="Go to Homepage → Header"
    />
  );
}
