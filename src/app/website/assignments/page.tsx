import { assignScreen } from "@/lib/website-cms/review-queries";
import { AssignScreen } from "../cms-ui/assign-screen";

/** Assign work and switch enforcement on or off. The layout admits only `website.review` holders. */
export default async function WebsiteAssignmentsPage() {
  return <AssignScreen data={await assignScreen()} />;
}
