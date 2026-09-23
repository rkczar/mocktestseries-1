import type { Coupon } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { paiseToRupeeString } from "@/lib/payments/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm } from "./action-form";
import { saveCouponAction } from "../actions";

const toLocal = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) : "");

function F({ label, name, children, hint }: { label: string; name: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`c-${name}`}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

export async function CouponForm({ coupon, readOnly }: { coupon: Coupon | null; readOnly: boolean }) {
  const [products, exams, series] = await Promise.all([
    prisma.product.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.exam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.testSeries.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const c = coupon;
  const multi = (name: string, items: { id: string; name: string }[], selected: string[]) => (
    <SelectNative id={`c-${name}`} name={name} multiple defaultValue={selected} className="h-28">
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </SelectNative>
  );
  return (
    <ActionForm action={saveCouponAction} submitLabel={c ? "Save coupon" : "Create coupon"} readOnly={readOnly} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {c ? <input type="hidden" name="id" value={c.id} /> : null}
      <F label="Code" name="code" hint="e.g. RAJNESH, FRIEND50, RUHSFREE, WELCOME20 (A-Z, 0-9, _ -)">
        <Input id="c-code" name="code" defaultValue={c?.code ?? ""} required maxLength={32} className="uppercase" />
      </F>
      <F label="Display name" name="displayName">
        <Input id="c-displayName" name="displayName" defaultValue={c?.displayName ?? ""} maxLength={100} />
      </F>
      <div className="md:col-span-2">
        <F label="Description" name="description">
          <Textarea id="c-description" name="description" defaultValue={c?.description ?? ""} rows={2} maxLength={1000} />
        </F>
      </div>
      <F label="Discount type" name="discountType">
        <SelectNative id="c-discountType" name="discountType" defaultValue={c?.discountType ?? "PERCENTAGE"}>
          <option value="PERCENTAGE">Percentage</option>
          <option value="FIXED_AMOUNT">Fixed amount (₹)</option>
          <option value="FREE_ACCESS">Free access (100%)</option>
        </SelectNative>
      </F>
      <F label="Discount value" name="discountValue" hint="% (1-100) or ₹. Ignored for Free access.">
        <Input
          id="c-discountValue"
          name="discountValue"
          inputMode="decimal"
          defaultValue={c ? (c.discountType === "FIXED_AMOUNT" ? paiseToRupeeString(c.discountValue) : String(c.discountValue)) : ""}
        />
      </F>
      <F label="Maximum discount (₹, optional)" name="maxDiscount">
        <Input id="c-maxDiscount" name="maxDiscount" inputMode="decimal" defaultValue={paiseToRupeeString(c?.maxDiscountPaise ?? null)} />
      </F>
      <F label="Minimum order (₹, optional)" name="minOrder">
        <Input id="c-minOrder" name="minOrder" inputMode="decimal" defaultValue={paiseToRupeeString(c?.minOrderPaise ?? null)} />
      </F>
      <F label="Valid from (IST)" name="validFrom">
        <Input id="c-validFrom" name="validFrom" type="datetime-local" defaultValue={toLocal(c?.validFrom)} />
      </F>
      <F label="Valid until (IST)" name="validUntil">
        <Input id="c-validUntil" name="validUntil" type="datetime-local" defaultValue={toLocal(c?.validUntil)} />
      </F>
      <F label="Total usage limit" name="totalUsageLimit" hint="Blank = unlimited">
        <Input id="c-totalUsageLimit" name="totalUsageLimit" type="number" min={1} defaultValue={c?.totalUsageLimit ?? ""} />
      </F>
      <F label="Per-student limit" name="perStudentLimit" hint="Blank = unlimited">
        <Input id="c-perStudentLimit" name="perStudentLimit" type="number" min={1} defaultValue={c?.perStudentLimit ?? 1} />
      </F>
      <div className="flex flex-wrap gap-4 text-sm md:col-span-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isActive" defaultChecked={c?.isActive ?? true} /> Active
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="newStudentOnly" defaultChecked={c?.newStudentOnly ?? false} /> First purchase only
        </label>
      </div>

      <div className="md:col-span-2 border-t border-[var(--color-border)] pt-3 text-sm font-medium">
        Applicability <span className="font-normal text-[var(--color-muted-foreground)]">(leave all empty = any product; Ctrl/Cmd-click to multi-select)</span>
      </div>
      <F label="Products" name="productIds">
        {multi("productIds", products, c?.productIds ?? [])}
      </F>
      <F label="Exams" name="examIds">
        {multi("examIds", exams, c?.examIds ?? [])}
      </F>
      <F label="Test Series" name="testSeriesIds">
        {multi("testSeriesIds", series, c?.testSeriesIds ?? [])}
      </F>

      <div className="md:col-span-2 border-t border-[var(--color-border)] pt-3 text-sm font-medium">Attribution</div>
      <F label="Source" name="source">
        <Input id="c-source" name="source" defaultValue={c?.source ?? ""} placeholder="instagram, telegram, friend…" />
      </F>
      <F label="Campaign" name="campaign">
        <Input id="c-campaign" name="campaign" defaultValue={c?.campaign ?? ""} />
      </F>
      <F label="Referrer name" name="referrerName">
        <Input id="c-referrerName" name="referrerName" defaultValue={c?.referrerName ?? ""} />
      </F>
      <F label="Referrer code" name="referrerCode">
        <Input id="c-referrerCode" name="referrerCode" defaultValue={c?.referrerCode ?? ""} />
      </F>
      <F label="Referrer student ID (internal id, optional)" name="referrerStudentId">
        <Input id="c-referrerStudentId" name="referrerStudentId" defaultValue={c?.referrerStudentId ?? ""} />
      </F>
      <F label="Referrer admin ID (optional)" name="referrerAdminId">
        <Input id="c-referrerAdminId" name="referrerAdminId" defaultValue={c?.referrerAdminId ?? ""} />
      </F>
      <div className="md:col-span-2">
        <F label="Notes" name="notes">
          <Textarea id="c-notes" name="notes" defaultValue={c?.notes ?? ""} rows={2} maxLength={2000} />
        </F>
      </div>
    </ActionForm>
  );
}
