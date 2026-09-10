import { enqueue } from '../sync/queue';
import { stamp } from './write';

/**
 * §R — a note about a customer that the customer must never see.
 *
 * **THIS IS THE ONE WRITE IN THE APP WITH NO READ BESIDE IT, and that is the
 * feature rather than an omission.** `mbos_internal_notes` has had a table, a
 * role list and a bootstrap that narrows by role since the MBOS module
 * shipped, and `services/mbos-service.ts` says in its own header why it has
 * never sent one to a handset: "a note that could leak is not on the device to
 * leak," enforced by that file never selecting the table at all rather than by
 * a screen declining to draw it. A filter in the app is a filter somebody can
 * turn off, and the bytes would already be on the phone.
 *
 * So the office can read these and the salesman cannot, INCLUDING the ones he
 * wrote himself. What was missing was the other half: `handleInternalNote` has
 * been on the server waiting for a payload that nothing on any handset ever
 * sent — the same shape `mbos_competitor_records` was in before it got a write
 * path — so §R was a read path over a table nothing could put a row in.
 *
 * Nothing is written to the local store on the way past. There is no local
 * table, which means there is nothing to list, nothing to leak and nothing for
 * a future screen to accidentally render. The note lives in the outbox until
 * it is sent, and after that this phone has no copy of it.
 */
export async function writeInternalNote(args: {
  customerId: string;
  body: string;
  /**
   * Who may read it. Empty means everybody who can already see the customer,
   * which is what a note with no list has always meant on the read side.
   *
   * Nothing on the handset offers this yet: a salesman does not know the
   * office's role names, and a picker full of them would be a picker filled in
   * wrongly. It is in the signature because the server accepts it and the day
   * a screen wants to narrow a note, the wire is already carrying it.
   */
  visibleToRoles?: string[];
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const body = args.body.trim();
  if (!body) return { ok: false, message: 'Write the note first.' };

  /* The server's own ceiling, stated here so he is told while the words are
     still on the screen rather than by a rejection hours later. */
  if (body.length > 4000) {
    return { ok: false, message: 'That is too long for one note — 4,000 letters is the limit.' };
  }

  const base = await stamp('internal_note');

  await enqueue({
    entityType: 'internal_note',
    entityId: base.id,
    op: 'create',
    /* Spelled out rather than spread — PROTOCOL.md §4.1. `internalNoteSchema`
       takes these three and nothing else; a fourth field would be dropped
       silently by the parse, which is how a field gets added on one side and
       believed on the other. */
    payload: {
      customerId: args.customerId,
      body,
      visibleToRoles: args.visibleToRoles ?? [],
    },
    /*
     * Paperwork, not field work — the same call `requestTour` and agreeing a
     * proposed day make. Where a salesman stood while typing an opinion about
     * a shop answers no question anybody has, and recording it would put a
     * coordinate on the one record here that is deliberately private.
     */
    location: false,
  });

  return { ok: true };
}
