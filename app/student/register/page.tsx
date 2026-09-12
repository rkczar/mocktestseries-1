import { redirect } from "next/navigation";

export default function StudentRegisterAlias() {
  redirect("/login?tab=register");
}
