import { requireModule } from "@/lib/access";
import { founderPageAccess } from "@/lib/command-centre/access";
import { listContacts, type ContactFilter } from "@/lib/services/whatsapp-dnd-service";
import { ContactsControl } from "./contacts-control";

export const metadata = { title: "WhatsApp contacts & DND - HQ - MahekOne" };

/**
 * Every customer, and whether WhatsApp messages may go to them. The list is
 * read on the server and paged there — thousands of shops are not a list to
 * ship to a browser — and the filters are the URL, so a view can be sent to
 * somebody as a link.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; f?: string; page?: string }>;
}) {
  /* The layouts' two gates, asked here before `listContacts` can throw its own
     refusal: a page renders beside its layouts, not after them. */
  const { user } = await founderPageAccess();
  await requireModule(user.id, "founder.whatsapp");
  const sp = await searchParams;
  const filter: ContactFilter = sp.f === "dnd" || sp.f === "open" ? sp.f : "all";
  const data = await listContacts({ q: sp.q, filter, page: Number(sp.page) || 1 });
  return <ContactsControl data={data} q={sp.q ?? ""} filter={filter} />;
}
