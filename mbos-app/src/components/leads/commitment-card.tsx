import React from 'react';
import { View } from 'react-native';
import { Badge, Card, PrimaryButton, SecondaryButton, T } from '../ui/primitives';
import { color as C, weight } from '../../theme/tokens';
import { dmy, inrFromPaise, plural } from '../../lib/format';
import { labelOf, ORDER_BLOCKERS, type CodedOption } from '../../engines/funnel';

/**
 * §5.5 — the commitment, and what happens to it.
 *
 * TWO ACTIONS SIT ON THIS CARD IN THE SPECIFICATION AND ONLY ONE OF THEM IS
 * THIS PHONE'S.
 *
 * Recording what the customer said is the salesman's: he is the one who was
 * told it, and `expected_order_date` is the single condition in front of
 * `first_order` that is his to satisfy at all — every other fact that rung
 * reads is a count the office keeps.
 *
 * CONFIRMING THE ACTUAL ORDER IS NOT, and it is drawn as a sentence rather
 * than as a button for four reasons that all point the same way.
 * `lead-role-action.ts` — the specification's own table, compiled into this
 * app — gives "Confirm actual order" to the SALES MANAGER's vantage and gives
 * the salesman "Support negotiation" on the same lead on the same afternoon.
 * An order in MahekOne is a record accounts approve, and AGENTS.md is flat
 * about why: an order taken on a call is the customer saying yes, not the
 * business. This app already has a door for a real order — `handleOrder`,
 * through the outbox and into the approval queue — so a second one writing a
 * value and a reference onto the lead would be a parallel order nobody
 * approves and nothing dispatches. And §20 says the order ladder is RENDERED
 * here, never re-implemented, precisely so the phone and the office cannot
 * disagree about one sale.
 *
 * So the card says who does it and shows the counts that answer whether it has
 * been done. A dead button with a tooltip would teach a salesman that the app
 * is broken; a sentence naming the person whose job it is teaches him who to
 * ring. The counts are the OFFICE's — `countingOrderCount` is what the gate
 * reads — so the screen and the gate cannot tell him two different things.
 *
 * §9 asks for a warning that confirming supersedes the forecast. It is drawn
 * where it is true rather than under a button that is not here: once a real
 * order exists, the card says plainly that the promise has been overtaken, so
 * nobody reads an old date as something still owed.
 */
export function CommitmentCard({
  date,
  valuePaise,
  quantityCans,
  blockerCode,
  blockers,
  hasOrder,
  countingOrderCount,
  today,
  onRecord,
}: {
  date: string | null;
  valuePaise: number | null;
  /** The phone's own copy — see `rememberCommitmentExtras`. Null until asked. */
  quantityCans: number | null;
  blockerCode: string | null;
  blockers: CodedOption[];
  hasOrder: boolean;
  /** The office's count. Null is this phone not having heard, never a zero. */
  countingOrderCount: number | null;
  today: string;
  onRecord: () => void;
}) {
  const ordered = hasOrder || (countingOrderCount ?? 0) >= 1;
  const blocked = Boolean(blockerCode) && blockerCode !== 'no_blocker';

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T style={[{ flex: 1, minWidth: 0, fontSize: 16, color: C.ink }, weight(600)]}>
          {date ? 'They said they would order' : 'Nobody has asked for the order yet'}
        </T>
        {date ? (
          <Badge tone={ordered ? 'success' : blocked ? 'amber' : 'teal'}>
            {ordered ? 'Ordered' : blocked ? 'Blocked' : 'Promised'}
          </Badge>
        ) : null}
      </View>

      {date ? (
        <>
          <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 8 }, weight(500)]}>
            {[
              quantityCans ? plural(quantityCans, 'can') : null,
              'on ' + dmy(date),
              valuePaise ? 'about ' + inrFromPaise(valuePaise) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </T>
          {/* The quantity is the handset's own note until the office has a
              column for it. Saying so beats printing nothing where somebody
              typed a number, and beats printing it as though the office had
              agreed it. */}
          {quantityCans ? null : (
            <T s="caption" style={{ marginTop: 4 }}>
              No size was recorded against this one. Record it again to say how many cans.
            </T>
          )}

          {blocked ? (
            <T style={{ fontSize: 14, lineHeight: 20, color: C.warnInk, marginTop: 6 }}>
              {'Stopped on: ' + labelOf(blockers.length ? blockers : ORDER_BLOCKERS, blockerCode)}
            </T>
          ) : null}

          {ordered ? (
            /* §9's warning, drawn where it is actually true. The promise has
               been overtaken by a real order, so an old date left standing
               alone reads as something still owed. */
            <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>
              An order has since been placed on this account, so what they promised has been overtaken. The
              order is what counts from here.
            </T>
          ) : date < today ? (
            <T style={{ fontSize: 14, lineHeight: 20, color: C.warnInk, marginTop: 6 }}>
              {'That day has gone and no order has come. Go back to them, and record what they say now.'}
            </T>
          ) : null}
        </>
      ) : (
        <T style={{ fontSize: 15, lineHeight: 21, color: C.muted, marginTop: 8 }}>
          Ask when they will place the first order and how much of it. It is what you were told, not an order —
          nothing climbs a rung on it.
        </T>
      )}

      {/* WHO CONFIRMS THE REAL ORDER, said rather than drawn as a control this
          phone must not have. See the header. */}
      <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 10 }}>
        {ordered
          ? 'The office has the order on this account.'
          : countingOrderCount === null
            ? 'Your sales manager confirms the actual order once it is placed. This phone has not heard the order count yet.'
            : 'Your sales manager confirms the actual order once it is placed, with its value and its reference. There is none on this account yet.'}
      </T>

      {date ? (
        <SecondaryButton
          label="They have changed what they said"
          onPress={onRecord}
          style={{ marginTop: 12 }}
        />
      ) : (
        <PrimaryButton label="Record what they promised" onPress={onRecord} style={{ marginTop: 12 }} />
      )}
    </Card>
  );
}
