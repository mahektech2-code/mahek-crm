import { redirect } from "next/navigation";

/** The app has one module, so its front door is that module. */
export default function Page() {
  redirect("/hrms/employees");
}
