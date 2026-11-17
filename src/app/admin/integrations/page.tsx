import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { CardGrid } from "@/components/ui/card-grid";
import Link from "next/link";
import { db } from "@/db";
import { waReplies, waTemplates } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { secretStatuses } from "@/lib/secrets";
import { OLA_KEY_NAMES, olaPoolStatus } from "@/lib/services/ola-key-service";
import { integrationStatus } from "@/lib/services/admin-platform-service";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { Card } from "@/components/ui/primitives";
import { HintTip } from "@/components/ui/hint-tip";
import { usageThisMonth } from "@/lib/services/admin-console-service";
import { sheetsConfigured } from "@/lib/sheets";
import { mailConfigured } from "@/lib/mailer";
import { shortDate, stamp } from "@/lib/format";
import { ADMIN } from "@/lib/admin-routes";
import type { TestableProvider } from "@/lib/actions/admin-console";
import { TestAll, TestButton } from "./test-button";
import { AdminPage } from "../_shell/admin-page";
import { Pill, Tabs, btnClass } from "../_shell/kit";
import { SecretCredentialRow } from "../secret-credential-row";
import { requirePlatformAdmin } from "../_shell/context";
import { IntegrationsTab } from "../platform-real";
import { MapsSection } from "../maps-section";
import { VoiceSection } from "../voice-section";

/**
 * Everything MahekOne calls out to, and the keys it calls with — on one page,
 * drawn as the canvas draws it: a card per service, a row per key.
 *
 * Every figure is read: which keys are held (last four only — `secretStatuses`
 * cannot return a key), the Ola pool's state, requests counted this month, the
 * WhatsApp switch, approved templates, the last delivery event. Money spent is
 * NOT shown: MahekOne counts requests and is sent no bill.
 */

const CATS = [
  { slug: "all", label: "All" },
  { slug: "maps", label: "Maps" },
  { slug: "messaging", label: "Messaging" },
  { slug: "ai", label: "AI" },
  { slug: "data", label: "Data" },
  { slug: "website", label: "Website" },
] as const;
type Cat = (typeof CATS)[number]["slug"];

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requirePlatformAdmin();
  const { tab: rawTab } = await searchParams;
  const tab: Cat = CATS.some((c) => c.slug === rawTab) ? (rawTab as Cat) : "all";
  const [config, secrets, olaPool, integrations, usage, wa, [tpl], [lastReply]] = await Promise.all([
    getConfig(),
    secretStatuses(),
    olaPoolStatus(),
    integrationStatus(),
    usageThisMonth(),
    whatsappServiceState(),
    db
      .select({ n: count() })
      .from(waTemplates)
      .where(and(eq(waTemplates.active, true), isNotNull(waTemplates.watiSpec))),
    db.select({ at: waReplies.receivedAt }).from(waReplies).orderBy(desc(waReplies.receivedAt)).limit(1),
  ]);
  const sec = (name: string) => secrets.find((s) => s.name === name);
  const held = (name: string) => (sec(name)?.source ?? "unset") !== "unset";
  const used = (id: string) => usage.find((u) => u.provider === id);
  const calls = (id: string) => used(id)?.calls ?? 0;
  const n = (v: number) => v.toLocaleString("en-IN");
  const totalCalls = usage.reduce((t, u) => t + u.calls, 0);

  const sheetRuns = integrations.filter((i) => i.name.startsWith("Google Sheet — "));
  const sheetsReading = sheetRuns.filter((i) => i.state === "Healthy").length;
  const sheetsFailing = sheetRuns.filter((i) => i.state === "Failing").length;
  const resend = mailConfigured();

  /* Each card's verdict: every key it needs held and nothing failing is
     Connected; something held but wrong is Needs attention; nothing held is
     Not set. The figures above count these, so the two cannot disagree. */
  const resting = olaPool.keys.filter((k) => k.state === "resting").length;
  const cards: { id: string; cat: Cat; state: "ok" | "warn" | "unset" }[] = [
    { id: "ola", cat: "maps", state: !olaPool.keys.length ? "unset" : olaPool.allSpent || resting ? "warn" : "ok" },
    { id: "wati", cat: "messaging", state: !held("wati.apiToken") ? "unset" : (used("wati")?.failures ?? 0) > 0 ? "warn" : "ok" },
    {
      id: "ai",
      cat: "ai",
      state: !held("openai.apiKey") && !held("anthropic.apiKey") && !held("sarvam.apiKey") ? "unset" : ["openai", "anthropic", "sarvam"].some((p) => (used(p)?.failures ?? 0) > 0) ? "warn" : "ok",
    },
    { id: "mail", cat: "messaging", state: !resend && !held("minimoth.apiKey") ? "unset" : !resend || !held("minimoth.apiKey") ? "warn" : "ok" },
    { id: "google", cat: "data", state: !sheetsConfigured() ? "unset" : sheetsFailing ? "warn" : "ok" },
    {
      id: "web",
      cat: "website",
      state: ["github.token", "website.cmsReadSecret", "website.cmsPublishSecret", "enquiries.ingestSecret"].every((k) => !held(k))
        ? "unset"
        : ["github.token", "website.cmsReadSecret", "website.cmsPublishSecret", "enquiries.ingestSecret"].every(held)
          ? "ok"
          : "warn",
    },
  ];
  const show = (id: string) => tab === "all" || cards.find((c) => c.id === id)?.cat === tab;
  const verdict = (id: string) => cards.find((c) => c.id === id)!.state;
  const stateLabel = (id: string, warn = "Needs attention") => {
    const v = verdict(id);
    return v === "ok" ? <Pill tone="ok">Connected</Pill> : v === "warn" ? <Pill tone="warn">{warn}</Pill> : <Pill tone="muted">Not set</Pill>;
  };

  const testable: { provider: TestableProvider; name: string }[] = [
    held("openai.apiKey") && { provider: "openai" as const, name: "OpenAI" },
    held("anthropic.apiKey") && { provider: "anthropic" as const, name: "Anthropic" },
    olaPool.keys.length > 0 && { provider: "ola" as const, name: "Ola Maps" },
    held("wati.apiToken") && { provider: "wati" as const, name: "Wati" },
    held("github.token") && { provider: "github" as const, name: "GitHub" },
    resend && { provider: "resend" as const, name: "Resend" },
  ].filter((x): x is { provider: TestableProvider; name: string } => Boolean(x));

  /*
   * Statuses only — which credentials exist, from where, and their last four
   * characters. `secretStatuses` cannot return a key, so nothing here can
   * start leaking one onto the page.
   */
  const row = (s: (typeof secrets)[number]) => ({
    name: s.name,
    source: s.source,
    last4: s.last4,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  });
  const canWrite = ctx.isPlatformAdmin;
  const last4 = (name: string) => {
    const s = sec(name);
    return s && s.source !== "unset" ? <KeyTail last4={s.last4} /> : <Pill tone="muted">Not set</Pill>;
  };
  const cms = ["website.cmsReadSecret", "website.cmsPublishSecret"].filter(held).length;

  return (
    <AdminPage
      title="Integrations & keys"
      subtitle="Every outside service MahekOne talks to, whether it is connected, and the keys it uses. Keys are set here so a deploy nobody has shell access to can still be connected."
      actions={
        <>
          <TestAll providers={testable} />
          <a href="#keys" className={`${btnClass("primary")} h-[38px]`}>
            Add a key
          </a>
        </>
      }
      figures={[
        { label: "Connected", value: n(cards.filter((c) => c.state === "ok").length) },
        { label: "Needs attention", value: n(cards.filter((c) => c.state === "warn").length), tone: cards.some((c) => c.state === "warn") ? "warn" : undefined },
        { label: "Not set", value: n(cards.filter((c) => c.state === "unset").length) },
        { label: "Requests this month", value: n(totalCalls), sub: `${n(usage.reduce((t, u) => t + u.today, 0))} today` },
      ]}
    >
      <Tabs
        items={CATS.map((c) => ({ slug: c.slug, label: c.label, href: c.slug === "all" ? ADMIN.integrations : `${ADMIN.integrations}?tab=${c.slug}` }))}
        active={tab}
      />

      <CardGrid min={340} gap="gap-4">
        {show("ola") ? (
          <Service
            logo="OM"
            title="Ola Maps"
            sub="Tiles · Snap-to-Road · geocoding"
            pill={
              olaPool.keys.length ? (
                <Pill tone={verdict("ola") === "ok" ? "ok" : "warn"}>
                  {olaPool.keys.length - resting} of {olaPool.keys.length} live
                </Pill>
              ) : (
                <Pill tone="muted">Not set</Pill>
              )
            }
          >
            {olaPool.keys.map((k, i) => {
              const firstLive = olaPool.keys.findIndex((x) => x.state !== "resting");
              return (
                <KeyRow key={k.name} label={`Key ${k.position}`}>
                  <KeyTail last4={sec(k.name)?.last4 ?? null} />
                  <span className="flex-1" />
                  {k.state === "resting" ? (
                    <Pill tone="warn" title={k.spentAt ? `Refused ${stamp(k.spentAt)}` : undefined}>
                      Resting{k.retryAt ? ` · ${shortDate(k.retryAt)}` : ""}
                    </Pill>
                  ) : i === firstLive ? (
                    <Pill tone="ok">In use</Pill>
                  ) : (
                    <Pill tone="muted">Standby</Pill>
                  )}
                  <EditLink to="maps" name={`Ola key ${k.position}`} />
                </KeyRow>
              );
            })}
            {!olaPool.keys.length ? (
              <KeyRow label="Key 1">
                <span className="flex-1 text-muted">No key — no map draws streets.</span>
                <SetLink to="maps" />
              </KeyRow>
            ) : null}
            <KeyRow label="This month" muted>
              <span className="flex-1 text-muted">{n(calls("ola"))} requests</span>
              {olaPool.keys.length ? <TestButton icon provider="ola" name="Ola Maps" /> : null}
            </KeyRow>
          </Service>
        ) : null}

        {show("wati") ? (
          <Service logo="W" title="Wati · WhatsApp" sub="Templates · replies · codes" pill={stateLabel("wati")}>
            <KeyRow label="Token">
              {last4("wati.apiToken")}
              <span className="flex-1 truncate text-right text-muted">{sec("wati.apiToken")?.updatedAt ? `Set ${shortDate(sec("wati.apiToken")!.updatedAt!)}` : ""}</span>
              {held("wati.apiToken") ? <TestButton icon provider="wati" name="Wati" /> : null}
            </KeyRow>
            <KeyRow label="Switch">
              <Pill tone={wa.active ? "ok" : "muted"}>{wa.active ? "On" : "Off"}</Pill>
              <span className="flex-1 text-right text-muted">Founder only</span>
            </KeyRow>
            <KeyRow label="Templates">
              <span className="flex-1">{n(tpl?.n ?? 0)} linked</span>
              <Link href="/founder/whatsapp" className="font-medium text-brand">
                Open
              </Link>
            </KeyRow>
            <KeyRow label="Webhook">
              {lastReply ? <Pill tone="ok">Last event {stamp(lastReply.at)}</Pill> : <span className="text-muted">No event received yet</span>}
            </KeyRow>
          </Service>
        ) : null}

        {show("ai") ? (
          <Service logo="AI" title="AI models" sub="Ask AI · dictation · readers" pill={stateLabel("ai")}>
            {(
              [
                ["OpenAI", "openai.apiKey", "openai", "openai"],
                ["Anthropic", "anthropic.apiKey", "anthropic", "anthropic"],
                ["Sarvam", "sarvam.apiKey", "sarvam", null],
              ] as const
            ).map(([label, key, id, test]) => (
              <KeyRow key={key} label={label}>
                {last4(key)}
                <span className="flex-1 text-right text-muted tabular-nums" title="Requests this month">
                  {held(key) ? `${n(calls(id))} req` : ""}
                </span>
                {held(key) && test ? <TestButton icon provider={test} name={label} /> : <EditLink to={key === "anthropic.apiKey" ? "price-ai" : "speech"} name={label} />}
              </KeyRow>
            ))}
          </Service>
        ) : null}

        {show("mail") ? (
          <Service logo="M" title="Mail & codes" sub="Resend · MiniMoth" pill={stateLabel("mail", `${[!resend, !held("minimoth.apiKey")].filter(Boolean).length} issue`)}>
            <KeyRow label="Resend">
              {resend ? <Pill tone="ok">Set</Pill> : <Pill tone="danger">Not set</Pill>}
              <span className="flex-1 text-muted">{resend ? "From the deployment's environment" : "Mail goes to the log"}</span>
              {resend ? <TestButton icon provider="resend" name="Resend" /> : null}
            </KeyRow>
            <KeyRow label="MiniMoth">
              {last4("minimoth.apiKey")}
              <span className="flex-1" />
              {held("minimoth.apiKey") ? <Pill tone="ok">{n(used("minimoth")?.today ?? 0)} today</Pill> : <SetLink to="sign-in-codes" />}
            </KeyRow>
          </Service>
        ) : null}

        {show("google") ? (
          <Service logo="G" title="Google Sheets" sub="Service account · read only" pill={stateLabel("google", `${sheetsFailing} failing`)}>
            <KeyRow label="Account">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{process.env.GOOGLE_SA_EMAIL ?? "Not set"}</span>
            </KeyRow>
            <KeyRow label="Workbooks">
              <span className="flex-1">
                {n(sheetsReading)} reading{sheetsFailing ? <span className="text-danger"> · {sheetsFailing} failing</span> : null}
              </span>
              <Link href={ADMIN.sheets()} className="font-medium text-brand">
                Open
              </Link>
            </KeyRow>
          </Service>
        ) : null}

        {show("web") ? (
          <Service logo="GH" navy title="GitHub · Website · Enquiries" sub="" pill={stateLabel("web")}>
            <KeyRow label="GitHub">
              {last4("github.token")}
              <span className="flex-1 text-right text-muted">Feedback fixes</span>
              {held("github.token") ? <TestButton icon provider="github" name="GitHub" /> : <EditLink to="github" name="GitHub" />}
            </KeyRow>
            <KeyRow label="CMS">
              <span className="flex-1 font-mono text-xs">{cms} of 2 secrets</span>
              <Pill tone={cms === 2 ? "ok" : cms ? "warn" : "muted"}>{cms === 2 ? "OK" : cms ? "One missing" : "Not set"}</Pill>
              <EditLink to="website-cms" name="Website CMS" />
            </KeyRow>
            <KeyRow label="Enquiries">
              {last4("enquiries.ingestSecret")}
              <span className="flex-1" />
              <EditLink to="enquiries" name="Website enquiries" />
            </KeyRow>
          </Service>
        ) : null}
      </CardGrid>

      <IntegrationsTab data={{ integrations }} />

      <div id="keys" className="mt-4 scroll-mt-6">
        <h2 className="m-0 text-[18px] leading-6 font-bold text-ink">Set or change a key</h2>
      </div>

      <Section id="speech" title="Speech and writing" hint={"The keys dictation calls out with. Which provider hears the speech, and which models are used, are settings — they live under Settings → Voice & AI."}>
        <VoiceSection
          data={{
            secrets: secrets.filter((s) => s.name === "sarvam.apiKey" || s.name === "openai.apiKey").map(row),
            provider: config["voice.transcriptionProvider"],
            fallbackToOpenai: config["voice.fallbackToOpenai"],
            sarvamModel: config["voice.transcriptionModel"],
            openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
            languageModel: config["voice.languageModel"],
            maxSeconds: config["voice.maxSeconds"],
            enabled: config["voice.enabled"],
            canWrite,
          }}
        />
      </Section>

      <Section
        id="price-ai"
        title="Price checks (AI)"
        hint="The second model that reviews price changes on the Price Desk, independently of OpenAI. Optional — without it OpenAI reviews alone, and the screens say so. AI never writes or approves a price."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "anthropic.apiKey")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "Anthropic API key",
                    env: "ANTHROPIC_API_KEY",
                    what: "Reviews each price change beside OpenAI without seeing its answer, gives a second opinion before approval, and reads special-price requests. Which model is a setting under Accounts → Settings → Price lists.",
                    where: "console.anthropic.com → Settings → API keys. A key restricted to this workspace is enough.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section
        id="enquiries"
        title="Website enquiries"
        hint="What the website's own backend proves it holds when it forwards a submitted enquiry. Server to server only — it never reaches a browser on either side."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "enquiries.ingestSecret")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "Website enquiry secret",
                    env: "ENQUIRY_INGEST_SECRET",
                    what: "Checked on every enquiry the website forwards to /api/public/enquiries. Anything arriving without it is refused.",
                    where: "Make one up — a long random string — and give the same value to whoever runs the website.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section
        id="website-cms"
        title="Website content (CMS)"
        hint="Connects the Website app to mahekindia.com: the site reads published content from here, and a publish tells the site to refresh. Server to server only — neither value reaches a browser. Nothing changes on the live site until the site is also switched on (CMS_ENABLED on its server)."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "website.cmsReadSecret")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "Website content read secret",
                    env: "WEBSITE_CMS_READ_SECRET",
                    what: "Checked on every read of published content and uploaded images by the public site. Anything arriving without it is refused.",
                    where: "Make one up — a long random string — and give the same value to whoever runs the website as CMS_READ_SECRET.",
                  }}
                />
              ))}
            {secrets
              .filter((s) => s.name === "website.cmsPublishSecret")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "Website publish secret",
                    env: "WEBSITE_CMS_PUBLISH_SECRET",
                    what: "Sent with every request that tells the public site to refresh after a publish, and used to sign preview links.",
                    where: "Make up a second long random string and give the same value to whoever runs the website as CMS_PUBLISH_SECRET.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section
        id="github"
        title="Fixing feedback (GitHub)"
        hint="Lets the console send a feedback report to the developer as a GitHub issue, ask Claude to fix it, and close the report itself once the fix is live. Without it, Copy for developer still works."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "github.token")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "GitHub token",
                    env: "GITHUB_FEEDBACK_TOKEN",
                    what: "Opens an issue for a report, adds the label that starts Claude's fix, and reads which pull request fixed it and whether that is in the build now serving. Which repository is a setting under Settings → AI assistants → Fixing feedback.",
                    where: "github.com → Settings → Developer settings → Fine-grained tokens. Only the MahekOne repository, with Issues: read and write, Pull requests: read, Contents: read, Metadata: read.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section
        id="sign-in-codes"
        title="Sign-in codes"
        hint="The key MiniMoth sends one-time sign-in codes with — for the MahekOne web sign-in, the MBOS handset, and password resets. Setting it is what switches codes on."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "minimoth.apiKey")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "MiniMoth API key",
                    env: "MINIMOTH_API_KEY",
                    what: "Sends every OTP to the personal mobile in HRMS (through the account's HRMS link), on WhatsApp first and by SMS when WhatsApp does not deliver. No DLT registration of ours is involved.",
                    where: "app.minimoth.dev → your project → API keys. Use the live key (mm_live_…) here; a test key sends nothing and is ignored in production.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section id="maps" title="Maps" hint={"The key the Live map and Territory's shop map call Ola Maps with — for the streets under both, and for laying a salesman's trail onto the road he actually walked."}>
        <MapsSection
          data={{
            /* All five pool names, in order. The screen decides which to draw —
               an unset slot is not a gap to be filled. */
            secrets: (OLA_KEY_NAMES as readonly string[]).flatMap((name) => secrets.filter((s) => s.name === name)).map(row),
            pool: olaPool.keys.map((k) => ({
              name: k.name,
              position: k.position,
              state: k.state,
              retryAt: k.retryAt ? k.retryAt.toISOString() : null,
              spentAt: k.spentAt ? k.spentAt.toISOString() : null,
            })),
            allKeysSpent: olaPool.allSpent,
            canWrite,
          }}
        />
      </Section>
    </AdminPage>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-6">
      <h2 className="mb-4 flex items-center gap-2 text-lg leading-6 font-bold text-ink">
        {title}
        <HintTip text={hint} />
      </h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ the cards */

function Service({
  logo,
  title,
  sub,
  pill,
  navy = false,
  children,
}: {
  logo: string;
  title: string;
  sub: string;
  pill: React.ReactNode;
  navy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-start gap-3 border-b border-divider px-[18px] py-4">
        <span
          aria-hidden
          className={`inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg text-[13px] font-bold ${navy ? "bg-ink text-white" : "bg-brand-softer text-brand-deep"}`}
        >
          {logo}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[16px] leading-[22px] font-bold text-ink">{title}</h2>
          {sub ? <div className="text-[13px] text-muted">{sub}</div> : null}
        </div>
        <span className="pt-0.5">{pill}</span>
      </div>
      {children}
    </section>
  );
}

function KeyRow({ label, muted = false, children }: { label: string; muted?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 border-b border-divider px-[18px] py-2.5 text-[13px] last:border-b-0">
      <span className={`min-w-[72px] font-semibold ${muted ? "font-normal text-muted" : "text-ink"}`}>{label}</span>
      {children}
    </div>
  );
}

function KeyTail({ last4 }: { last4: string | null }) {
  return <span className="font-mono text-xs text-body">····{last4 ?? "····"}</span>;
}

/** The pen on a key row: down to where that key is changed. */
function EditLink({ to, name }: { to: string; name: string }) {
  return (
    <a
      href={`#${to}`}
      title={`Change ${name}`}
      aria-label={`Change ${name}`}
      className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control border border-line-strong bg-surface text-ink no-underline hover:bg-[#f7f9fc]"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    </a>
  );
}

function SetLink({ to }: { to: string }) {
  return (
    <a href={`#${to}`} className={btnClass("plain", "sm")}>
      Set
    </a>
  );
}
