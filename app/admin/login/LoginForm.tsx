"use client";

import { useActionState } from "react";

import { FormField } from "@/components/auth/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { adminLoginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(adminLoginAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Email" name="email" type="email" autoComplete="email" />
      <FormField label="Password" name="password" type="password" autoComplete="current-password" />
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton>Log in</SubmitButton>
    </form>
  );
}
