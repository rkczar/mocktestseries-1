import ProductPage from "../[id]/page";

export const metadata = { title: "New Product — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default function NewProductPage() {
  return <ProductPage params={Promise.resolve({ id: "new" })} />;
}
