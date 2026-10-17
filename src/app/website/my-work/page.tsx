import { requireUser } from "@/lib/auth";
import { myWork, scopeFor } from "@/lib/website-cms/review-queries";
import { MyWorkScreen } from "../cms-ui/my-work-screen";

/** Everything here is the signed-in person's own: their assignments, their requests, their drafts. */
export default async function WebsiteMyWorkPage() {
  const user = await requireUser();
  const work = await myWork(user.id, await scopeFor(user.id));
  return <MyWorkScreen work={work} />;
}
