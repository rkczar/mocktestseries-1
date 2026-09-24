"use client";

import { useActionState, useState } from "react";
import { Pencil, KeyRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  updateProfileAction,
  changePasswordAction,
  requestDeletionAction,
  type ProfileActionState,
} from "./actions";

const INITIAL_STATE: ProfileActionState = {};

export function EditProfileDialog({ name, bio }: { name: string; bio: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(updateProfileAction, INITIAL_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4" aria-hidden /> Edit Profile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>Update your display name and bio.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Full Name</Label>
            <div
              id="name"
              className="flex items-center justify-between gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)]"
            >
              {name}
              <span className="shrink-0 rounded-[var(--radius-badge)] bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--color-muted-foreground)]">
                Read Only
              </span>
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Your name can&apos;t be changed here. Contact support if it needs to be corrected.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bio">Bio (optional)</Label>
            <textarea
              id="bio"
              name="bio"
              defaultValue={bio}
              rows={3}
              className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
            />
          </div>
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">{state.success}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChangePasswordDialog({ canChangePassword }: { canChangePassword: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(changePasswordAction, INITIAL_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound className="h-4 w-4" aria-hidden /> Change Password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            {canChangePassword
              ? "Enter your current password and choose a new one."
              : "This account signs in with Google or Mobile OTP and has no password to change."}
          </DialogDescription>
        </DialogHeader>
        {canChangePassword ? (
          <form action={formAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input id="currentPassword" name="currentPassword" type="password" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newPassword">New Password</Label>
              <Input id="newPassword" name="newPassword" type="password" required minLength={8} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} />
            </div>
            {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
            {state.success ? <p className="text-sm text-[var(--color-success)]">{state.success}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving…" : "Change Password"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAccountDialog({ alreadyRequested }: { alreadyRequested: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(requestDeletionAction, INITIAL_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="danger" size="sm" disabled={alreadyRequested}>
          <Trash2 className="h-4 w-4" aria-hidden /> {alreadyRequested ? "Deletion Requested" : "Delete Account"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Account Deletion</DialogTitle>
          <DialogDescription>
            An Admin will review your request. You can keep using your account while it is pending. Once approved, you
            are signed out on every device and your active account and profile are deleted — you can sign up again
            later, but as a new account without your old tests or purchases. We keep a limited record of the deletion
            (your name, Student ID, email, phone and the reason you give) and past test and payment records where
            needed for security, fraud prevention, transaction and legal records, and audit. Your password and login
            codes are never kept.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reason">Reason (optional)</Label>
            <textarea
              id="reason"
              name="reason"
              rows={3}
              className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
            />
          </div>
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">{state.success}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={isPending || Boolean(state.success)}>
              {isPending ? "Submitting…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
