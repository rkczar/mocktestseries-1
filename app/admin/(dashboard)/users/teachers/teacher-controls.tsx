"use client";

import { useActionState, useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { assignExamAction, createTeacherAction, revokeAssignmentAction, setTeacherStatusAction, type TeacherFormState } from "./actions";

function Msg({ s }: { s: TeacherFormState }) {
  if (s.error) return <p role="alert" className="text-sm text-[var(--color-error)]">{s.error}</p>;
  if (s.ok) return <p role="status" className="text-sm text-[var(--color-success)]">{s.ok}</p>;
  return null;
}

export function CreateTeacherForm() {
  const [state, action, pending] = useActionState<TeacherFormState, FormData>(createTeacherAction, {});
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1"><Label htmlFor="t-name">Full name</Label><Input id="t-name" name="name" required minLength={2} /></div>
      <div className="flex flex-col gap-1"><Label htmlFor="t-username">Username</Label><Input id="t-username" name="username" required minLength={3} /></div>
      <div className="flex flex-col gap-1"><Label htmlFor="t-email">Email (optional)</Label><Input id="t-email" name="email" type="email" /></div>
      <div className="flex flex-col gap-1"><Label htmlFor="t-password">Temporary password</Label><Input id="t-password" name="password" type="password" required minLength={10} autoComplete="new-password" /></div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create teacher"}</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

export function TeacherStatusButtons({ teacherId, status }: { teacherId: string; status: string }) {
  const [msg, setMsg] = useState<TeacherFormState>({});
  const [pending, start] = useTransition();
  const run = (s: "ACTIVE" | "SUSPENDED" | "DEACTIVATED") => {
    if (s !== "ACTIVE" && !window.confirm(s === "SUSPENDED" ? "Suspend this teacher? They are signed out at once." : "Deactivate this teacher? They are signed out and can no longer sign in.")) return;
    start(async () => setMsg(await setTeacherStatusAction(teacherId, s)));
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== "ACTIVE" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run("ACTIVE")}>Activate</Button> : null}
      {status === "ACTIVE" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run("SUSPENDED")}>Suspend</Button> : null}
      {status !== "DEACTIVATED" ? <Button size="sm" variant="danger" disabled={pending} onClick={() => run("DEACTIVATED")}>Deactivate</Button> : null}
      <Msg s={msg} />
    </div>
  );
}

export function AssignExamForm({ teacherId, exams }: { teacherId: string; exams: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<TeacherFormState, FormData>(assignExamAction.bind(null, teacherId), {});
  if (exams.length === 0) return null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <SelectNative name="examId" required defaultValue="" aria-label="Exam to assign">
        <option value="" disabled>Assign exam…</option>
        {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </SelectNative>
      <Button size="sm" type="submit" disabled={pending}>Assign</Button>
      <Msg s={state} />
    </form>
  );
}

export function RevokeButton({ assignmentId, examName }: { assignmentId: string; examName: string }) {
  const [msg, setMsg] = useState<TeacherFormState>({});
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        aria-label={`Remove ${examName}`}
        className="text-xs text-[var(--color-error)] underline"
        onClick={() => window.confirm(`Remove ${examName} from this teacher? Access ends immediately.`) && start(async () => setMsg(await revokeAssignmentAction(assignmentId)))}
      >
        remove
      </button>
      {msg.error ? <span className="text-xs text-[var(--color-error)]">{msg.error}</span> : null}
    </span>
  );
}
