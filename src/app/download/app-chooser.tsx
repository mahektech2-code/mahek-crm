"use client";

import { useState } from "react";

/**
 * Two apps live on this page and most visitors want exactly one of them, so
 * the page asks which team they are on and shows that app alone. Nothing
 * chosen shows both, because a page that shows nothing until a question is
 * answered reads as a broken page to somebody who skipped the question.
 */

type AppId = "mbos" | "factory";

export type Team = "sales" | "erp";

const TEAMS: { id: Team; label: string; app: AppId }[] = [
  { id: "sales", label: "Sales", app: "mbos" },
  { id: "erp", label: "ERP", app: "factory" },
];

/**
 * The APK is a plain file at /opt/mahekone/downloads/mbos.apk on the
 * droplet — see the Caddyfile's /downloads handle_path — under a fixed
 * filename, so shipping an update is "replace the file on the droplet", no
 * deploy and no change to this page's link required. Deliberately never
 * built into the app image: a 90+ MB binary there would bloat every layer
 * and the container registry along with it.
 *
 * The Factory app has no APK: it is `/factory`, a web app with its own
 * service worker, so "getting it" is opening it and adding it to the home
 * screen. The button says Open rather than Download for that reason — a
 * Download button that navigates to a page is a promise the tap breaks.
 */
const APPS: Record<
  AppId,
  {
    name: string;
    tag: string;
    what: string;
    who: string;
    href: string;
    action: string;
    download: boolean;
    note: string;
  }
> = {
  mbos: {
    name: "MBOS",
    tag: "Android app",
    what: "Visits, orders and payments, taken where the shop is — not typed in from memory back at the office.",
    who: "Field salesmen and the sales managers who work beats with them.",
    href: "/downloads/mbos.apk",
    action: "Download for Android",
    download: true,
    note: "Your phone will warn you it’s from outside the Play Store — that’s expected for an internal app. Already installed? Downloading again updates it in place, no need to uninstall first.",
  },
  factory: {
    name: "Mahek Factory",
    tag: "Phone app — opens in the browser",
    what: "Scan a job, follow the steps, count what was made and send it. Mixing, filling, packing and loading, recorded on the floor as the work is done — and it keeps working when the Wi-Fi drops.",
    who: "The mixing, filling, packing and dispatch teams, their supervisors, and the Production Head.",
    href: "/factory",
    action: "Open the Factory app",
    download: false,
    note: "Nothing to install. Open it on the phone, then tap the browser’s three-dot menu and choose “Add to Home screen” so it opens like any other app.",
  },
};

export function AppChooser({ initialTeam }: { initialTeam: Team | null }) {
  const [team, setTeam] = useState<Team | "">(initialTeam ?? "");
  const chosen = TEAMS.find((t) => t.id === team);
  const shown: AppId[] = chosen ? [chosen.app] : ["mbos", "factory"];

  return (
    <div className="flex w-full flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-left">
        <span className="text-sm font-medium text-ink">
          Which team are you from?
        </span>
        <select
          value={team}
          onChange={(e) => setTeam(e.target.value as Team | "")}
          className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-base text-ink outline-none focus:border-brand"
        >
          <option value="">Choose your team</option>
          {TEAMS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {!chosen && (
        <p className="-mt-2 text-left text-xs text-muted">
          Not sure? Both apps are below — pick the one that matches your work.
        </p>
      )}

      <div className="grid w-full grid-cols-1 gap-4">
        {shown.map((id) => (
          <AppCard key={id} app={APPS[id]} />
        ))}
      </div>
    </div>
  );
}

function AppCard({ app }: { app: (typeof APPS)[AppId] }) {
  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 text-left shadow-[0_1px_2px_rgba(26,30,40,0.04)]">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[6px] bg-brand-soft">
          <span className="block h-3.5 w-3.5 rounded-[3px] bg-brand" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg leading-6 font-semibold text-ink">
            {app.name}
          </h2>
          <p className="text-xs text-muted">{app.tag}</p>
        </div>
      </div>

      <dl className="flex flex-col gap-3">
        <div>
          <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            What is this app?
          </dt>
          <dd className="mt-1 text-sm leading-6 text-body">{app.what}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Who is this for?
          </dt>
          <dd className="mt-1 text-sm leading-6 text-body">{app.who}</dd>
        </div>
      </dl>

      <a
        href={app.href}
        download={app.download || undefined}
        className="hover:bg-brand-hover inline-flex h-12 w-full items-center justify-center rounded-[var(--radius-control)] bg-brand px-6 text-base font-medium text-white transition-colors"
      >
        {app.action}
      </a>

      <p className="text-xs leading-5 text-muted">{app.note}</p>
    </section>
  );
}
