import React from 'react';
import { View } from 'react-native';
import { BottomSheet, Calendar } from '../ui/overlays';
import { Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { color as C, radius, weight } from '../../theme/tokens';
import { dmy } from '../../lib/format';
import type { CodedOption } from '../../engines/funnel';

/**
 * §5.5 §9 — WHAT THEY SAID THEY WOULD ORDER.
 *
 * A DAY, A SIZE, AND WHAT IS STOPPING IT. The specification asks for a
 * quantity, a date and a blocker; Mahek's own instruction is that the first two
 * are both mandatory, and that overrules §9 where they differ — "some time next
 * week" is not something a godown can be planned around, and a promise with no
 * size on it cannot be held against the order that eventually answers it.
 *
 * IT SAYS IN WORDS THAT NOTHING MOVES. That sentence is the most important
 * thing on this sheet: a salesman who has just written down a promise will
 * reasonably expect the lead to climb, and it does not — a forecast is not a
 * sale, and the rung above still wants a real order behind it. Said here,
 * before the button, rather than discovered afterwards on a ladder that did not
 * move.
 *
 * The value is OPTIONAL and the quantity is not, which is the opposite way
 * round from what a screen would usually do. `products.priceSource` is still
 * `unset`, so nothing in MahekOne can turn cans into rupees; a figure here is
 * somebody's estimate, and an estimate nobody made must read as absent rather
 * than as a confident zero.
 *
 * Remounted by its `key` rather than reset in an effect, like every other sheet
 * in this app — the React Compiler rules forbid the second and a sheet carrying
 * the last lead's answers is how one shop's promise lands on another's record.
 */
export function CommitmentSheet({
  open,
  today,
  productName,
  blockers,
  current,
  onClose,
  onSave,
}: {
  open: boolean;
  today: string;
  /** The SKU qualification named, so the unit on the screen is never ambiguous. */
  productName: string | null;
  blockers: CodedOption[];
  current: { date: string | null; quantityCans: number | null; valuePaise: number | null; blockerCode: string | null };
  onClose: () => void;
  onSave: (c: { date: string; quantityCans: number; valuePaise: number | null; blockerCode: string }) => void;
}) {
  const [date, setDate] = React.useState(current.date ?? '');
  const [cans, setCans] = React.useState(current.quantityCans ? String(current.quantityCans) : '');
  /* Rupees on the screen and paise in the store, the one place the two meet —
     the same conversion the prospect form and the new-lead form do. */
  const [rupees, setRupees] = React.useState(
    current.valuePaise ? String(Math.round(current.valuePaise / 100)) : '',
  );
  /* `no_blocker` is the default and is a real answer: a commitment nobody was
     asked about and one somebody said was clear are different facts, and only
     the second says anybody put the question. */
  const [blocker, setBlocker] = React.useState(current.blockerCode ?? 'no_blocker');
  const [picking, setPicking] = React.useState(false);

  const cansNow = Number(cans.replace(/[^\d]/g, ''));
  const missing = !date
    ? 'Say which day they will place it.'
    : !cansNow
      ? 'Say how many cans. A promise with no size on it cannot be planned around.'
      : undefined;

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        What did they say they would order?
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        This is what you were told, not an order. Nothing moves up a rung on it — the order itself does that.
      </T>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>When will they place it</SectionLabel>
        {picking ? (
          <Calendar
            key="commitment-cal"
            selected={date}
            /* A day already gone is not a forecast. Today is allowed: a
               shopkeeper saying "I will send it this evening" is the ordinary
               best case and refusing it would send somebody to type tomorrow. */
            disabledReason={(iso) => (iso < today ? 'That day has gone.' : null)}
            onPick={(iso) => {
              setDate(iso);
              setPicking(false);
            }}
          />
        ) : (
          <SecondaryButton
            label={date ? dmy(date) : 'Pick a day'}
            onPress={() => setPicking(true)}
            style={{ borderRadius: radius.lg }}
          />
        )}
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>How many cans</SectionLabel>
        <Input value={cans} onChangeText={setCans} keyboardType="number-pad" placeholder="40" />
        {/* CANS, and the SKU beside them so the unit is never in doubt. A lead
            being asked for a first order has been through qualification, which
            named the product — so there IS a pack size here, which is exactly
            what there was not at capture, where the answer is in litres. */}
        <T s="caption" style={{ marginTop: 6 }}>
          {productName
            ? 'Cans of ' + productName + ' — the pack they will actually buy.'
            : 'In cans, the way they will order it. Nobody has named the product on this lead yet.'}
        </T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What it is worth, if you know</SectionLabel>
        <Input value={rupees} onChangeText={setRupees} keyboardType="number-pad" placeholder="Rupees — optional" />
        <T s="caption" style={{ marginTop: 6 }}>
          Leave it empty if you have not priced it. There are no prices in the product list, so nothing here can
          work it out for you, and a guessed figure reads later as one somebody agreed.
        </T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What is stopping it today</SectionLabel>
        <View style={{ gap: 8 }}>
          {blockers.map((b) => (
            <Choice
              key={b.code}
              label={b.label}
              selected={blocker === b.code}
              onPress={() => setBlocker(b.code)}
              style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
            />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label="Record it"
          disabled={Boolean(missing)}
          whyDisabled={missing}
          onPress={() => {
            if (missing) return;
            onSave({
              date,
              quantityCans: cansNow,
              valuePaise: rupees.replace(/[^\d]/g, '') ? Number(rupees.replace(/[^\d]/g, '')) * 100 : null,
              blockerCode: blocker,
            });
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}
