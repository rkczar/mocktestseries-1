"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createAdminUserAction, type AdminUserFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create Admin User"}</Button>;
}

export function AdminUserForm({ roles }: { roles: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState<AdminUserFormState, FormData>(createAdminUserAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="username">Username</Label>
        <Input id="username" name="username" required placeholder="admin" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email (optional)</Label>
        <Input id="email" name="email" type="email" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" required minLength={10} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="roleId">Role</Label>
        <SelectNative id="roleId" name="roleId" required>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>{role.name.replace("_", " ")}</option>
          ))}
        </SelectNative>
      </div>
      <div className="flex items-end sm:col-span-2 lg:col-span-5">
        <SubmitButton />
        {state.error ? <p className="ml-3 text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="ml-3 text-sm text-[var(--color-success)]">Admin user created.</p> : null}
      </div>
    </form>
  );
}
