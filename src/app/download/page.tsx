import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import {
  DOWNLOAD_APPS,
  DOWNLOAD_APP_IDS,
  LEGACY_TEAMS,
  downloadHref,
} from "./apps";
import { AppTile, Wordmark } from "./parts";

export const metadata = { title: "Download the apps - MahekOne" };

/**
 * The fork between the two app pages. Each app has its own address —
 * /download/mbos and /download/factory — and that is the link to send a team.
 * Links sent before the split carried `?team=sales` or `?team=erp`; they still
 * land on the right app.
 */
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const { team } = await searchParams;
  const legacy = team ? LEGACY_TEAMS[team] : undefined;
  if (legacy) redirect(downloadHref(legacy));

  return (
    <div className="grid min-h-screen grid-cols-1 bg-canvas md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Held in place on a laptop while the details scroll beside it. */}
      <div className="hidden md:sticky md:top-0 md:flex md:h-screen md:flex-col [&>*]:flex-1">
        <BrandPanel>
          <BrandPanelHeading eyebrow="MahekOne apps">
            The right app for your work, on your phone
          </BrandPanelHeading>
          <p className="animate-rise mt-4 text-sm leading-6 text-white/75 [animation-delay:80ms]">
            MBOS for the field sales team, Mahek Factory for the floor. Each has
            its own page — pick yours.
          </p>
        </BrandPanel>
      </div>

      <main className="flex min-w-0 flex-col">
        <section className="bg-brand-deep px-4 pt-6 pb-7 text-white md:hidden">
          <Wordmark />
          <h1 className="mt-6 text-2xl leading-8 font-semibold">
            Download the apps
          </h1>
          <p className="mt-1.5 text-sm text-white/75">
            Pick the app for your team.
          </p>
        </section>

        <div className="flex flex-1 justify-center px-4 py-8 md:items-center md:px-10 md:py-12">
          <div className="flex w-full max-w-[520px] flex-col gap-4">
            <div className="hidden md:block">
              <h1 className="text-xl font-semibold text-ink">
                Download the apps
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                Pick the app for your team.
              </p>
            </div>
            {DOWNLOAD_APP_IDS.map((id) => {
              const app = DOWNLOAD_APPS[id];
              return (
                <Link
                  key={id}
                  href={downloadHref(id)}
                  className="group flex items-center gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(26,30,40,0.04)] transition-colors hover:border-brand"
                >
                  <AppTile app={app} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                      {app.team}
                    </div>
                    <div className="text-lg leading-6 font-semibold text-ink">
                      {app.name}
                    </div>
                    <p className="mt-0.5 text-sm leading-5 text-body">
                      {app.who}
                    </p>
                  </div>
                  <span
                    aria-hidden
                    className="text-lg text-brand transition-transform group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
