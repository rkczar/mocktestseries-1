import type { Product } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { paiseToRupeeString } from "@/lib/payments/money";
import { PRODUCT_TYPE_LABELS } from "@/lib/payments/product-links";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm } from "./action-form";
import { saveProductAction } from "../actions";

const toLocal = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) : "");

function F({ label, name, children, hint }: { label: string; name: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`p-${name}`}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

/**
 * Product/pricing editor. All price math is re-validated server-side
 * (validatePricingConfig) — this form only collects rupee strings.
 */
export async function ProductForm({ product, readOnly }: { product: Product | null; readOnly: boolean }) {
  const [exams, series, mocks, grands, lives] = await Promise.all([
    prisma.exam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.testSeries.findMany({ select: { id: true, name: true, exam: { select: { name: true } } }, orderBy: { name: "asc" } }),
    prisma.mockTest.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, title: true, exam: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
    prisma.grandTest.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, title: true, exam: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.liveTest.findMany({ where: { status: { not: "CANCELLED" } }, select: { id: true, title: true, exam: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 300 }),
  ]);
  const p = product;
  return (
    <ActionForm action={saveProductAction} submitLabel={p ? "Save product" : "Create product"} readOnly={readOnly} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <F label="Name" name="name">
        <Input id="p-name" name="name" defaultValue={p?.name ?? ""} required maxLength={150} />
      </F>
      <F label="Code (URL slug)" name="code" hint="Lowercase, e.g. ruhs-full-2026. Used in /student/checkout/<code>.">
        <Input id="p-code" name="code" defaultValue={p?.code ?? ""} required pattern="[a-z0-9][a-z0-9-]{2,63}" />
      </F>
      <div className="md:col-span-2">
        <F label="Description" name="description">
          <Textarea id="p-description" name="description" defaultValue={p?.description ?? ""} rows={3} maxLength={2000} />
        </F>
      </div>
      <F label="Product type" name="productType" hint="What kind of content this unlocks.">
        <SelectNative id="p-productType" name="productType" defaultValue={p?.productType ?? "TEST_SERIES"}>
          {Object.entries(PRODUCT_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectNative>
      </F>
      <F label="Exam (Full Exam Access / PYQ Package)" name="examId">
        <SelectNative id="p-examId" name="examId" defaultValue={p?.examId ?? ""}>
          <option value="">—</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </SelectNative>
      </F>
      <F label="Test Series (Test Series type)" name="testSeriesId">
        <SelectNative id="p-testSeriesId" name="testSeriesId" defaultValue={p?.testSeriesId ?? ""}>
          <option value="">—</option>
          {series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.exam.name}
            </option>
          ))}
        </SelectNative>
      </F>
      <F label="Mock Test (Mock Test type)" name="mockTestId">
        <SelectNative id="p-mockTestId" name="mockTestId" defaultValue={p?.mockTestId ?? ""}>
          <option value="">—</option>
          {mocks.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title} · {m.exam.name}
            </option>
          ))}
        </SelectNative>
      </F>
      <F label="Grand Test (Grand Test type)" name="grandTestId">
        <SelectNative id="p-grandTestId" name="grandTestId" defaultValue={p?.grandTestId ?? ""}>
          <option value="">—</option>
          {grands.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title} · {m.exam.name}
            </option>
          ))}
        </SelectNative>
      </F>
      <F label="Live Test (Live Test type)" name="liveTestId">
        <SelectNative id="p-liveTestId" name="liveTestId" defaultValue={p?.liveTestId ?? ""}>
          <option value="">—</option>
          {lives.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title} · {m.exam.name}
            </option>
          ))}
        </SelectNative>
      </F>

      <div className="md:col-span-2 border-t border-[var(--color-border)] pt-3 text-sm font-medium">Pricing</div>
      <F label="Access type" name="accessType" hint="FREE keeps covered content open even in PAID mode.">
        <SelectNative id="p-accessType" name="accessType" defaultValue={p?.accessType ?? "PAID"}>
          <option value="PAID">PAID</option>
          <option value="FREE">FREE</option>
        </SelectNative>
      </F>
      <div className="grid grid-cols-2 gap-3">
        <F label="MRP (₹)" name="mrp">
          <Input id="p-mrp" name="mrp" inputMode="decimal" defaultValue={paiseToRupeeString(p?.mrpPaise ?? null)} placeholder="999" />
        </F>
        <F label="Selling price (₹)" name="sellingPrice">
          <Input id="p-sellingPrice" name="sellingPrice" inputMode="decimal" defaultValue={paiseToRupeeString(p?.sellingPricePaise ?? null)} placeholder="499" />
        </F>
      </div>
      <label className="flex items-center gap-2 text-sm md:col-span-2">
        <input type="checkbox" name="saleEnabled" defaultChecked={p?.saleEnabled ?? false} /> Time-limited sale (extra discount on the selling price)
      </label>
      <div className="grid grid-cols-2 gap-3">
        <F label="Sale discount type" name="saleDiscountType">
          <SelectNative id="p-saleDiscountType" name="saleDiscountType" defaultValue={p?.saleDiscountType ?? "PERCENTAGE"}>
            <option value="PERCENTAGE">Percentage</option>
            <option value="FIXED_AMOUNT">Fixed amount (₹)</option>
          </SelectNative>
        </F>
        <F label="Sale value" name="saleDiscountValue" hint="% (1-99) or ₹">
          <Input
            id="p-saleDiscountValue"
            name="saleDiscountValue"
            inputMode="decimal"
            defaultValue={p?.saleDiscountValue == null ? "" : p.saleDiscountType === "FIXED_AMOUNT" ? paiseToRupeeString(p.saleDiscountValue) : String(p.saleDiscountValue)}
          />
        </F>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F label="Sale starts (IST)" name="saleStartAt">
          <Input id="p-saleStartAt" name="saleStartAt" type="datetime-local" defaultValue={toLocal(p?.saleStartAt)} />
        </F>
        <F label="Sale ends (IST)" name="saleEndAt">
          <Input id="p-saleEndAt" name="saleEndAt" type="datetime-local" defaultValue={toLocal(p?.saleEndAt)} />
        </F>
      </div>

      <div className="md:col-span-2 border-t border-[var(--color-border)] pt-3 text-sm font-medium">Access duration</div>
      <F label="Duration type" name="accessDurationType">
        <SelectNative id="p-accessDurationType" name="accessDurationType" defaultValue={p?.accessDurationType ?? "DAYS"}>
          <option value="DAYS">Fixed number of days</option>
          <option value="FIXED_DATE">Until a fixed date</option>
          <option value="LIFETIME">Lifetime</option>
        </SelectNative>
      </F>
      <div className="grid grid-cols-2 gap-3">
        <F label="Days" name="accessDays">
          <Input id="p-accessDays" name="accessDays" type="number" min={1} max={3650} defaultValue={p?.accessDays ?? 365} />
        </F>
        <F label="Fixed expiry (IST)" name="accessExpiresAt">
          <Input id="p-accessExpiresAt" name="accessExpiresAt" type="datetime-local" defaultValue={toLocal(p?.accessExpiresAt)} />
        </F>
      </div>

      <div className="md:col-span-2 border-t border-[var(--color-border)] pt-3 text-sm font-medium">Visibility</div>
      <div className="flex flex-wrap gap-4 text-sm md:col-span-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isActive" defaultChecked={p?.isActive ?? true} /> Active
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isVisible" defaultChecked={p?.isVisible ?? true} /> Visible to students
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="purchaseEnabled" defaultChecked={p?.purchaseEnabled ?? true} /> Purchase enabled
        </label>
      </div>
      <F label="Sort order" name="order">
        <Input id="p-order" name="order" type="number" min={0} defaultValue={p?.order ?? 0} />
      </F>
    </ActionForm>
  );
}
