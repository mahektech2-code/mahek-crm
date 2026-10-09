import {
  BrandPanel,
  BrandPanelHeading,
} from "@/components/shell/brand-panel";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  return { title: `Download ${appFor((await searchParams).team).name} - MahekOne` };
}

/**
 * The APK itself is a plain file at /opt/mahekone/downloads/mbos.apk on the
 * droplet — see the Caddyfile's /downloads handle_path — under a fixed
 * filename, so shipping an update is "replace the file on the droplet", no
 * deploy and no change to this page's link required. Deliberately never
 * built into the app image: a 90+ MB binary there would bloat every layer
 * and the container registry along with it.
 */
/*
 * ONE PAGE, ONE APP PER TEAM. `?team=erp` is the factory floor — the ERP's
 * people — and gets the Factory app, a Trusted Web Activity around /factory
 * released by .github/workflows/factory-apk.yml. Anything else is MBOS, so
 * every link already given to a salesman keeps working.
 */
type DownloadApp = { name: string; eyebrow: string; heading: string; pitch: string; apk: string; again: string };
const APPS: Record<string, DownloadApp> = {
  mbos: {
    name: "MBOS",
    eyebrow: "Field salesman app",
    heading: "MBOS, on your phone",
    pitch: "Visits, orders and payments, taken where the shop is — not typed in from memory back at the office.",
    apk: "/downloads/mbos.apk",
    again: "Already have MBOS installed? Downloading again updates it in place — no need to uninstall first.",
  },
  erp: {
    name: "Mahek Factory",
    eyebrow: "Factory floor app",
    heading: "The factory, on your phone",
    pitch: "Scan the label, see the picture, count, send — mixing, filling, packing and dispatch, straight into the ERP. Works without network.",
    apk: "/downloads/factory.apk",
    again: "Already installed? It updates itself from the server — download again only if your supervisor asks you to.",
  },
};
const appFor = (team: string | undefined) => (team === "erp" || team === "factory" ? APPS.erp : APPS.mbos);

export default async function DownloadPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const app = appFor((await searchParams).team);
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel>
        <BrandPanelHeading eyebrow={app.eyebrow}>{app.heading}</BrandPanelHeading>
        <p className="animate-rise mt-4 text-sm leading-6 text-white/75 [animation-delay:80ms]">
          {app.pitch}
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
          <h1 className="text-xl font-semibold text-ink">Download {app.name}</h1>
          <p className="mt-1.5 max-w-[320px] text-sm text-muted">
            For Android. Your phone will warn you it&rsquo;s from outside the
            Play Store — that&rsquo;s expected for an internal app.
          </p>
        </div>

        <a
          href={app.apk}
          download
          className="hover:bg-brand-hover inline-flex h-11 items-center justify-center rounded-[var(--radius-control)] bg-brand px-6 text-sm font-medium text-white transition-colors"
        >
          Download for Android
        </a>

        <p className="text-xs text-muted">
          {app.again}
        </p>
      </div>
    </div>
  );
}
