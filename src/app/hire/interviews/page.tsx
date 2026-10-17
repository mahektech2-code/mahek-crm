import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { requireHireScreen } from "@/lib/hire/access";
import { listHumanInterviews, listVoiceScreens, voiceSetup, type InterviewRow } from "@/lib/hire/services/interview";
import { AiMark, BtnLink, Callout, Empty, Label, PageHead, Panel, Pill, fd, fdt, type Tone } from "../_ui/kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Interviews" };

const TABS = [
  ["human", "Human interviews"],
  ["voice", "AI voice screens"],
  ["setup", "AI interviewer setup"],
] as const;

const MODALITY: Record<string, string> = { in_person: "In person", video: "Video", phone: "Phone", ai_voice: "AI voice", async: "Async" };

function statusOf(r: InterviewRow): [string, Tone] {
  if (r.status === "in_progress" && r.sessionStatus === "live") return ["Live now", "info"];
  if (r.status === "in_progress" && r.toConfirm > 0) return ["Scores to confirm", "warn"];
  if (r.status === "in_progress") return ["In progress", "neutral"];
  if (r.status === "scheduled") return ["Scheduled", "neutral"];
  if (r.status === "completed") return ["Done", "success"];
  return ["Not scheduled", "muted"];
}

export default async function InterviewsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireHireScreen("interviews");
  const { tab: raw } = await searchParams;
  const tab = TABS.some((t) => t[0] === raw) ? raw! : "human";

  return (
    <div className="max-w-[1280px]">
      <PageHead title="Interviews" sub="Human interviews, AI voice screens in progress, and how the AI interviewer is set up." />
      <div className="mb-5 flex gap-1 border-b border-line">
        {TABS.map(([k, l]) => (
          <Link
            key={k}
            href={k === "human" ? "/hire/interviews" : `/hire/interviews?tab=${k}`}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm no-underline hover:no-underline", tab === k ? "border-brand font-medium text-brand-hover" : "border-transparent text-body hover:text-heading")}
          >
            {l}
          </Link>
        ))}
      </div>
      {tab === "human" ? <Human rows={await listHumanInterviews(ctx)} /> : tab === "voice" ? <Voice ctx={ctx} /> : <Setup />}
    </div>
  );
}

function Human({ rows }: { rows: InterviewRow[] }) {
  if (!rows.length) return <Empty title="No interviews on your list">Interviews appear here once a candidate reaches a scored stage you conduct.</Empty>;
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="grid grid-cols-[150px_1.4fr_1fr_1fr_110px_150px_130px] gap-3 border-b border-divider bg-page px-4 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        <span>When</span>
        <span>Candidate</span>
        <span>Stage</span>
        <span>Interviewer</span>
        <span>Modality</span>
        <span>Status</span>
        <span />
      </div>
      {rows.map((r) => {
        const [label, tone] = statusOf(r);
        const run =
          r.status === "completed"
            ? { href: `/hire/scoring/${r.execId}`, l: "View scores" }
            : r.status === "in_progress" && r.sessionStatus !== "live" && r.toConfirm > 0
              ? { href: `/hire/scoring/${r.execId}`, l: "Score" }
              : { href: `/hire/workspace/${r.execId}`, l: r.status === "in_progress" ? "Resume" : "Start" };
        return (
          <div key={r.execId} className="hire-row grid grid-cols-[150px_1.4fr_1fr_1fr_110px_150px_130px] items-center gap-3 border-b border-divider px-4 text-sm last:border-b-0">
            <span className="text-muted tabular-nums">{r.when ? (r.whenKind === "completed" ? fd(r.when) : fdt(r.when)) : "—"}</span>
            <span className="min-w-0">
              <Link href={`/hire/c/${r.applicationId}`} className="block truncate font-medium text-heading">
                {r.name}
              </Link>
              <span className="block truncate text-[13px] text-muted">{r.role}</span>
            </span>
            <span className="truncate">{r.stage}</span>
            <span className="truncate">{r.interviewer ?? "Unassigned"}</span>
            <span>{MODALITY[r.modality] ?? r.modality}</span>
            <span>
              <Pill tone={tone}>{label}</Pill>
            </span>
            <span className="text-right">
              <BtnLink href={run.href} size="sm" kind={run.l === "Start" || run.l === "Resume" ? "primary" : "secondary"}>
                {run.l}
              </BtnLink>
            </span>
          </div>
        );
      })}
    </div>
  );
}

async function Voice({ ctx }: { ctx: Parameters<typeof listVoiceScreens>[0] }) {
  const { live, done } = await listVoiceScreens(ctx);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Label className="mb-3">Live now · {live.length}</Label>
        {live.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
            {live.map((v) => (
              <div key={v.sessionId} className="overflow-hidden rounded-[6px] border border-ai-line bg-surface">
                <div className="flex items-center justify-between bg-ai-soft px-4 py-2 text-[13px] font-medium text-ai">
                  <span>
                    <AiMark /> AI interviewer · {v.language}
                  </span>
                  <span className="font-normal tabular-nums">since {fdt(v.startedAt)}</span>
                </div>
                <div className="px-4 py-3.5">
                  <div className="text-[15px] font-semibold text-heading">{v.name}</div>
                  <div className="text-[13px] text-muted">{v.role}</div>
                  {v.lastQuestion ? <div className="mt-3 text-[13px] text-body">Asking: {v.lastQuestion}</div> : null}
                  {v.lastSaid ? <div className="mt-2 border-l-2 border-line-strong pl-3 font-[family-name:var(--font-evidence)] text-[15px] leading-6 text-heading">“{v.lastSaid}”</div> : null}
                  <div className="mt-3.5 flex gap-2">
                    <BtnLink href={`/hire/screen/${v.execId}`} size="sm">
                      Listen in
                    </BtnLink>
                    <BtnLink href={`/hire/workspace/${v.execId}?takeover=1`} size="sm" kind="primary">
                      Take over
                    </BtnLink>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No AI screen is running">A screen in progress shows here, with what the AI is asking and the candidate’s last words. You can listen in or take the call over.</Empty>
        )}
      </div>
      <div>
        <Label className="mb-3">Completed, awaiting confirmation</Label>
        {done.length ? (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            {done.map((r) => (
              <div key={r.sessionId} className="hire-row grid grid-cols-[1.5fr_110px_150px_1fr_120px] items-center gap-3 border-b border-divider px-4 text-sm last:border-b-0">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-heading">{r.name}</span>
                  <span className="block truncate text-[13px] text-muted">{r.role}</span>
                </span>
                <span>{r.language}</span>
                <span className="text-muted tabular-nums">{fdt(r.endedAt)}</span>
                <span>
                  <Pill tone="warn">{r.toConfirm} AI score{r.toConfirm === 1 ? "" : "s"} to confirm</Pill>
                  {r.escalated ? <span className="ml-2 text-[13px] text-muted">{r.escalated}</span> : null}
                </span>
                <span className="text-right">
                  <BtnLink href={`/hire/voice/${r.sessionId}`} size="sm" kind="primary">
                    Review
                  </BtnLink>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing waiting">Every completed screen has had its scores confirmed by a person.</Empty>
        )}
      </div>
    </div>
  );
}

async function Setup() {
  const s = await voiceSetup();
  return (
    <div className="grid grid-cols-[1.6fr_1fr] gap-5">
      <div className="flex flex-col gap-5">
        {s.blueprints.length ? (
          s.blueprints.map((b) => (
            <Panel key={`${b.title}-${b.version}`} title={`${b.title} v${b.version} · ${b.stage}`} sub="From the blueprint’s AI voice screen stage, in order. The AI does not ask anything outside this list.">
              <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
                {b.questions.map((q, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-5 flex-none text-right text-muted tabular-nums">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-heading">{q.text}</span>
                      <span className="text-[13px] text-muted">
                        {q.competency} · {q.mode === "ai_rubric" ? "scored by AI against the rubric, confirmed by a person" : q.mode.replace("_", " ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          ))
        ) : (
          <Empty title="No published blueprint has an AI voice screen">Add an AI Screen stage to a blueprint in the studio.</Empty>
        )}
        <Callout tone="ai">
          <span className="font-medium">Opening, always said first.</span> “Namaste, this is Mahek Marketing’s AI interviewer — I am not a person. This call is recorded so the hiring team can review it. Is that all right? You can ask for a person at any time.”
        </Callout>
      </div>
      <div className="flex flex-col gap-5">
        <Panel title="Languages">
          <div className="flex flex-wrap gap-2">
            {s.languages.map((l) => (
              <Pill key={l} tone="neutral">
                {l}
              </Pill>
            ))}
          </div>
        </Panel>
        <Panel title="Call window and retries">
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-2 text-sm">
            <dt className="text-muted">Calls between (IST)</dt>
            <dd className="m-0 text-heading tabular-nums">{s.callWindow}</dd>
            <dt className="text-muted">Attempts before a person is scheduled</dt>
            <dd className="m-0 text-heading tabular-nums">{s.maxAttempts}</dd>
          </dl>
        </Panel>
        <Panel title="Hand the call to a person when">
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm text-body">
            <li>The candidate asks for a person</li>
            <li>The candidate refuses recording</li>
            <li>The candidate sounds distressed or confused</li>
            <li>The call drops twice</li>
          </ul>
          <p className="mt-3 mb-0 text-[13px] text-muted">The AI never states or hints at an outcome on the call. That rule cannot be switched off.</p>
        </Panel>
        {!s.aiOn ? <Callout tone="warn">{s.aiWhy} Voice screens fall back to scheduling a person.</Callout> : null}
        <div>
          <BtnLink href={ADMIN.settingsFor("hire")}>Change in Admin Console → Settings → Hire</BtnLink>
        </div>
      </div>
    </div>
  );
}
