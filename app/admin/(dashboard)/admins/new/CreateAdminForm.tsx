"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { createAdminAction, type FormState } from "../actions";

const ROLE_OPTIONS = [
  { value: "ADMIN", label: "Admin" },
  { value: "SUPER_ADMIN", label: "Super Admin" },
];

export function CreateAdminForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createAdminAction, undefined);

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <FormField label="Name" name="name" required />
      <FormField label="Email" name="email" type="email" required />
      <FormField label="Initial password (min 8 characters)" name="password" type="password" required />
      <FormSelect label="Role" name="role" defaultValue="ADMIN" options={ROLE_OPTIONS} />
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">Create admin</SubmitButton>
    </form>
  );
}
