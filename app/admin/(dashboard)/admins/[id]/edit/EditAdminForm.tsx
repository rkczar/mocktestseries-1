"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { resetAdminPasswordAction, updateAdminAction, type FormState } from "../../actions";

const ROLE_OPTIONS = [
  { value: "ADMIN", label: "Admin" },
  { value: "SUPER_ADMIN", label: "Super Admin" },
];

type Admin = { id: string; name: string; role: "ADMIN" | "SUPER_ADMIN"; isActive: boolean };

export function EditAdminForm({ admin, isSelf }: { admin: Admin; isSelf: boolean }) {
  const [updateState, updateAction] = useActionState<FormState, FormData>(updateAdminAction, undefined);
  const [resetState, resetAction] = useActionState<FormState, FormData>(resetAdminPasswordAction, undefined);

  return (
    <div className="flex max-w-md flex-col gap-8">
      <form action={updateAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={admin.id} />
        <FormField label="Name" name="name" defaultValue={admin.name} required />
        <FormSelect label="Role" name="role" defaultValue={admin.role} options={ROLE_OPTIONS} />
        <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
          <input type="checkbox" name="isActive" defaultChecked={admin.isActive} className="size-4 accent-primary" disabled={isSelf} />
          Active {isSelf ? "(can't change your own account)" : ""}
        </label>
        {updateState?.error ? (
          <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
            {updateState.error}
          </p>
        ) : null}
        <SubmitButton className="w-fit px-6">Save changes</SubmitButton>
      </form>

      <form action={resetAction} className="flex flex-col gap-4 border-t border-border pt-6">
        <input type="hidden" name="id" value={admin.id} />
        <h2 className="text-sm font-extrabold text-text-heading">Reset password</h2>
        <FormField label="New password (min 8 characters)" name="password" type="password" required />
        {resetState?.error ? (
          <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
            {resetState.error}
          </p>
        ) : null}
        <SubmitButton className="w-fit px-6">Reset password</SubmitButton>
      </form>
    </div>
  );
}
