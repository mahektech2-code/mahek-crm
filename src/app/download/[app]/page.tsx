import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import {
  DOWNLOAD_APPS,
  DOWNLOAD_APP_IDS,
  downloadHref,
  type DownloadApp,
  type DownloadAppId,
} from "../apps";
import { absoluteUrl, currentRelease, type Release } from "../release";
import { AppTile, Wordmark } from "../parts";

/**
 * ONE APP, ONE PAGE: /download/mbos and /download/factory. On a phone the
 * download is the first thing on the screen, because that is why somebody
 * opened the link; everything else — who signs in, how, what to expect — sits
 * underneath for whoever needs it. On a laptop the brand panel says what the
 * app is and a QR code carries the page to the phone it belongs on.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ app: string }> };

const appFor = (slug: string): DownloadApp | null =>
  DOWNLOAD_APP_IDS.includes(slug as DownloadAppId)
    ? DOWNLOAD_APPS[slug as DownloadAppId]
    : null;

export async function generateMetadata({ params }: Params) {
  const app = appFor((await params).app);
  return {
    title: app ? `Download ${app.name} - MahekOne` : "Download - MahekOne",
  };
}

export default async function DownloadAppPage({ params }: Params) {
  const app = appFor((await params).app);
  if (!app) notFound();
  const other = DOWNLOAD_APPS[app.id === "mbos" ? "factory" : "mbos"];
  const [release, pageUrl] = await Promise.all([
    currentRelease(app),
    absoluteUrl(downloadHref(app.id)),
  ]);
  const qr = await QRCode.toString(pageUrl, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#1a1e28", light: "#ffffff00" },
  });

  return (
    <div className="grid min-h-screen grid-cols-1 bg-canvas md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Held in place on a laptop while the details scroll beside it. */}
      <div className="hidden md:sticky md:top-0 md:flex md:h-screen md:flex-col [&>*]:flex-1">
        <BrandPanel footer={<OtherApp other={other} tone="dark" />}>
          <BrandPanelHeading eyebrow={`${app.name} · ${app.tagline}`}>
            {app.headline}
          </BrandPanelHeading>
          <ul className="animate-rise mt-7 flex flex-col gap-3 [animation-delay:80ms]">
            {app.features.map((f) => (
              <li
                key={f}
                className="flex gap-3 text-sm leading-6 text-white/80"
              >
                <Tick className="mt-1 text-brand-lime" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </BrandPanel>
      </div>

      <main className="flex min-w-0 flex-col">
        <MobileHero app={app} release={release} />

        <div className="flex flex-1 justify-center px-4 py-8 md:items-center md:px-10 md:py-12">
          <div className="flex w-full max-w-[520px] flex-col gap-6">
            <DesktopDownload app={app} release={release} qr={qr} />

            <Section title="Who is it for">
              <p className="text-sm leading-6 text-body">{app.who}</p>
            </Section>

            <Section title="How you sign in">
              <ol className="flex flex-col gap-3">
                {app.signIn.map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <Step n={i + 1} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">
                        {s.title}
                      </div>
                      <p className="text-sm leading-6 text-body">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 rounded-[var(--radius-control)] bg-brand-soft px-3 py-2.5 text-xs leading-5 text-body">
                {app.access}
              </p>
            </Section>

            <Section title="Installing it">
              <ol className="flex flex-col gap-3">
                {[
                  "Tap Download for Android and open the file when it finishes.",
                  "If your phone asks, allow installing apps from your browser, then tap Install.",
                  app.firstRun,
                ].map((text, i) => (
                  <li key={i} className="flex gap-3">
                    <Step n={i + 1} />
                    <p className="min-w-0 text-sm leading-6 text-body">
                      {text}
                    </p>
                  </li>
                ))}
              </ol>
            </Section>

            <div className="md:hidden">
              <OtherApp other={other} tone="light" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/** The phone's first screen: the app and its download, nothing to scroll past. */
function MobileHero({
  app,
  release,
}: {
  app: DownloadApp;
  release: Release | null;
}) {
  return (
    <section className="bg-brand-deep px-4 pt-6 pb-7 text-white md:hidden">
      <Wordmark />
      <div className="mt-6 flex items-center gap-3">
        <AppTile app={app} size="lg" />
        <div className="min-w-0">
          <h1 className="text-2xl leading-8 font-semibold">{app.name}</h1>
          <p className="text-sm text-white/70">{app.tagline}</p>
        </div>
      </div>
      <p className="mt-4 text-[15px] leading-6 text-white/85">{app.headline}</p>
      <DownloadButton app={app} variant="lime" className="mt-5" />
      <Facts release={release} className="mt-3 text-white/65" />
      <p className="mt-3 text-xs leading-5 text-white/60">{app.note}</p>
    </section>
  );
}

/** The laptop's card: the download, and a QR to carry it to a phone. */
function DesktopDownload({
  app,
  release,
  qr,
}: {
  app: DownloadApp;
  release: Release | null;
  qr: string;
}) {
  return (
    <section className="hidden rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(26,30,40,0.04)] md:block">
      <div className="flex items-center gap-3">
        <AppTile app={app} size="md" />
        <div className="min-w-0">
          <h1 className="text-xl leading-7 font-semibold text-ink">
            Download {app.name}
          </h1>
          <p className="text-sm text-muted">{app.tagline}</p>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-5">
        <div className="min-w-0 flex-1">
          <DownloadButton app={app} variant="brand" />
          <Facts release={release} className="mt-2.5 text-muted" />
        </div>
        <div className="flex flex-none flex-col items-center gap-1.5">
          <div
            role="img"
            aria-label={`QR code for the ${app.name} download page`}
            className="h-[104px] w-[104px] rounded-[6px] border border-line bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <span className="text-[11px] text-muted">Scan with your phone</span>
        </div>
      </div>

      <p className="mt-4 border-t border-line pt-4 text-xs leading-5 text-muted">
        {app.note}
      </p>
    </section>
  );
}

function DownloadButton({
  app,
  variant,
  className = "",
}: {
  app: DownloadApp;
  variant: "brand" | "lime";
  className?: string;
}) {
  const tone =
    variant === "lime"
      ? "bg-brand-lime text-brand-deep hover:brightness-95"
      : "bg-brand text-white hover:bg-brand-hover";
  return (
    <a
      href={app.apk}
      download
      className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] px-6 text-base font-semibold transition ${tone} ${className}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 3v10m0 0 4-4m-4 4-4-4M4 16h12" />
      </svg>
      Download for Android
    </a>
  );
}

function Facts({
  release,
  className = "",
}: {
  release: Release | null;
  className?: string;
}) {
  return (
    <p className={`text-xs ${className}`}>
      Android only{release ? ` · Version ${release.version}` : ""} · Free, for
      Mahek staff
    </p>
  );
}

function OtherApp({
  other,
  tone,
}: {
  other: DownloadApp;
  tone: "dark" | "light";
}) {
  const dark = tone === "dark";
  return (
    <Link
      href={downloadHref(other.id)}
      className={`group flex items-center justify-between gap-3 rounded-[var(--radius-card)] border px-4 py-3 text-sm transition-colors ${
        dark
          ? "border-white/15 text-white/80 hover:bg-white/5"
          : "border-line bg-surface text-body hover:border-brand"
      }`}
    >
      <span>
        Looking for the {other.team.toLowerCase()} app?{" "}
        <span
          className={dark ? "font-medium text-white" : "font-medium text-ink"}
        >
          {other.name}
        </span>
      </span>
      <span aria-hidden className={dark ? "text-brand-lime" : "text-brand"}>
        →
      </span>
    </Link>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">
      {n}
    </span>
  );
}

function Tick({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-4 w-4 flex-none ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
