import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // One WEB app is not a choice — skip the launcher entirely. A mobile-only
  // app (`field`) never counts as the one: holding it and nothing else has
  // no web screen to skip to, and holding it alongside a real web app must
  // not stop that app's own straight-in redirect from firing.
  const apps = await listUserApps(user.id);
  const web = webApps(apps);
  redirect(web.length === 1 ? web[0].href : "/apps");
}
