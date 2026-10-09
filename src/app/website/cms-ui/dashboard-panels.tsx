"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { checkConnectionAction, importContentAction, publishPendingAction, refreshLiveSiteAction } from "@/lib/actions/website-cms";
import type { ConnectionCheck } from "@/lib/website-cms/live-site";
import type { ImportReport } from "@/lib/website-cms/service";
import { reportPublish } from "./report";

/* ---------------------------------------------------------------------------
 * The Dashboard's three working parts: is the live site connected, has the
 * site's content been brought in, and what is waiting to be published.
 *
 * Each says what the server found. None of them assumes: "connected" comes from
 * a real call to the public site's own status endpoint, made when asked.
 * ------------------------------------------------------------------------- */

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ConnectionPanel({
  readSet,
  publishSet,
  canPublish,
  lastRefresh,
  refreshOutstanding,
  siteUrl,
}: {
  readSet: boolean;
  publishSet: boolean;
  canPublish: boolean;
  lastRefresh: { ok: boolean; at: string; detail: string | null } | null;
  refreshOutstanding: boolean;
  siteUrl: string;
}) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState<null | "check" | "refresh">(null);
  const [check, setCheck] = React.useState<ConnectionCheck | null>(null);

  async function onCheck() {
    setBusy("check");
    const r = await checkConnectionAction();
    setBusy(null);
    if (!r.ok) return void toast.push(r.error, "error");
    setCheck(r.data);
  }
  async function onRefresh() {
    setBusy("refresh");
    reportPublish(toast, await refreshLiveSiteAction());
    setBusy(null);
    router.refresh();
  }

  const secretsOk = readSet && publishSet;
  const tone = check?.state === "ok" && check.enabled && check.cmsReachable ? "success" : "warn";

  return (
    <Card className="mb-4">
      <CardHeader
        title="Live website connection"
        hint={`mahekindia.com (${siteUrl.replace(/^https?:\/\//, "")}) reads its content from here.`}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onCheck} disabled={busy !== null}>{busy === "check" ? "Checking…" : "Check connection"}</Button>
            {canPublish ? <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy !== null || !secretsOk}>{busy === "refresh" ? "Refreshing…" : "Refresh the live site"}</Button> : null}
          </div>
        }
      />
      <div className="flex flex-col gap-2 px-5 py-4 text-sm text-body">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={readSet ? "success" : "warn"}>Read secret {readSet ? "set" : "missing"}</Badge>
          <Badge tone={publishSet ? "success" : "warn"}>Publish secret {publishSet ? "set" : "missing"}</Badge>
          {!secretsOk ? <span className="text-muted">Set them under Admin → Integrations → Website content (CMS), and give the same values to the website.</span> : null}
        </div>
        {check ? (
          <Callout tone={tone === "success" ? "brand" : "warn"} className="mb-0">
            <span>
              {check.state === "ok" ? check.detail : check.detail}
              {check.state === "ok" && check.revision ? ` Site is on revision ${check.revision}.` : ""}
            </span>
          </Callout>
        ) : (
          <span className="text-muted">Press “Check connection” to ask the live site itself — nothing is assumed from settings.</span>
        )}
        {refreshOutstanding ? (
          <Callout tone="danger" className="mb-0">
            <span>The last change was published here but the live site has not confirmed a refresh since{lastRefresh && !lastRefresh.ok ? `: ${lastRefresh.detail ?? "it failed"}` : ""}. Visitors may still see the older version until it does. {canPublish ? "Use “Refresh the live site” to retry." : "Ask somebody who can publish to retry."}</span>
          </Callout>
        ) : lastRefresh ? (
          <span className="text-xs text-muted">Last refresh request {when(lastRefresh.at)} — {lastRefresh.ok ? "the live site confirmed it" : "it did not succeed"}.</span>
        ) : null}
      </div>
    </Card>
  );
}

export function ImportPanel({ canPublish }: { canPublish: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<ImportReport | null>(null);

  async function onImport() {
    setBusy(true);
    const r = await importContentAction();
    setBusy(false);
    if (!r.ok) return void toast.push(r.error, "error");
    setReport(r.data);
    toast.push(r.message ?? "Imported.");
    router.refresh();
  }

  return (
    <Card className="mb-4">
      <CardHeader title="Bring in the website's current content" hint="One time. Copies exactly what mahekindia.com shows today into this CMS, as live." />
      <div className="flex flex-col gap-3 px-5 py-4 text-sm text-body">
        <p>
          Every product, industry, gallery photo, job, testimonial and milestone, the menus and settings, the wording of each page, and each page&apos;s search description. Nothing on the
          live site changes. It never overwrites anything already here, so it is safe to run again. Nothing is deleted.
        </p>
        {report ? (
          <div className="rounded-[4px] bg-canvas p-3">
            <div className="font-medium text-ink">Imported {Object.values(report.created).reduce((a, b) => a + b, 0)} items{report.skipped ? `, ${report.skipped} already here` : ""}, and listed {report.media} image files.</div>
            <div className="mt-1 text-muted">{Object.entries(report.created).map(([k, n]) => `${n} ${k}`).join(" · ")}</div>
            {report.detailSeoSkipped ? <div className="mt-1 text-muted">{report.detailSeoSkipped} product and industry page descriptions were not imported as overrides — those pages describe themselves from the product, so renaming it still updates its title. Add a SEO entry only to change one.</div> : null}
            {report.problems.length > 0 ? (
              <div className="mt-2 text-danger">
                <div className="font-medium">Needs a look ({report.problems.length}):</div>
                <ul className="list-disc pl-5">{report.problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            ) : null}
          </div>
        ) : null}
        <div>
          {canPublish ? (
            <Button variant="primary" onClick={onImport} disabled={busy}>{busy ? "Importing…" : "Import the website's current content"}</Button>
          ) : (
            <span className="text-muted">Importing needs the “Publish to the live site” permission. Ask somebody who has it.</span>
          )}
        </div>
      </div>
    </Card>
  );
}

export function PublishPendingButton({ pending }: { pending: number }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="primary"
      disabled={busy || pending === 0}
      onClick={async () => {
        setBusy(true);
        reportPublish(toast, await publishPendingAction());
        setBusy(false);
        router.refresh();
      }}
    >
      {busy ? "Publishing…" : pending === 0 ? "Nothing to publish" : `Publish everything pending (${pending})`}
    </Button>
  );
}
