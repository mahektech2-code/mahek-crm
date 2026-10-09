import Link from "next/link";
import { DOC_APPS, DOC_TABS, progressOf } from "@/docs/registry";

/**
 * The front door: what this is, the three ways in, and every app documented.
 */
export default function DocsHome() {
  return (
    <div className="mx-auto max-w-[1080px] px-8 py-10">
      <div className="relative overflow-hidden rounded-[10px] bg-brand-deep px-10 py-10 text-white">
        <div className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:radial-gradient(#fff_1px,transparent_1px)] [background-size:18px_18px]" />
        <div className="relative">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[12px] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-lime" /> MahekOne Documentation
          </div>
          <h1 className="max-w-[720px] text-[34px] leading-[42px] font-semibold">
            How every screen works, why it works that way, and where it lives in the code.
          </h1>
          <p className="mt-3 max-w-[680px] text-[15px] leading-[24px] text-white/75">
            Every page is written for three readers. Settings quoted on a page are read live from this deployment, so the numbers you see are the
            numbers the app is using right now.
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-4">
        {DOC_TABS.map((t, i) => (
          <div key={t.id} className="rounded-[8px] border border-line bg-surface p-5">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-[6px] bg-brand-soft text-[14px] font-bold text-brand-hover">{i + 1}</div>
            <div className="text-[15px] font-semibold text-ink">{t.label}</div>
            <div className="mt-0.5 text-[12px] font-medium text-brand-hover">{t.reader}</div>
            <p className="mt-2 text-[13px] leading-[20px] text-body">{t.blurb}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-12 mb-4 text-[13px] font-semibold tracking-[0.06em] text-muted uppercase">Apps</h2>
      <div className="grid grid-cols-2 gap-4">
        {DOC_APPS.map((app) => {
          const { written, total } = progressOf(app);
          const pct = Math.round((written / total) * 100);
          return (
            <Link
              key={app.app}
              href={`/docs/${app.app}`}
              className="group rounded-[8px] border border-line bg-surface p-5 no-underline hover:border-brand-softer hover:no-underline hover:shadow-[0_6px_20px_-12px_rgba(104,53,251,0.5)]"
            >
              <div className="flex items-center justify-between">
                <span className="text-[17px] font-semibold text-ink group-hover:text-brand-hover">{app.title}</span>
                <span className="text-[12px] text-muted">{app.pages.length} pages</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-[20px] text-body">{app.summary}</p>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[11px] whitespace-nowrap text-muted">
                  {written} of {total} tabs written
                </span>
              </div>
            </Link>
          );
        })}
        <div className="rounded-[8px] border border-dashed border-line-strong p-5 text-[13px] leading-[20px] text-muted">
          Accounts, Sales Dashboard, HRMS, ERP, Founder Command Centre, Hire, Website and the MBOS handset follow the Telecaller CRM, one app
          at a time.
        </div>
      </div>
    </div>
  );
}
