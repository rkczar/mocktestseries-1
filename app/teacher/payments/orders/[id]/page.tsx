import Link from "next/link";
import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { teacherOrder } from "@/lib/teacher/payments";
import { OrderDetailView } from "@/components/admin/payment-order-detail";

export const metadata = { title: "Transaction — Teacher Portal" };
export const dynamic = "force-dynamic";

/** One transaction of the teacher's exams (read-only, no gateway ids); any other id is 404. */
export default async function TeacherOrder({ params }: { params: Promise<{ id: string }> }) {
  const scope = await requireTeacherPage();
  const { id } = await params;
  const { order, hooks } = await inScopeOr404(() => teacherOrder(scope, id));
  return (
    <div className="flex flex-col gap-6">
      <Link href="/teacher/payments?tab=orders" className="text-sm underline">← Transactions</Link>
      <OrderDetailView order={order} hooks={hooks} teacher studentHref={(sid) => `/teacher/students/${sid}`} />
    </div>
  );
}
