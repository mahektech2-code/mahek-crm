import { redirect } from "next/navigation";

/** Routines moved under Set up; notifications sent before the move still land here. */
export default function OldRoutinesPage() {
  redirect("/tasks/setup/routines");
}
