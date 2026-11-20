"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { RowMenu } from "@/components/ui/overlays";
import type { InterviewRow } from "@/lib/hire/services/interview";
import { Booker, CancelDialog } from "../calendar/calendar-view";

/**
 * A booked interview is moved or called off FROM THE INTERVIEWS LIST, not only
 * from the Calendar. Reschedule is the Calendar's own booker opened on the
 * booking as it stands (booking the stage again moves it, and the trail says
 * "rescheduled"); Cancel is the Calendar's own dialog. Both need the same
 * capability as the Calendar (`addCandidate`), checked again on the server.
 */
export function InterviewMenu({ r, staff, meId, today }: { r: InterviewRow; staff: { id: string; name: string; role: string | null }[]; meId: string; today: string }) {
  const [open, setOpen] = useState<"move" | "cancel" | null>(null);
  const booked = r.status === "scheduled" && !!r.when;
  const why = booked ? undefined : r.status === "not_started" ? "Nothing is booked yet — book it on the Calendar." : "It has already started.";
  return (
    <>
      <RowMenu
        items={[
          { label: "Reschedule", onSelect: () => setOpen("move"), disabled: !booked, title: why },
          { label: "Cancel interview", onSelect: () => setOpen("cancel"), destructive: true, disabled: !booked, title: why },
        ]}
      />
      {open === "move" && booked ? (
        <Modal open onClose={() => setOpen(null)} title={`Reschedule ${r.name}`} width={460}>
          <p className="mt-0 mb-3 text-sm text-muted">
            {r.stage} · {r.role}. Pick the new time; the interviewer is told, and the trail keeps the old one.
          </p>
          <Booker
            key={r.execId}
            framed={false}
            item={{ applicationId: r.applicationId, name: r.name, role: r.role, stage: r.stage, location: r.location, interviewerId: r.interviewerId, waitingHours: 0 }}
            staff={staff}
            meId={meId}
            today={today}
            current={{ startIso: r.when!, minutes: r.minutes, modality: r.modality, place: r.place }}
            onDone={() => setOpen(null)}
          />
        </Modal>
      ) : null}
      {open === "cancel" && booked ? (
        <CancelDialog
          key={r.execId}
          e={{
            execId: r.execId,
            applicationId: r.applicationId,
            name: r.name,
            role: r.role,
            stage: r.stage,
            startIso: r.when!,
            minutes: r.minutes,
            interviewer: r.interviewer,
            place: r.place,
            status: r.status,
            mine: r.interviewerId === meId,
            hasEmail: r.hasEmail,
            doNotContact: r.doNotContact,
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
