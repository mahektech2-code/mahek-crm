import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { feedback, feedbackFixes, feedbackMessages, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { readStructured } from "@/lib/structured-read";
import { stamp } from "@/lib/format";
import { APPS } from "@/lib/apps";
import { ADMIN } from "@/lib/admin-routes";
import { notifyUsers } from "@/lib/notify";
import { KIND_SHORT, IMPACT_SHORT, feedbackRef } from "@/lib/feedback-labels";
import {
  FIX_NEEDS,
  commitIsInBuild,
  diagnosisSchema,
  isCommitBuild,
  issueBody,
  issueTitle,
  redact,
  routeHint,
  type Diagnosis,
  type FixNeed,
} from "@/lib/feedback-fix";
import { getFeedback, type FeedbackRow } from "./feedback-service";

/* ---------------------------------------------------------------------------
 * FIXING A REPORT, wired to the database, the model and GitHub.
 *
 * Four steps, each a write here and a button in the console:
 *   1. read it — what does it need? (the AI, overrulable by a person)
 *   2. send it to the developer — a GitHub issue, only for a code change
 *   3. ask Claude — the label the repository's Claude workflow starts on
 *   4. close the loop — the hourly check finds the pull request that fixed it,
 *      waits until its commit is in the build now serving, and closes the
 *      report, telling everybody who reported it.
 *
 * Nothing here throws at a caller: GitHub down, no token, a model that will
 * not answer — each is an answer in words, and the report is never touched
 * by a step that failed.
 * ------------------------------------------------------------------------- */

const APP_NAME = new Map(APPS.map((a) => [a.id as string, a.name]));

export type FixView = {
  need: FixNeed | null;
  needByPerson: boolean;
  diagnosis: Diagnosis | null;
  diagnosedAt: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  aiFixRequestedAt: string | null;
  aiFixRequestedByName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: "open" | "merged" | "closed" | null;
  deployedAt: string | null;
  checkedAt: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function getFix(feedbackId: string): Promise<FixView | null> {
  const [r] = await db.select().from(feedbackFixes).where(eq(feedbackFixes.feedbackId, feedbackId)).limit(1);
  if (!r) return null;
  let requester: string | null = null;
  if (r.aiFixRequestedById) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, r.aiFixRequestedById)).limit(1);
    requester = u?.name ?? null;
  }
  const parsed = diagnosisSchema.safeParse(r.diagnosis);
  return {
    need: (FIX_NEEDS as readonly string[]).includes(r.need ?? "") ? (r.need as FixNeed) : null,
    needByPerson: !!r.needDecidedById,
    diagnosis: parsed.success ? parsed.data : null,
    diagnosedAt: iso(r.diagnosedAt),
    issueNumber: r.issueNumber,
    issueUrl: r.issueUrl,
    aiFixRequestedAt: iso(r.aiFixRequestedAt),
    aiFixRequestedByName: requester,
    prNumber: r.prNumber,
    prUrl: r.prUrl,
    prState: (r.prState as FixView["prState"]) ?? null,
    deployedAt: iso(r.deployedAt),
    checkedAt: iso(r.checkedAt),
  };
}

async function upsertFix(feedbackId: string, set: Partial<typeof feedbackFixes.$inferInsert>) {
  await db
    .insert(feedbackFixes)
    .values({ feedbackId, ...set })
    .onConflictDoUpdate({ target: feedbackFixes.feedbackId, set: { ...set, updatedAt: new Date() } });
}

/* ------------------------------------------------------------------ GitHub */

type Gh = { ok: true; json: unknown } | { ok: false; status: number; error: string };

/** Whether a token is set — the console offers GitHub steps only then. */
export async function githubConnected(): Promise<boolean> {
  return !!(await readSecret("github.token"));
}

async function gh(path: string, init?: { method?: string; body?: unknown }): Promise<Gh> {
  const token = await readSecret("github.token");
  if (!token) return { ok: false, status: 0, error: "GitHub is not connected — add a token on Admin Console → Integrations." };
  const repo = (await getConfig())["feedbackFix.githubRepo"].trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, status: 0, error: "The GitHub repository setting is not owner/name." };
  const url = path.startsWith("https://") ? path : `https://api.github.com/repos/${repo}${path}`;
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MahekOne-feedback",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json as { message?: string } | null)?.message ?? res.statusText;
      const words =
        res.status === 401
          ? "GitHub refused the token — it may have expired. Set a new one on Admin Console → Integrations."
          : res.status === 403 || res.status === 404
            ? `GitHub would not let the token do that (${msg}). It needs Issues: read and write on the repository.`
            : `GitHub answered ${res.status}: ${msg}`;
      return { ok: false, status: res.status, error: words };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, status: 0, error: `GitHub could not be reached (${e instanceof Error ? e.message : "network"}).` };
  }
}

/* --------------------------------------------------------------- 1. read it */

const SYSTEM = `You triage feedback sent in by staff of Mahek Marketing India about MahekOne, their in-house business software (a telecaller CRM, Accounts, a Sales Dashboard with a field salesman app, an ERP for the factory, HRMS and more).

Decide what the report NEEDS, choosing exactly one:
- code_change: the software behaves wrongly or a feature is missing, and only changing the code can fix it (an error message, a crash, a wrong figure from a calculation, a button that does nothing, a layout that breaks, a requested new feature).
- data_fix: the software works but a record is wrong — a customer on the wrong salesman, a duplicate, a wrong phone number, a bill amount, an order stuck in a status. The team corrects the record.
- setting: a threshold, a list or a switch somebody can change on a settings page (Admin Console → Settings, or an app's Settings).
- access: somebody cannot open a screen, or can see what they should not — fixed on Admin Console → Access.
- how_to: nothing is broken; they do not know how to do something.
- not_a_fault: it works as designed; the report disagrees with a decision.

Prefer the cheaper answer when the report fits it: "I cannot see the Payments screen" is access, not code; "this shop shows under Rakesh" is data_fix. Choose code_change only when the report describes the software itself being wrong.

steps: for code_change, up to five things a developer should check or reproduce. For anything else, the steps the team takes, in order, each naming the screen. summary: one plain sentence. question: what to ask the reporter if the report does not say enough, else null. Never invent a fact the report does not state.`;

function promptFor(r: FeedbackRow): string {
  const lines = [
    `Report ${r.ref} — ${KIND_SHORT[r.kind]}${r.impact ? ` (${IMPACT_SHORT[r.impact]})` : ""}`,
    `App: ${r.app ? (APP_NAME.get(r.app) ?? r.app) : "unknown"}; screen: ${r.path ?? "unknown"}${routeHint(r.path) ? ` (route ${routeHint(r.path)})` : ""}`,
    `Title: ${redact(r.title)}`,
    "",
    redact(r.body),
  ];
  for (const a of r.alsoReported) lines.push("", `Also reported by another person: ${redact(a.body)}`);
  for (const m of r.messages) {
    if (m.body?.trim()) lines.push("", `${m.fromSubmitter ? "Reporter" : m.internal ? "Team note" : "Team"}: ${redact(m.body)}`);
  }
  return lines.join("\n");
}

const SHAPE = `{"need": one of ${FIX_NEEDS.join("|")}, "summary": string, "steps": string[], "where": string|null, "confidence": number 0-100, "question": string|null}`;

/**
 * Reads a report into what it needs. A need a PERSON chose is never written
 * over — the AI's reading is still stored beside it, for the steps.
 */
export async function diagnoseFeedback(
  rootId: string,
  actorId: string | null,
): Promise<{ ok: true; fix: FixView } | { ok: false; error: string }> {
  const config = await getConfig();
  if (!config["feedbackFix.enabled"]) return { ok: false, error: "The AI check is switched off in Settings → AI assistants." };
  const report = await getFeedback(rootId);
  if (!report) return { ok: false, error: "That report is no longer here." };

  const { output, model } = await readStructured({
    label: "feedback-fix",
    system: SYSTEM,
    prompt: promptFor(report),
    schema: diagnosisSchema,
    shapeHint: SHAPE,
    model: config["feedbackFix.model"],
  });
  if (!output) return { ok: false, error: "No AI model could read it just now — choose what it needs by hand." };

  const [existing] = await db
    .select({ needDecidedById: feedbackFixes.needDecidedById })
    .from(feedbackFixes)
    .where(eq(feedbackFixes.feedbackId, rootId))
    .limit(1);
  await upsertFix(rootId, {
    ...(existing?.needDecidedById ? {} : { need: output.need }),
    diagnosis: output,
    diagnosisModel: model,
    diagnosedAt: new Date(),
    diagnosedById: actorId,
  });
  return { ok: true, fix: (await getFix(rootId))! };
}

/** A person says what it needs. The AI never answers it again. */
export async function setNeed(rootId: string, need: FixNeed, actorId: string) {
  await upsertFix(rootId, { need, needDecidedById: actorId });
}

/* ------------------------------------------------- 2. send to the developer */

function browserOf(ua: string | null) {
  if (!ua) return null;
  const name = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return [name, os].filter(Boolean).join(" on ");
}

function consoleUrl(rowId: string): string | null {
  const base = process.env.APP_URL?.replace(/\/$/, "");
  return base ? `${base}${ADMIN.feedback()}?r=${rowId}` : null;
}

/** Opens the GitHub issue, once. A second press answers with the first. */
export async function createIssue(
  rootId: string,
  actorId: string,
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const fix = await getFix(rootId);
  if (fix?.issueNumber && fix.issueUrl) return { ok: true, number: fix.issueNumber, url: fix.issueUrl };
  if (fix?.need !== "code_change") return { ok: false, error: "Only a report that needs a code change goes to GitHub." };
  const r = await getFeedback(rootId);
  if (!r) return { ok: false, error: "That report is no longer here." };

  const screenshots =
    r.attachments.length +
    r.alsoReported.reduce((n, a) => n + a.attachments.length, 0) +
    r.messages.reduce((n, m) => n + m.attachments.length, 0);
  const body = issueBody({
    ref: r.ref,
    rowId: r.id,
    kind: KIND_SHORT[r.kind],
    impact: r.impact ? IMPACT_SHORT[r.impact] : null,
    app: r.app ? (APP_NAME.get(r.app) ?? r.app) : null,
    path: r.path,
    title: r.title,
    body: r.body,
    byName: r.byName,
    sentOn: stamp(r.createdAt),
    browser: browserOf(r.userAgent),
    also: r.alsoReported.map((a) => ({ byName: a.byName, body: a.body })),
    thread: r.messages.map((m) => ({ who: m.authorName, body: m.body ?? "", teamNote: m.internal })),
    screenshots,
    diagnosis: fix?.diagnosis ?? null,
    consoleUrl: consoleUrl(r.id),
  });
  const res = await gh("/issues", { method: "POST", body: { title: issueTitle(r), body, labels: ["feedback"] } });
  if (!res.ok) {
    // A missing "feedback" label is created by GitHub on the fly for a token
    // with write access; a 422 on labels is retried without it.
    if (res.status === 422) {
      const again = await gh("/issues", { method: "POST", body: { title: issueTitle(r), body } });
      if (!again.ok) return { ok: false, error: again.error };
      return recordIssue(rootId, actorId, again.json);
    }
    return { ok: false, error: res.error };
  }
  return recordIssue(rootId, actorId, res.json);
}

async function recordIssue(rootId: string, actorId: string, json: unknown) {
  const issue = json as { number?: number; html_url?: string };
  if (!issue?.number || !issue.html_url) return { ok: false as const, error: "GitHub did not say which issue it opened." };
  await upsertFix(rootId, {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    issueCreatedAt: new Date(),
    issueCreatedById: actorId,
  });
  await teamNote(rootId, actorId, `Sent to the developer as GitHub issue #${issue.number}.`);
  return { ok: true as const, number: issue.number, url: issue.html_url };
}

/* ------------------------------------------------------------ 3. ask Claude */

/**
 * Opens the issue if there is none, then puts the label on it that the
 * repository's Claude fix workflow starts on. The pull request Claude opens
 * is reviewed and merged by a person; nothing here merges anything.
 */
export async function requestAiFix(
  rootId: string,
  actorId: string,
): Promise<{ ok: true; issueNumber: number } | { ok: false; error: string }> {
  const fix = await getFix(rootId);
  if (fix?.need !== "code_change") return { ok: false, error: "Only a report that needs a code change can go to Claude." };
  if (fix.aiFixRequestedAt) return { ok: false, error: "Claude has already been asked to fix this one." };
  const issue = await createIssue(rootId, actorId);
  if (!issue.ok) return issue;

  const label = (await getConfig())["feedbackFix.aiFixLabel"].trim() || "ai-fix";
  const res = await gh(`/issues/${issue.number}/labels`, { method: "POST", body: { labels: [label] } });
  if (!res.ok) return { ok: false, error: res.error };
  await upsertFix(rootId, { aiFixRequestedAt: new Date(), aiFixRequestedById: actorId });
  await teamNote(rootId, actorId, `Asked Claude to write a fix on issue #${issue.number}. A person reviews its pull request before anything is merged.`);
  return { ok: true, issueNumber: issue.number };
}

/* ------------------------------------------------------- 4. close the loop */

type Pr = { number: number; html_url: string; state: string; merged_at: string | null; merge_commit_sha: string | null };

/** The newest pull request that mentions the issue, from its timeline. */
async function linkedPr(issueNumber: number): Promise<Pr | null | "error"> {
  const res = await gh(`/issues/${issueNumber}/timeline?per_page=100`);
  if (!res.ok) return "error";
  const events = (Array.isArray(res.json) ? res.json : []) as {
    event?: string;
    source?: { issue?: { number: number; pull_request?: unknown } };
  }[];
  const numbers = events
    .filter((e) => e.event === "cross-referenced" && e.source?.issue?.pull_request)
    .map((e) => e.source!.issue!.number);
  let best: Pr | null = null;
  for (const n of [...new Set(numbers)].reverse()) {
    const pr = await gh(`/pulls/${n}`);
    if (!pr.ok) continue;
    const p = pr.json as Pr;
    if (p.merged_at) return p;
    if (!best || (p.state === "open" && best.state !== "open")) best = p;
  }
  return best;
}

/**
 * Closes a report whose fix is live: a line of its conversation saying so,
 * status Done, and everybody who reported it told. Written by whoever sent it
 * to GitHub, since a line of the thread is always somebody's.
 */
async function closeAsLive(rootId: string, authorId: string) {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, rootId)).limit(1);
  if (!row) return;
  const already = row.status === "done";
  await db.transaction(async (tx) => {
    if (!already) {
      await tx
        .update(feedback)
        .set({ status: "done", handledById: authorId, handledAt: new Date(), updatedAt: new Date() })
        .where(eq(feedback.id, rootId));
    }
    await tx.insert(feedbackMessages).values({
      id: `fbm_${randomUUID().slice(0, 12)}`,
      feedbackId: rootId,
      authorId,
      body: "This is fixed in the update that is now live. If it still happens, say so here and it reopens.",
      statusTo: already ? null : "done",
    });
  });

  const reporters = await db
    .select({ id: feedback.id, userId: feedback.userId, number: feedback.number })
    .from(feedback)
    .where(or(eq(feedback.id, rootId), eq(feedback.duplicateOfId, rootId)));
  const seen = new Set<string>();
  await notifyUsers(
    reporters
      .filter((r) => r.userId !== authorId && !seen.has(r.userId) && seen.add(r.userId))
      .map((r) => ({
        userId: r.userId,
        title: `Fixed: ${row.title}`,
        body: `${feedbackRef(r.number)} · The fix is live. Can you check it works for you?`,
        kind: "success",
        href: `/feedback?r=${r.id}`,
        mbosHref: "/notifications",
      })),
  );
}

export type FixSyncResult = { checked: number; merged: number; closed: number; errors: number };

/**
 * The hourly check. For every report with an issue whose fix is not yet live:
 * which pull request mentions it, is it merged, and is its commit in the
 * build now serving. Only then is the report closed.
 */
export async function syncFeedbackFixes(): Promise<FixSyncResult> {
  const result: FixSyncResult = { checked: 0, merged: 0, closed: 0, errors: 0 };
  if (!(await githubConnected())) return result;
  const build = process.env.MAHEK_BUILD;

  const rows = await db
    .select()
    .from(feedbackFixes)
    .where(and(isNotNull(feedbackFixes.issueNumber), isNull(feedbackFixes.deployedAt)))
    .limit(50);

  for (const f of rows) {
    result.checked += 1;
    const pr = await linkedPr(f.issueNumber!);
    if (pr === "error") {
      result.errors += 1;
      continue;
    }
    const state: "open" | "merged" | "closed" | null = !pr ? null : pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed";
    const set: Partial<typeof feedbackFixes.$inferInsert> = {
      checkedAt: new Date(),
      prNumber: pr?.number ?? null,
      prUrl: pr?.html_url ?? null,
      prState: state,
      prMergedSha: pr?.merge_commit_sha && pr.merged_at ? pr.merge_commit_sha : null,
      prMergedAt: pr?.merged_at ? new Date(pr.merged_at) : null,
    };
    let live = false;
    if (state === "merged" && pr?.merge_commit_sha) {
      result.merged += 1;
      if (isCommitBuild(build)) {
        const cmp = await gh(`/compare/${pr.merge_commit_sha}...${build}`);
        if (cmp.ok) live = commitIsInBuild((cmp.json as { status?: string })?.status);
        else result.errors += 1;
      }
    }
    if (live) {
      set.deployedBuild = build!;
      set.deployedAt = new Date();
    }
    await upsertFix(f.feedbackId, set);
    if (live) {
      const author = f.aiFixRequestedById ?? f.issueCreatedById ?? f.diagnosedById;
      if (author) {
        await closeAsLive(f.feedbackId, author);
        result.closed += 1;
      }
    }
  }
  return result;
}

/* --------------------------------------------------------------- helpers */

async function teamNote(rootId: string, authorId: string, body: string) {
  await db.insert(feedbackMessages).values({
    id: `fbm_${randomUUID().slice(0, 12)}`,
    feedbackId: rootId,
    authorId,
    body,
    internal: true,
  });
}
