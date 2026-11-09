import { redirect } from "next/navigation";

/** Old alias: the Teacher Login is /teacher itself (app/teacher/layout.tsx). */
export default function TeacherLoginAlias() {
  redirect("/teacher");
}
