import CouponPage from "../[id]/page";

export const metadata = { title: "New Coupon — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default function NewCouponPage() {
  return <CouponPage params={Promise.resolve({ id: "new" })} />;
}
