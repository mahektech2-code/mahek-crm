"use client";

import * as React from "react";

import { Badge, cx } from "@/components/ui/primitives";
import { recordLeadFollowUp } from "@/lib/actions/lead-followup";
import { stamp } from "@/lib/format";
import {
  FOLLOWUP_MATERIALS,
  PROMO_STUDIO,
  whatsappHref,
  type FollowUpCode,
  type FollowUpDocs,
} from "@/lib/lead-followup";

/* ---------------------------------------------------------------------------
 * THE FOLLOW-UP SECTION of the call form — used twice, as its own option and
 * inside Spoke, so the two can never drift.
 *
 * Clicking Send a Product Image / the Brochure / the Price List does two things
 * and nothing else: it opens THIS lead's WhatsApp conversation (the existing
 * screen, in a new tab) and writes down which option was chosen. Nothing is sent
 * from here and nothing is marked sent: the person composes the message in
 * WhatsApp, and only that screen can confirm a send.
 *
 * The tab is opened inside the click itself, before anything is awaited, so a
 * browser never mistakes it for a popup.
 * ------------------------------------------------------------------------- */

type Opened = { at: string } | { error: string };

export function FollowUpSection({
  customerId,
  docs,
  hasPhone,
}: {
  customerId: string;
  docs: FollowUpDocs;
  hasPhone: boolean;
}) {
  const [opened, setOpened] = React.useState<Partial<Record<FollowUpCode, Opened>>>({});
  const [busy, setBusy] = React.useState<FollowUpCode | null>(null);

  async function choose(code: FollowUpCode) {
    window.open(whatsappHref(customerId), "_blank", "noopener");
    setBusy(code);
    const key = globalThis.crypto.randomUUID().replaceAll("-", "");
    const r = await recordLeadFollowUp({ customerId, materials: [code], whatsappOpened: true, clientKey: key });
    setBusy(null);
    setOpened((o) => ({
      ...o,
      [code]: r.ok ? { at: r.data.at } : { error: r.error },
    }));
  }

  return (
    <div className="rounded-[8px] border border-line bg-surface px-4 py-3.5">
      <div className="mb-2.5 grid gap-2 sm:grid-cols-2">
        {FOLLOWUP_MATERIALS.map((m) => {
          const doc = docs[m.code];
          const state = opened[m.code];
          return (
            <div key={m.code} className="rounded-[8px] border border-line bg-surface px-3 py-2.5">
              <button
                type="button"
                disabled={!hasPhone || busy === m.code}
                title={hasPhone ? "Opens this lead's WhatsApp conversation in a new tab" : "This lead has no phone number"}
                onClick={() => void choose(m.code)}
                className={cx(
                  "flex w-full items-start justify-between gap-2 rounded-[6px] text-left",
                  hasPhone ? "cursor-pointer hover:text-brand" : "cursor-not-allowed opacity-60",
                )}
              >
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{m.label}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted" title={doc?.title}>
                    {doc ? doc.title : "No file published for this yet — you can still open WhatsApp."}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-[12px] font-medium text-brand">{busy === m.code ? "Opening…" : "Open WhatsApp"}</span>
              </button>

              {doc?.fileHref ? (
                <a href={doc.fileHref} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[12px] text-brand">
                  Open the file
                </a>
              ) : null}

              {state && "at" in state ? (
                <p className="mt-1.5 mb-0 text-[12px] text-success">
                  WhatsApp opened {stamp(state.at)} — recorded in the follow-up history. Not marked sent.
                </p>
              ) : state ? (
                <p className="mt-1.5 mb-0 text-[12px] text-danger">WhatsApp was opened, but it could not be recorded: {state.error}</p>
              ) : null}
            </div>
          );
        })}

        <div className="rounded-[8px] border border-dashed border-line bg-canvas px-3 py-2.5" aria-disabled="true">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-muted">{PROMO_STUDIO.label}</span>
            <Badge tone="neutral">{PROMO_STUDIO.note}</Badge>
          </div>
          <span className="mt-0.5 block text-[12px] text-muted">
            Will open Promotional Studio for this lead once it is connected.
          </span>
        </div>
      </div>

      <p className="m-0 text-[12px] text-muted">
        Each choice opens this lead&rsquo;s WhatsApp conversation and is recorded as <b>WhatsApp opened</b>. You write and send
        the message there; nothing is marked sent from here.
      </p>
    </div>
  );
}
