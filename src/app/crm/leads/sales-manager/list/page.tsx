import { redirect } from "next/navigation";

/*
 * The desk replaced the separate list views: the queues and the search are on
 * the dashboard. This stays as a redirect because the route lives in bookmarks
 * and in links the shared lead dialogs draw.
 */
export default function Page() {
  redirect("/crm/leads/sales-manager");
}
