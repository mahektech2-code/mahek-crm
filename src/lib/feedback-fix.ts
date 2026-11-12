import { z } from "zod";

/* ---------------------------------------------------------------------------
 * FIXING A REPORT — the rules, pure and client-safe.
 *
 * Most of what the team sends in is not a fault in the code. A shop on the
 * wrong salesman, a setting nobody changed, a screen somebody was never
 * given, a button nobody knew was there: each is fixed in minutes by the
 * team, and a developer handed one wastes a day finding there is nothing to
 * change. So the first question about every report is WHAT IT NEEDS, and only
 * a code change goes to GitHub. Everything else is answered with the steps
 * the team takes itself.
 *
 * The console draws from this file and the server acts on it, so the screen
 * and the action cannot disagree about when "Ask Claude to fix" is offered.
 * ------------------------------------------------------------------------- */

export const FIX_NEEDS = ["code_change", "data_fix", "setting", "access", "how_to", "not_a_fault"] as const;
export type FixNeed = (typeof FIX_NEEDS)[number];

export const NEED_LABELS: Record<FixNeed, string> = {
  code_change: "A change to the code",
  data_fix: "A record to correct",
  setting: "A setting to change",
  access: "Somebody's access",
  how_to: "How to use it",
  not_a_fault: "Not a fault",
};

/** One line under the label, saying who does the work. */
export const NEED_HINTS: Record<FixNeed, string> = {
  code_change: "Only a developer can fix this. Send it to GitHub, or ask Claude to write the fix.",
  data_fix: "The team can fix this today — a record is wrong, not the software.",
  setting: "An administrator can fix this on a settings page. No code changes.",
  access: "Fixed on Admin Console → Access. No code changes.",
  how_to: "Nothing is broken — reply with how to do it.",
  not_a_fault: "It works as it was decided to. Reply with why, or mark it Not doing.",
};

export const needsCode = (need: FixNeed | null | undefined) => need === "code_change";

/** What the AI reads a report into. Every key always present. */
export const diagnosisSchema = z.object({
  need: z.enum(FIX_NEEDS),
  /** One sentence: what is actually wrong, in the team's words. */
  summary: z.string().max(400),
  /**
   * For a code change, what the developer should check. For anything else,
   * the steps the team takes — in order, each a short instruction naming the
   * screen ("Admin Console → Access → Priya → tick Payment follow-up").
   */
  steps: z.array(z.string().max(300)).max(8),
  /** The screen or area it is about, if it can be told. */
  where: z.string().max(200).nullable(),
  /** How sure, 0–100. Below 60 the console says to check before acting. */
  confidence: z.number().min(0).max(100),
  /** What to ask the reporter, where the report does not say enough. */
  question: z.string().max(300).nullable(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const UNSURE_BELOW = 60;

/* -------------------------------------------------------------- redaction */

/**
 * What goes to GitHub carries no phone number, email, GSTIN, PAN or Aadhaar.
 * Customer and shop NAMES stay — Mahek's call, Nov 2026: the repository is
 * private, and "Shree Ganesh Paints shows the wrong balance" is the bug report.
 */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, "[GSTIN]")
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[PAN]")
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[number]")
    .replace(/(?:\+91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]");
}

/* ------------------------------------------------------------ route hints */

/** A path segment that is a record, not a route: an id, a number, a slug with digits. */
function isRecordSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (/^[a-z]{2,8}_[A-Za-z0-9-]{6,}$/.test(seg)) return true;
  if (/^[0-9a-f-]{16,}$/i.test(seg)) return true;
  return /\d/.test(seg) && seg.length >= 10;
}

/**
 * Where the screen they were on probably lives in the source. A guess, and
 * said as one: the route is real, the folder name for a record segment is
 * not known from here (`[id]`, `[customerId]`…), so it is written `[…]`.
 */
export function routeHint(path: string | null | undefined): string | null {
  if (!path) return null;
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "");
  if (!clean.startsWith("/")) return null;
  const segs = clean.split("/").filter(Boolean).map((s) => (isRecordSegment(s) ? "[…]" : s));
  return `src/app/${segs.join("/")}${segs.length ? "/" : ""}page.tsx`;
}

/* ----------------------------------------------------------------- issue */

export type IssueInput = {
  ref: string;
  rowId: string;
  kind: string;
  impact: string | null;
  app: string | null;
  path: string | null;
  title: string;
  body: string;
  byName: string;
  sentOn: string;
  browser: string | null;
  also: { byName: string; body: string }[];
  thread: { who: string; body: string; teamNote: boolean }[];
  screenshots: number;
  diagnosis: Diagnosis | null;
  consoleUrl: string | null;
};

const quote = (t: string) =>
  redact(t.trim())
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

export const issueMarker = (ref: string, rowId: string) => `<!-- mahekone-feedback:${ref} id=${rowId} -->`;

/** Read the marker back off an issue or PR body. */
export function readMarker(body: string | null | undefined): { ref: string; rowId: string } | null {
  const m = body?.match(/<!-- mahekone-feedback:(FB-\d+) id=([\w-]+) -->/);
  return m ? { ref: m[1], rowId: m[2] } : null;
}

export function issueTitle(i: Pick<IssueInput, "ref" | "title">): string {
  return `${i.ref}: ${redact(i.title)}`.slice(0, 200);
}

export function issueBody(i: IssueInput): string {
  const hint = routeHint(i.path);
  const d = i.diagnosis;
  const lines = [
    `**${i.ref}** · ${i.kind}${i.impact ? ` · ${i.impact}` : ""} · ${i.app ?? "no app"}${i.path ? ` · \`${i.path}\`` : ""}`,
    `Reported by ${i.byName} on ${i.sentOn}${i.also.length ? ` — and ${i.also.length} more with the same problem` : ""}.`,
    "",
    "## What they said",
    quote(`${i.title}\n\n${i.body}`),
  ];
  if (i.also.length) {
    lines.push("", "## Also reported");
    for (const a of i.also) lines.push(`**${a.byName}**`, quote(a.body), "");
  }
  const said = i.thread.filter((m) => m.body.trim());
  if (said.length) {
    lines.push("", "## The conversation so far");
    for (const m of said) lines.push(`**${m.who}${m.teamNote ? " (team note)" : ""}**`, quote(m.body), "");
  }
  if (d) {
    lines.push("", "## What it probably needs", `${d.summary} _(AI read, ${Math.round(d.confidence)}% sure)_`);
    if (d.where) lines.push("", `Area: ${redact(d.where)}`);
    if (d.steps.length) lines.push("", ...d.steps.map((s, n) => `${n + 1}. ${redact(s)}`));
  }
  lines.push("", "## Where to look");
  if (i.path) lines.push(`- Screen: \`${i.path.split(/[?#]/)[0]}\``);
  if (hint) lines.push(`- Probably \`${hint}\` (a guess from the address; \`[…]\` is a record id)`);
  if (i.browser) lines.push(`- Browser: ${i.browser}`);
  if (i.screenshots) {
    lines.push(
      `- ${i.screenshots} screenshot${i.screenshots === 1 ? "" : "s"} — private to MahekOne${i.consoleUrl ? `, open them in the console: ${i.consoleUrl}` : ", open the report in the Admin Console"}`,
    );
  }
  lines.push(
    "",
    "## For whoever fixes it",
    "- Read `AGENTS.md` first; the rules there override anything here.",
    "- Make the smallest change that fixes what the reporter saw, and add or extend a test that would have caught it.",
    "- Run `npm run test` and `npx tsc --noEmit` before opening the pull request.",
    `- Open the pull request against \`main\`. Its description must say \`Fixes #<this issue>\` and \`Feedback: ${i.ref}\` — that is how MahekOne closes the report and tells ${i.byName.split(" ")[0]} once the fix is live.`,
    "- If the report does not say enough to fix it, comment on this issue with the question instead of guessing.",
    "",
    issueMarker(i.ref, i.rowId),
  );
  return lines.join("\n");
}

/* --------------------------------------------------------------- the road */

export type FixStage = "none" | "read" | "team" | "issue" | "claude" | "pr" | "merged" | "live" | "closed_pr";

export type FixState = {
  need: FixNeed | null;
  issueNumber: number | null;
  aiFixRequestedAt: string | null;
  prState: "open" | "merged" | "closed" | null;
  deployedAt: string | null;
};

/** Where a fix has got to, in one word the console turns into a line. */
export function fixStage(f: FixState | null): FixStage {
  if (!f) return "none";
  if (f.deployedAt) return "live";
  if (f.prState === "merged") return "merged";
  if (f.prState === "open") return "pr";
  if (f.prState === "closed") return "closed_pr";
  if (f.aiFixRequestedAt) return "claude";
  if (f.issueNumber) return "issue";
  if (f.need && !needsCode(f.need)) return "team";
  return f.need ? "read" : "none";
}

export const FIX_STAGE_LABELS: Record<FixStage, string> = {
  none: "Not checked yet",
  read: "Needs a code change",
  team: "The team can fix it",
  issue: "With the developer",
  claude: "Claude is writing a fix",
  pr: "Fix waiting for review",
  merged: "Fix merged — waiting to go live",
  live: "Fix is live",
  closed_pr: "Fix was not merged",
};

/** What may be offered, given where it is and who is looking. */
export function fixActions(
  f: FixState | null,
  who: { platformAdmin: boolean; connected: boolean },
): { sendToDeveloper: boolean; askClaude: boolean; askClaudeWhyNot: string | null } {
  const code = needsCode(f?.need ?? null);
  const live = !!f?.deployedAt;
  const sendToDeveloper = code && who.connected && !f?.issueNumber && !live;
  const canClaude = code && who.connected && !f?.aiFixRequestedAt && f?.prState !== "open" && f?.prState !== "merged" && !live;
  const askClaudeWhyNot = !code
    ? "Only a report that needs a code change can go to Claude."
    : !who.connected
      ? "Connect GitHub on Admin Console → Integrations first."
      : !who.platformAdmin
        ? "Only a platform administrator can ask Claude to write a fix."
        : null;
  return { sendToDeveloper, askClaude: canClaude && who.platformAdmin, askClaudeWhyNot: canClaude ? askClaudeWhyNot : null };
}

/**
 * Whether a merged commit is in the build now serving. GitHub's compare of
 * `merged...build` answers `ahead` (the build has more on top) or `identical`
 * where it is in; `behind` or `diverged` where it is not.
 */
export const commitIsInBuild = (compareStatus: string | null | undefined) =>
  compareStatus === "ahead" || compareStatus === "identical";

/** A build id that names a commit — `dev` and empty never do. */
export const isCommitBuild = (build: string | null | undefined): build is string =>
  !!build && /^[0-9a-f]{7,40}$/i.test(build);
