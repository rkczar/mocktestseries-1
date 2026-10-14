"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { Switch } from "@/components/ui/switch";
import { resetAdminPasswordAction, updateAdminUserAction, type AdminEditResult } from "./actions";

export interface EditableAdmin {
  id: string;
  name: string;
  username: string;
  email: string | null;
  roleId: string;
  roleName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activity: { at: string; text: string }[];
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "Never");

function Result({ r }: { r: AdminEditResult | null }) {
  if (!r) return null;
  return (
    <p role={r.ok ? "status" : "alert"} className={`text-sm ${r.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
      {r.ok ? r.message : r.error}
    </p>
  );
}

export function AdminUserEdit({
  admin,
  roles,
  rolePermissions,
  isSelf,
}: {
  admin: EditableAdmin;
  roles: { id: string; name: string }[];
  rolePermissions: Record<string, string[]>;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(admin.name);
  const [email, setEmail] = useState(admin.email ?? "");
  const [roleId, setRoleId] = useState(admin.roleId);
  const [isActive, setIsActive] = useState(admin.isActive);
  const [actorPassword, setActorPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [saveResult, setSaveResult] = useState<AdminEditResult | null>(null);
  const [resetResult, setResetResult] = useState<AdminEditResult | null>(null);
  const [pending, startTransition] = useTransition();

  const roleName = roles.find((r) => r.id === roleId)?.name ?? admin.roleName;
  const sensitive = roleId !== admin.roleId || (email || null) !== (admin.email || null) || isActive !== admin.isActive;

  const reset = () => {
    setName(admin.name);
    setEmail(admin.email ?? "");
    setRoleId(admin.roleId);
    setIsActive(admin.isActive);
    setActorPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setResetPassword("");
    setSaveResult(null);
    setResetResult(null);
  };

  const run = (fn: () => Promise<AdminEditResult>, set: (r: AdminEditResult) => void, after?: () => void) =>
    startTransition(async () => {
      try {
        const r = await fn();
        set(r);
        if (r.ok) {
          after?.();
          router.refresh();
        }
      } catch {
        set({ ok: false, error: "You don't have permission to edit admin users." });
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`edit-admin-${admin.username}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit admin — {admin.username}</DialogTitle>
          <DialogDescription>
            Last login: {fmt(admin.lastLoginAt)} · Created {fmt(admin.createdAt)}. Passwords are never shown; they are stored only as secure hashes.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setSaveResult(null);
            run(() => updateAdminUserAction({ id: admin.id, name, email, roleId, isActive, actorPassword: sensitive ? actorPassword : undefined }), setSaveResult, () => setActorPassword(""));
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ae-name-${admin.id}`}>Full name</Label>
              <Input id={`ae-name-${admin.id}`} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ae-email-${admin.id}`}>Email</Label>
              <Input id={`ae-email-${admin.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ae-role-${admin.id}`}>Role</Label>
              <SelectNative id={`ae-role-${admin.id}`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={isSelf}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name.replace("_", " ")}
                  </option>
                ))}
              </SelectNative>
              {isSelf ? <p className="text-xs text-[var(--color-muted-foreground)]">You cannot change your own role.</p> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ae-active-${admin.id}`}>Account enabled</Label>
              <div className="flex h-10 items-center gap-2">
                <Switch id={`ae-active-${admin.id}`} checked={isActive} onCheckedChange={setIsActive} disabled={isSelf && admin.isActive} />
                <span className="text-sm">{isActive ? "Enabled" : "Disabled"}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Permissions ({roleName.replace("_", " ")})</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">Permissions come from the role. Change the role to change what this admin can do (see the Roles tab).</p>
            <div className="flex flex-wrap gap-1.5">
              {(rolePermissions[roleName] ?? []).map((p) => (
                <Badge key={p} variant="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          </div>

          {sensitive ? (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/50 p-3">
              <Label htmlFor={`ae-reauth-${admin.id}`}>Your current password (required for email, role or account changes)</Label>
              <Input id={`ae-reauth-${admin.id}`} type="password" autoComplete="current-password" value={actorPassword} onChange={(e) => setActorPassword(e.target.value)} required />
              {roleId !== admin.roleId || (!isActive && admin.isActive) ? (
                <p className="text-xs text-[var(--color-warning)]">This admin will be signed out of all sessions.</p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
            <Result r={saveResult} />
          </div>
        </form>

        <form
          className="mt-2 flex flex-col gap-3 border-t border-[var(--color-border)] pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            setResetResult(null);
            run(() => resetAdminPasswordAction({ id: admin.id, newPassword, confirmPassword, actorPassword: resetPassword }), setResetResult, () => {
              setNewPassword("");
              setConfirmPassword("");
              setResetPassword("");
            });
          }}
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4" aria-hidden /> Reset password
          </p>
          <p className="text-xs text-[var(--color-muted-foreground)]">Sets a new password and signs this admin out everywhere. Share it through a secure channel.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input type="password" autoComplete="new-password" placeholder="New password (min 10)" aria-label="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={10} required />
            <Input type="password" autoComplete="new-password" placeholder="Confirm new password" aria-label="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <Input type="password" autoComplete="current-password" placeholder="Your current password" aria-label="Your current password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} required />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? "Working…" : "Reset password"}
            </Button>
            <Result r={resetResult} />
          </div>
        </form>

        <div className="mt-2 flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
          <p className="text-sm font-medium">Recent account activity</p>
          {admin.activity.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No recorded activity.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs" data-testid="admin-activity">
              {admin.activity.map((a, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{a.text}</span>
                  <span className="shrink-0 text-[var(--color-muted-foreground)]">{fmt(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
