import { AvailableElsewhere } from "@/components/admin/available-elsewhere";

export const metadata = { title: "Footer — Mock Test Series.in Admin" };

export default function Page() {
  return (
    <AvailableElsewhere
      title="Footer"
      message="Footer content (contact email, location, Instagram, footer links, copyright) is edited on the Footer section of the Homepage Builder, not here."
      linkHref="/admin/website?tab=homepage"
      linkLabel="Go to Homepage → Footer"
    />
  );
}
