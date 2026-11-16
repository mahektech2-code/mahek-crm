import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '../ui/Icon';
import { PillButton } from '../ui/v3';
import { StagePill } from './v3-parts';
import { Pop } from '../ui/motion';
import { color as C, weight } from '../../theme/tokens';
import { compactInrFromPaise, dmy, inrFromPaise, plural } from '../../lib/format';
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
  /** §5.5 — the SIZE of the promise, off the lead row. Null is nobody having
      been asked; the blocker's own null is the same fact, and is NOT the
      `no_blocker` code, which is somebody being asked and saying the road is
      clear. */
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

  const figure = [{ fontSize: 22, lineHeight: 28, letterSpacing: -0.4, color: C.ink }, weight(800)];
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="order" size={18} color={C.ink} strokeWidth={2} />
        <Text
          accessibilityRole="header"
          accessibilityLabel={date ? 'They promised to order' : 'Order not asked for yet'}
          style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(800)]}>
          {date ? 'Promised order' : 'Order not asked for yet'}
        </Text>
        {/* Pops when the promise changes what it is — blocked, or overtaken
            by a real order — not when the record merely opens on it. */}
        {date ? (
          <Pop trigger={ordered ? 'ordered' : blocked ? 'blocked' : 'promised'}>
            <StagePill tone={ordered ? 'success' : 'amber'} text={ordered ? 'Ordered' : blocked ? 'Blocked' : 'Promised'} />
          </Pop>
        ) : null}
      </View>

      {date ? (
        <>
          <View
            accessible
            accessibilityLabel={[
              quantityCans ? plural(quantityCans, 'can') : null,
              'on ' + dmy(date),
              valuePaise ? 'about ' + inrFromPaise(valuePaise) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, marginTop: 10 }}>
            {quantityCans ? <Text style={figure}>{plural(quantityCans, 'can')}</Text> : null}
            {valuePaise ? <Text style={figure}>{compactInrFromPaise(valuePaise)}</Text> : null}
            <Text style={figure}>{dmy(date)}</Text>
          </View>
          {/* The quantity is the handset's own note until the office has a
              column for it. Saying so beats printing nothing where somebody
              typed a number, and beats printing it as though the office had
              agreed it. */}
          {quantityCans ? null : (
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.warnInk, marginTop: 4 }, weight(400)]}>
              Number of cans was not saved. Save it again with the cans.
            </Text>
          )}

          {blocked ? (
            <Text style={[{ fontSize: 13, lineHeight: 19, color: C.warnInk, marginTop: 6 }, weight(600)]}>
              {'Stopped on: ' + labelOf(blockers.length ? blockers : ORDER_BLOCKERS, blockerCode)}
            </Text>
          ) : null}

          {ordered ? (
            /* §9's warning, drawn where it is actually true. The promise has
               been overtaken by a real order, so an old date left standing
               alone reads as something still owed. */
            <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 6 }, weight(400)]}>
              An order has now been placed. The real order counts now, not the promise.
            </Text>
          ) : date < today ? (
            <Text style={[{ fontSize: 13, lineHeight: 19, color: C.warnInk, marginTop: 6 }, weight(600)]}>
              That day has passed and no order came. Visit them again. Save what they say now.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={[{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 8 }, weight(400)]}>
          Ask when they will give the first order, and how much. This is only a promise, not an order. The stage does not change with it.
        </Text>
      )}

      {/* WHO CONFIRMS THE REAL ORDER, said rather than drawn as a control this
          phone must not have. See the header. */}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }, weight(400)]}>
        {ordered
          ? 'The office has the order on this account.'
          : countingOrderCount === null
            ? 'Your sales manager confirms the real order after it is placed. This phone does not have the order count yet.'
            : 'Sales manager confirms the real order · no order yet'}
      </Text>

      {date ? (
        <Pressable
          onPress={onRecord}
          accessibilityRole="button"
          style={({ pressed }) => ({ alignSelf: 'flex-start', marginTop: 10, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, justifyContent: 'center', backgroundColor: pressed ? C.hairline : C.canvas })}>
          <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>Change the promise</Text>
        </Pressable>
      ) : (
        <PillButton label="Save their promise" variant="navyLime" height={52} onPress={onRecord} style={{ marginTop: 12 }} />
      )}
    </View>
  );
}
