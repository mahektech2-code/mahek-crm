import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Choice, Input, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { claimExpense, listExpenses, type Expense } from '../src/data/requests';
import { attachTicket, travelRules, travelToday, unclaimedTicketLegs, type TravelLeg, type TravelToday } from '../src/data/travel';
import { MODE_SHORT, type TravelMode } from '../src/lib/travel';
import { getConfig } from '../src/data/config';
import { takePhoto } from '../src/native/capture';
import { dmy, inr, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Expenses — a claim, and the headroom it eats.
 *
 * The cap line is the design's own three sentences: what is left before he
 * types, what would be left after, and how far over he has gone. A claim that
 * needs the manager's indulgence says so while it can still be changed — and
 * it is still SENT. Exceeding a cap flags a claim; it never refuses one,
 * because the money is already spent and refusing to record it only means
 * nobody finds out.
 */

const EX_RULE =
  'Every claim needs a photograph of the bill or proof of payment. Claims older than 30 days are not accepted.';

type Draft = { kind: string; amt: string; note: string; when: string; whenIso: string; billMediaId: string | null; billLabel: string | null };

const EMPTY: Draft = { kind: '', amt: '', note: '', when: '', whenIso: '', billMediaId: null, billLabel: null };

export default function ExpensesScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const boot = useBoot();

  const [rows, setRows] = React.useState<Expense[]>([]);
  /*
   * Fares he has already spent and not asked for.
   *
   * A bus leg he skipped the ticket on is money he is entitled to and has not
   * claimed, and the ONLY moment anybody would ever notice is if something
   * counts them — which is why this list is here, on the screen where he is
   * already thinking about money, rather than left as a thing he might
   * remember on the last day of the month. Claiming from here opens the
   * ordinary sheet with the journey already named, so it is one screen and one
   * set of rules, not a second way to claim.
   */
  const [unclaimed, setUnclaimed] = React.useState<TravelLeg[]>([]);
  const [travel, setTravel] = React.useState<TravelToday | null>(null);
  const [forLeg, setForLeg] = React.useState<TravelLeg | null>(null);
  /* Caps, the claim window and the bill threshold are all configuration —
     `mbos.expenses.*` — never numbers typed into this screen. */
  const [caps, setCaps] = React.useState<Record<string, number>>({});
  const [maxAgeDays, setMaxAgeDays] = React.useState(30);

  const [open, setOpen] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  const [ex, setEx] = React.useState<Draft>(EMPTY);
  const [err, setErr] = React.useState<'amt' | 'bill' | 'when' | 'note' | null>(null);
  const [cal, setCal] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    const userId = boot.session?.user.id ?? '';
    void Promise.all([
      listExpenses(),
      getConfig<Record<string, number>>('mbos.expenses.categoryCapsPaise', {}),
      getConfig<number>('mbos.expenses.maxClaimAgeDays', 30),
      travelRules(),
    ]).then(async ([e, c, age, r]) => {
      if (!live) return;
      setRows(e);
      setCaps(c);
      setMaxAgeDays(age);
      if (!userId) return;
      const [legs, today] = await Promise.all([
        unclaimedTicketLegs(userId, r.ticketModes),
        travelToday(userId, r.ticketModes),
      ]);
      if (!live) return;
      setUnclaimed(legs);
      setTravel(today);
    });
    return () => {
      live = false;
    };
  }, [boot.session?.user.id]);

  useFocusEffect(load);

  const patch = (p: Partial<Draft>) => {
    setEx((d) => ({ ...d, ...p }));
    setErr(null);
  };

  const pending = rows.filter((r) => r.state === 'Pending').reduce((n, r) => n + r.amountPaise, 0);

  /* What each category has already taken this month, so the headroom on screen
     is the headroom the save path will check against. */
  const month = isoDate(new Date()).slice(0, 7);
  const usedPaise = (kind: string) =>
    rows.filter((r) => r.category === kind && r.spentOn.slice(0, 7) === month).reduce((n, r) => n + r.amountPaise, 0);

  const kinds = Object.keys(caps);
  const kind = ex.kind || kinds[0] || '';
  const capPaise = caps[kind] ?? 0;
  const exAmtPaise = (parseInt(ex.amt.replace(/[^0-9]/g, ''), 10) || 0) * 100;
  const leftPaise = Math.max(0, capPaise - usedPaise(kind));
  const exOver = exAmtPaise > leftPaise;

  const capLine = !exAmtPaise
    ? inr(leftPaise / 100) + ' of your ' + kind.toLowerCase() + ' budget is left this month'
    : exOver
      ? 'This is ' + inr((exAmtPaise - leftPaise) / 100) + ' over what is left — your manager has to allow it'
      : inr((leftPaise - exAmtPaise) / 100) + ' would be left after this';

  const add = () => {
    setFixing(false);
    setErr(null);
    const today = new Date();
    setEx({ ...EMPTY, kind: kinds[0] ?? '', when: dmy(isoDate(today)), whenIso: isoDate(today) });
    setOpen(true);
  };

  /**
   * Claiming a fare he skipped at the shop door.
   *
   * It opens the SAME sheet, pre-filled, rather than a second little form of
   * its own — the caps, the bill rule and the date window are all stated
   * there, and a shortcut that bypassed them would be a second set of rules
   * that eventually disagreed with the first. What it adds is the leg, held in
   * `forLeg`, so the claim it writes carries its origin and the journey stops
   * appearing on this list.
   */
  const claimFare = (leg: TravelLeg) => {
    setFixing(false);
    setErr(null);
    setForLeg(leg);
    const day = isoDate(new Date(leg.departedAt));
    setEx({
      ...EMPTY,
      kind: 'travel',
      when: dmy(day),
      whenIso: day,
      note: `${leg.mode === 'train' ? 'Train' : 'Bus'} ticket · ${leg.customerName ?? 'a shop'}`,
    });
    setOpen(true);
  };

  const fix = (x: Expense) => {
    setFixing(true);
    setErr(null);
    setEx({
      kind: x.category,
      amt: String(Math.round(x.amountPaise / 100)),
      note: x.remarks ?? '',
      when: dmy(x.spentOn),
      whenIso: x.spentOn,
      billMediaId: null,
      billLabel: null,
    });
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setEx(EMPTY);
    setErr(null);
    setFixing(false);
    setForLeg(null);
    setCal(false);
  };

  /* The photograph is taken when the bill is in his hand, and queued straight
     away — the claim it belongs to does not exist yet and does not need to. */
  const attach = async (source: 'camera' | 'library') => {
    const shot = await takePhoto({ parentType: 'expense', parentId: 'pending', kind: 'bill_photo', source });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    patch({ billMediaId: shot.mediaId, billLabel: source === 'camera' ? 'Photo attached' : 'File attached' });
  };

  const send = async () => {
    if (!exAmtPaise) return setErr('amt');
    if (!ex.billMediaId) return setErr('bill');
    if (!ex.whenIso.trim()) return setErr('when');
    if (!ex.note.trim()) return setErr('note');

    /* If this claim came off a journey, it says so — and `attachTicket` is
       the path, not `claimExpense` directly, because that is the one function
       that writes the claim AND puts it back on the leg. Two writes done here
       would leave a fare claimed with the journey still asking for it. */
    if (forLeg && ex.billMediaId) {
      const claimed = await attachTicket({
        legId: forLeg.id,
        userId: boot.session?.user.id ?? '',
        customerName: forLeg.customerName ?? 'a shop',
        photoId: ex.billMediaId,
        farePaise: exAmtPaise,
      });
      close();
      load();
      notify(
        claimed.overCap
          ? 'Claimed ' + inr(exAmtPaise / 100) + ' · over the cap, your manager has to allow it'
          : 'Claimed ' + inr(exAmtPaise / 100) + ' · with your manager',
      );
      return;
    }

    const { overCap } = await claimExpense({
      userId: boot.session?.user.id ?? '',
      spentOn: ex.whenIso,
      category: kind,
      amountPaise: exAmtPaise,
      billPhotoId: ex.billMediaId,
      remarks: ex.note.trim(),
    });

    close();
    load();
    notify(
      overCap
        ? 'Claimed ' + inr(exAmtPaise / 100) + ' · over the cap, your manager has to allow it'
        : 'Claimed ' + inr(exAmtPaise / 100) + ' · with your manager',
    );
  };

  /* The two refusals the design writes out, so a greyed day always says why. */
  const [todayIso] = React.useState(() => isoDate(new Date()));
  const oldestIso = React.useMemo(() => {
    const o = new Date();
    o.setDate(o.getDate() - maxAgeDays);
    return isoDate(o);
  }, [maxAgeDays]);
  const refuse = (iso: string) =>
    iso < oldestIso
      ? 'Older than ' + maxAgeDays + ' days — this cannot be claimed'
      : iso > todayIso
        ? 'That day has not happened yet'
        : null;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Expenses</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {inr(pending / 100) + ' waiting on your manager'}
      </T>

      <PrimaryButton label="Add an expense" style={{ marginTop: 12, borderRadius: radius.xl }} onPress={add} />
      <T s="caption" style={{ marginTop: 10 }}>
        {EX_RULE}
      </T>

      {/* ---- what today's travelling came to ----
          Kilometres and fares are shown SIDE BY SIDE and never added: one is a
          distance on his own vehicle and the other is money he handed over,
          and a single figure combining them would be neither. It is here
          rather than on the home screen because this is where somebody is
          already thinking about what they are owed. */}
      {travel && travel.legs > 0 ? (
        <ListCard style={{ marginTop: 16, paddingHorizontal: 16, paddingVertical: 14 }}>
          <T s="label">Travelled today</T>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
            <View style={{ flex: 1 }}>
              <T style={[{ fontSize: 20, color: C.ink }, weight(600), tabular]}>
                {travel.ownVehicleKm.toLocaleString('en-IN') + ' km'}
              </T>
              <T s="caption">on your own vehicle</T>
            </View>
            <View style={{ flex: 1 }}>
              <T style={[{ fontSize: 20, color: C.ink }, weight(600), tabular]}>
                {inr(travel.ticketPaise / 100)}
              </T>
              <T s="caption">in tickets claimed</T>
            </View>
          </View>
        </ListCard>
      ) : null}

      {/* ---- fares he has not asked for ----
          Money already spent and not claimed. Listed with the shop and the day
          on it, because "a bus ticket" three days ago is not a thing anybody
          remembers and a prompt he cannot place is a prompt he dismisses. */}
      {unclaimed.length ? (
        <ListCard style={{ marginTop: 16 }}>
          <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
            <T s="label">Tickets you have not claimed</T>
            <T s="caption" style={{ marginTop: 2 }}>
              {plural(unclaimed.length, 'journey') + ' you paid a fare on. Claim them before they are too old.'}
            </T>
          </View>
          {unclaimed.map((leg, i) => (
            <View
              key={leg.id}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                marginTop: i ? 0 : 8,
                borderTopWidth: 1,
                borderTopColor: C.wash,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                  {(MODE_SHORT[leg.mode as TravelMode] ?? leg.mode) + ' · ' + (leg.customerName ?? 'a shop')}
                </T>
                <T s="caption" style={{ marginTop: 2 }}>
                  {dmy(isoDate(new Date(leg.departedAt)))}
                </T>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'Claim the fare for ' + (leg.customerName ?? 'this journey')}
                onPress={() => claimFare(leg)}
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}>
                <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Claim it</T>
              </Pressable>
            </View>
          ))}
        </ListCard>
      ) : null}

      <ListCard style={{ marginTop: 16 }}>
        {rows.map((e, i) => {
          const tone: BadgeTone = e.state === 'Approved' ? 'success' : e.state === 'Pending' ? 'amber' : 'danger';
          return (
            <View
              key={e.id}
              style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                  {e.category + ' · ' + inr(e.amountPaise / 100)}
                </T>
                <Badge tone={tone}>{e.state}</Badge>
              </View>
              <T s="caption" style={{ marginTop: 3 }}>
                {dmy(e.spentOn) + ' · ' + (e.remarks ?? '')}
              </T>
              {/* WHERE IT CAME FROM, said on the row. Without it, the claim he
                  made at the shop door looks identical to one he typed here —
                  and the honest thing somebody does about a fare they cannot
                  remember claiming is claim it again. */}
              {e.source === 'travel_ticket' ? (
                <T style={{ fontSize: 13, lineHeight: 19, color: C.muted }}>
                  From the ticket you photographed on the journey
                </T>
              ) : null}
              <T style={{ fontSize: 13, lineHeight: 19, color: e.billPhotoId ? C.muted : C.warn }}>
                {e.billPhotoId ? 'Bill attached' : 'No bill — may be rejected'}
              </T>
              {e.state === 'Rejected' ? (
                <>
                  <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                    {e.rejectionReason ?? 'Sent back — no bill attached'}
                  </T>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => fix(e)}
                    style={{ minHeight: 48, justifyContent: 'center', marginTop: 2 }}>
                    <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Correct it and send again</T>
                  </Pressable>
                </>
              ) : null}
            </View>
          );
        })}
      </ListCard>

      {/* ------------------------------------------------------ claim sheet */}
      <BottomSheet open={open} onClose={close} scroll>
        <T s="h2">{fixing ? 'Correct this claim' : 'Claim an expense'}</T>

        <View style={{ marginTop: 14 }}>
          <T s="label">What for</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {kinds.map((k) => (
              <Choice
                key={k}
                label={k}
                sub={inr(Math.max(0, (caps[k] ?? 0) - usedPaise(k)) / 100) + ' left'}
                selected={kind === k}
                onPress={() => patch({ kind: k })}
                style={{ flex: 1 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            How much
          </T>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              height: 52,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: err === 'amt' ? C.danger : C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
            }}>
            <T style={[{ fontSize: 18, color: C.muted }, weight(600)]}>₹</T>
            <TextInput
              value={ex.amt}
              onChangeText={(v) => patch({ amt: v.replace(/[^0-9]/g, '') })}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={C.faint}
              style={[{ flex: 1, minWidth: 0, alignSelf: 'stretch', fontSize: 18, color: C.ink, padding: 0 }, weight(600), tabular]}
            />
          </View>
          {err === 'amt' ? <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Enter what you spent.</T> : null}
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 6, color: exOver ? C.warnInk : C.muted }}>{capLine}</T>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            Bill
          </T>
          {ex.billLabel ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 52,
                paddingLeft: 14,
                paddingRight: 6,
                borderWidth: 1,
                borderColor: C.success,
                borderRadius: radius.lg,
                backgroundColor: C.successBg,
              }}>
              <Icon name="tick" size={16} color={C.success} strokeWidth={2.4} />
              <T style={[{ fontSize: 15, color: C.success }, weight(500)]}>{ex.billLabel}</T>
              <Pressable
                accessibilityRole="button"
                onPress={() => patch({ billMediaId: null, billLabel: null })}
                style={{ marginLeft: 'auto', minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10 }}>
                <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Change</T>
              </Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { glyph: 'camera', label: 'Photograph it', source: 'camera' as const },
                { glyph: 'clip', label: 'Upload a file', source: 'library' as const },
              ].map((b) => (
                <Pressable
                  key={b.label}
                  accessibilityRole="button"
                  onPress={() => attach(b.source)}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    minHeight: 52,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: err === 'bill' ? C.danger : C.faint,
                    borderRadius: radius.lg,
                    backgroundColor: C.surface,
                  }}>
                  <Icon name={b.glyph} size={18} color={C.body} />
                  <T style={[{ fontSize: 15, color: C.body }, weight(500)]}>{b.label}</T>
                </Pressable>
              ))}
            </View>
          )}
          <T style={{ fontSize: 13, lineHeight: 19, marginTop: 6, color: err === 'bill' ? C.danger : C.muted }}>
            Required on every claim — photo, PDF or a payment screenshot.
          </T>
          {err === 'bill' ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Attach the bill or proof of payment.</T>
          ) : null}
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            When you spent it
          </T>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setErr(null);
              setCal(true);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              minHeight: 52,
              paddingHorizontal: 14,
              borderWidth: 1,
              borderColor: err === 'when' ? C.danger : cal ? C.primary : C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
            }}>
            <T style={{ fontSize: 16, color: ex.when ? C.ink : C.muted }}>{ex.when || 'Pick the day'}</T>
            <T style={{ fontSize: 18, color: C.muted }}>▾</T>
          </Pressable>
          {err === 'when' ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Pick the day you spent it.</T>
          ) : null}
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            What it was for
          </T>
          <Input
            value={ex.note}
            onChangeText={(v) => patch({ note: v })}
            multiline
            invalid={err === 'note'}
            placeholder="Nagpur – Kamptee – Nagpur, 84 km"
            style={{ minHeight: 72 }}
          />
          {err === 'note' ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
              Say what it was for — your manager approves on this.
            </T>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={close} style={{ flex: 1 }} />
          <PrimaryButton label={fixing ? 'Send it again' : 'Send the claim'} onPress={send} style={{ flex: 1 }} />
        </View>
      </BottomSheet>

      {/* --------------------------------------------------- when calendar */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={ex.whenIso}
          disabledReason={refuse}
          onPick={(iso) => {
            patch({ when: dmy(iso), whenIso: iso });
            setCal(false);
          }}
        />
        <T s="caption" style={{ marginTop: 10 }}>
          {'Anything older than ' + maxAgeDays + ' days cannot be claimed.'}
        </T>
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>
    </AppFrame>
  );
}
