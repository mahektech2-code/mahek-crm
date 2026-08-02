import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getApp } from "@/lib/apps";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // One app is not a choice — skip the launcher entirely.
  const apps = await listUserApps(user.id);
  redirect(apps.length === 1 ? (getApp(apps[0])?.href ?? "/apps") : "/apps");
}
