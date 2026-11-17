import { getConfig } from "@/lib/config/store";
import { secretStatuses } from "@/lib/secrets";
import { OLA_KEY_NAMES, olaPoolStatus } from "@/lib/services/ola-key-service";
import { integrationStatus } from "@/lib/services/admin-platform-service";
import { Badge, Card } from "@/components/ui/primitives";
import { HintTip } from "@/components/ui/hint-tip";
import { usageThisMonth } from "@/lib/services/admin-console-service";
import { sheetsConfigured } from "@/lib/sheets";
import type { TestableProvider } from "@/lib/actions/admin-console";
import { TestButton } from "./test-button";
import { AdminPage } from "../_shell/admin-page";
import { SecretCredentialRow } from "../secret-credential-row";
import { requirePlatformAdmin } from "../_shell/context";
import { IntegrationsTab } from "../platform-real";
import { MapsSection } from "../maps-section";
import { VoiceSection } from "../voice-section";

/**
 * Everything MahekOne calls out to, and the keys it calls with — on one page.
 *
 * Credentials were in three places: Voice and Maps each had a section of their
 * own, and Overview → Integrations listed the rest while leaving those two
 * out. "Is everything we pay for connected" is one question, and it now has
 * one answer.
 */
export default async function IntegrationsPage() {
  const ctx = await requirePlatformAdmin();
  const [config, secrets, olaPool, integrations, usage] = await Promise.all([
    getConfig(),
    secretStatuses(),
    olaPoolStatus(),
    integrationStatus(),
    usageThisMonth(),
  ]);
  const held = (name: string) => secrets.some((s) => s.name === name && s.source !== "unset");
  const used = (id: string) => usage.find((u) => u.provider === id);
  const cards = CONNECTIONS.map((c) => ({
    ...c,
    set: c.key === "env:RESEND_API_KEY" ? Boolean(process.env.RESEND_API_KEY) : c.key ? held(c.key) : sheetsConfigured(),
    use: used(c.id),
  }));
  const totalCalls = usage.reduce((n, u) => n + u.calls, 0);
  const totalFailures = usage.reduce((n, u) => n + u.failures, 0);

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

  return (
    <AdminPage
      title="Integrations & keys"
      subtitle="Every outside service MahekOne talks to, whether it is connected, and the keys it uses. Keys are set here so a deploy nobody has shell access to can still be connected."
      metrics={[
        { label: "Connected", value: String(cards.filter((c) => c.set).length), tone: "success" },
        { label: "Not set", value: String(cards.filter((c) => !c.set).length), tone: cards.some((c) => !c.set) ? "warn" : undefined },
        { label: "Requests this month", value: totalCalls.toLocaleString("en-IN") },
        { label: "Failed this month", value: totalFailures.toLocaleString("en-IN"), tone: totalFailures ? "warn" : undefined },
      ]}
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {cards.map((c) => (
          <Card key={c.id} className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-semibold text-ink">{c.name}</span>
              <Badge tone={c.set ? "success" : "warn"}>{c.set ? "Key set" : "Not set"}</Badge>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-ink tabular-nums">{(c.use?.calls ?? 0).toLocaleString("en-IN")}</span>
              <span className="text-xs text-muted">requests this month</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="flex-1">
                {c.use?.today ?? 0} today
                {c.use?.failures ? <span className="text-danger"> · {c.use.failures} failed</span> : null}
              </span>
              {c.test && c.set ? <TestButton provider={c.test} name={c.name} /> : null}
            </div>
          </Card>
        ))}
      </div>

      <IntegrationsTab data={{ integrations }} />

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

/**
 * One card per outside service. `key` is the credential whose presence says
 * "set" (an env name for Resend, which is not a console credential); `test`
 * is offered only where a read-only request exists.
 */
const CONNECTIONS: { id: string; name: string; key: string | null; test: TestableProvider | null }[] = [
  { id: "openai", name: "OpenAI", key: "openai.apiKey", test: "openai" },
  { id: "anthropic", name: "Anthropic", key: "anthropic.apiKey", test: "anthropic" },
  { id: "sarvam", name: "Sarvam", key: "sarvam.apiKey", test: null },
  { id: "ola", name: "Ola Maps", key: "olamaps.apiKey", test: "ola" },
  { id: "wati", name: "Wati · WhatsApp", key: "wati.apiToken", test: "wati" },
  { id: "minimoth", name: "MiniMoth · codes", key: "minimoth.apiKey", test: null },
  { id: "resend", name: "Resend · mail", key: "env:RESEND_API_KEY", test: "resend" },
  { id: "github", name: "GitHub", key: "github.token", test: "github" },
  { id: "google", name: "Google Sheets", key: null, test: null },
];

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
