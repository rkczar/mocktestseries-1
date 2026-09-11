"use client";

import { useActionState } from "react";

import { FormField } from "@/components/auth/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { registerAction, type RegisterState } from "./actions";

export function RegisterForm() {
  const [state, formAction] = useActionState<RegisterState, FormData>(registerAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Full name" name="name" autoComplete="name" />
      <FormField label="Email" name="email" type="email" autoComplete="email" />
      <FormField label="Password" name="password" type="password" autoComplete="new-password" />
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton>Create free account</SubmitButton>
    </form>
  );
}
