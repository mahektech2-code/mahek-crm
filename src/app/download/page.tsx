import {
  BrandPanel,
  BrandPanelHeading,
} from "@/components/shell/brand-panel";

export const metadata = { title: "Download MBOS - MahekOne" };

/**
 * The APK itself lives at public/downloads/mbos.apk under a fixed filename,
 * so shipping an update is "overwrite the file" — this page's link never
 * needs to change.
 */
const APK_PATH = "/downloads/mbos.apk";

export default function DownloadPage() {
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel>
        <BrandPanelHeading eyebrow="Field salesman app">
          MBOS, on your phone
        </BrandPanelHeading>
        <p className="animate-rise mt-4 text-sm leading-6 text-white/75 [animation-delay:80ms]">
          Visits, orders and payments, taken where the shop is — not typed in
          from memory back at the office.
        </p>
      </BrandPanel>

      <div className="flex min-w-0 flex-col items-center justify-center gap-6 p-8 text-center">
        <div className="flex flex-col items-center gap-1.5 md:hidden">
          <span className="relative h-6 w-6 flex-none">
            <span className="absolute inset-0 flex items-center justify-center rounded-[4px] bg-brand">
              <span className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
            </span>
          </span>
          <span className="text-base font-semibold tracking-[-0.01em] text-ink">
            MAHEK<span className="text-brand">ONE</span>
          </span>
        </div>

        <div>
          <h1 className="text-xl font-semibold text-ink">Download MBOS</h1>
          <p className="mt-1.5 max-w-[320px] text-sm text-muted">
            For Android. Your phone will warn you it&rsquo;s from outside the
            Play Store — that&rsquo;s expected for an internal app.
          </p>
        </div>

        <a
          href={APK_PATH}
          download
          className="hover:bg-brand-hover inline-flex h-11 items-center justify-center rounded-[var(--radius-control)] bg-brand px-6 text-sm font-medium text-white transition-colors"
        >
          Download for Android
        </a>

        <p className="text-xs text-muted">
          Already have MBOS installed? Downloading again updates it in place —
          no need to uninstall first.
        </p>
      </div>
    </div>
  );
}
