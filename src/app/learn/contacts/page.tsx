import { requireUser } from "@/lib/auth";
import { directory } from "../directory";
import { Empty } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

/** PRD §14 — who to contact for each desk, from the `hire.directory` setting, resolved to people now. */
export default async function ContactsPage() {
  await requireUser();
  const { entries, unresolved } = await directory();
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="m-0 text-[18px] font-semibold text-heading">Who to contact</h1>
      {entries.length ? <p className="m-0 mb-1 text-[13px] leading-[19px] text-body">The people behind each desk. If something is urgent, call.</p> : null}
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[8px] border border-line bg-surface px-3 py-2.5">
          <span className="flex size-10 flex-none items-center justify-center rounded-full bg-divider text-[13px] font-semibold text-body">{e.initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium tracking-label text-muted uppercase">{e.desk}</span>
            <span className="block text-[15px] font-medium text-heading">{e.name}</span>
            {e.about ? <span className="block text-[12px] text-muted">{e.about}</span> : null}
          </span>
          {e.phone ? (
            <a href={`tel:${e.phone}`} aria-label={`Call ${e.name}`} className="flex size-11 flex-none items-center justify-center rounded-full border border-line bg-surface text-body">
              <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
              </svg>
            </a>
          ) : e.email ? (
            <a href={`mailto:${e.email}`} aria-label={`Email ${e.name}`} className="flex min-h-11 items-center px-2 text-[13px]">
              Email
            </a>
          ) : null}
        </div>
      ))}
      {!entries.length ? <Empty title="The directory is empty">HR fills it in on the Admin Console, under Hire’s settings.</Empty> : null}
      {unresolved ? (
        <p className="m-0 text-[12px] text-muted">
          {unresolved} desk{unresolved === 1 ? " is" : "s are"} left out because the person listed could not be found — tell HR so they can fix the directory.
        </p>
      ) : null}
    </div>
  );
}
