import React from 'react';
import { View, ScrollView } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Divider, Input, PrimaryButton, SecondaryButton, T, Toggle } from '../src/components/ui/primitives';
import { color as C, radius, weight } from '../src/theme/tokens';
import {
  distributorProfileOf,
  leadFunnelView,
  qualificationOf,
  saveDistributorProfile,
  saveQualification,
  type LeadFunnelView,
} from '../src/data/lead-funnel';
import { checklistFor, stageLabel, type Condition } from '../src/engines/funnel';
import { plural } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * §9 §11 — the checklist, and it is two different sizes of question.
 *
 * A shop answers twelve and a distributor answers thirty, and that is not a
 * longer version of the same form: appointing a distributor is a commercial
 * arrangement rather than a sale, so it is asked in the specification's five
 * GROUPS and each group saves on its own. Thirty questions is four or five
 * screens filled over several visits, and a form that only commits when it is
 * complete loses everything somebody managed before the shop got busy — which
 * on this checklist is most of the times it is opened.
 *
 * Progress is a COUNT and never a bar. "18 of 30" is a number a salesman can
 * act on; a bar three fifths full says the same thing less precisely and reads
 * as a loading indicator on a screen that is not loading anything.
 *
 * Eight of the shop's twelve are satisfied by REAL VALUES on the record rather
 * than by a tick — the gate reads the value, so a tick beside an empty field
 * is a state that cannot happen. Those rows say where the answer lives and
 * link to it rather than offering a switch that would lie.
 */

/* ------------------------------------------------------ the thirty, typed
 *
 * Every distributor condition maps onto the field `lead-gates.ts` actually
 * reads. The names are the engine's, not this screen's — a second spelling
 * here would tick a box the gate never looks at, which is the exact failure
 * that makes a checklist worth nothing.
 */
type FieldKind = 'text' | 'number' | 'money' | 'yesno' | 'confirm' | 'date';

const DISTRIBUTOR_FIELDS: Record<string, { field: string; kind: FieldKind; hint?: string }> = {
  gst_verified: { field: 'gstVerified', kind: 'confirm' },
  pan_verified: { field: 'panVerified', kind: 'confirm' },
  address_verified: { field: 'businessAddressVerified', kind: 'confirm' },
  business_type: { field: 'businessType', kind: 'text', hint: 'Proprietor, partnership, private limited' },
  years_in_business: { field: 'yearsInBusiness', kind: 'number' },
  decision_maker: { field: 'decisionMaker', kind: 'text' },

  dealer_network: { field: 'hasDealerNetwork', kind: 'confirm' },
  active_dealers: { field: 'activeDealerCount', kind: 'number' },
  territory_covered: { field: 'territoryCovered', kind: 'text' },
  cities_covered: { field: 'citiesCovered', kind: 'text' },
  sales_team: { field: 'salesTeamSize', kind: 'number' },
  delivery_capability: { field: 'deliveryCapability', kind: 'text', hint: 'Own vehicle, transport, customer collects' },
  warehouse: { field: 'hasWarehouse', kind: 'confirm' },
  storage_capacity: { field: 'storageCapacityLitres', kind: 'number', hint: 'In litres' },

  product_portfolio: { field: 'productPortfolio', kind: 'text' },
  competitor_brands: { field: 'competitorBrands', kind: 'text' },
  monthly_potential: { field: 'monthlyPotentialPaise', kind: 'money' },
  initial_order_potential: { field: 'initialOrderPotentialPaise', kind: 'money' },
  investment_capacity: { field: 'investmentCapacityPaise', kind: 'money' },
  expected_monthly_purchase: { field: 'expectedMonthlyPurchasePaise', kind: 'money' },
  credit_days_required: { field: 'creditDaysRequired', kind: 'number' },
  credit_limit_required: { field: 'creditLimitRequiredPaise', kind: 'money' },

  proposed_territory: { field: 'proposedTerritory', kind: 'text' },
  existing_checked: { field: 'existingDistributorChecked', kind: 'confirm' },
  /* Yes and no are BOTH answers here. The condition is that somebody looked,
     not that the answer was convenient — a real clash is management's to weigh
     and not this gate's to hide. */
  conflict_checked: { field: 'territoryConflict', kind: 'yesno' },
  exclusivity: { field: 'exclusivityRequested', kind: 'yesno' },

  initial_stock: { field: 'initialStockCommitmentPaise', kind: 'money' },
  monthly_commitment: { field: 'monthlyPurchaseCommitmentPaise', kind: 'money' },
  dealer_development: { field: 'dealerDevelopmentCommitment', kind: 'text' },
  expected_start: { field: 'expectedStartDate', kind: 'date', hint: 'YYYY-MM-DD' },
};

const GROUP_TITLE: Record<string, string> = {
  legal: 'Business and legal',
  capability: 'Distribution capability',
  commercial: 'Commercial capability',
  territory: 'Territory',
  commitment: 'What they commit to',
};

/**
 * The shop's twelve, and where each is actually answered.
 *
 * A `column` means the gate reads a real value off the record and no switch on
 * this screen can satisfy it. `gst_verified` is the one that needs both: the
 * number has to be there AND somebody has to say they checked it, which is the
 * difference between a GST written down and a GST verified.
 */
const SHOP_COLUMNS: Record<string, { reads: (v: LeadFunnelView) => boolean; where: string }> = {
  gst_verified: { reads: (v) => Boolean(v.lead.gstin?.trim()), where: 'GST number, on Prospect details' },
  /* Both columns, for the two that have two. The capture form writes what he
     was told in the shop into `monthlyVolumeLitres`/`competitorName` and the
     office writes the same facts into `monthlyLitres`/`competitor` —
     `leadGateInput` coalesces them, so reading one pair here would say "Not
     yet" about an answer the gate had already accepted. */
  monthly_requirement: {
    reads: (v) => (v.lead.monthlyLitres ?? v.lead.monthlyVolumeLitres) != null,
    where: 'Litres a month, on Prospect details',
  },
  monthly_potential: { reads: (v) => v.lead.estimatedPotentialPaise != null, where: 'What they could be worth, on Prospect details' },
  required_product: { reads: (v) => Boolean(v.lead.requiredProductId), where: 'Which of ours, on Prospect details' },
  competitor_identified: {
    reads: (v) => Boolean(v.lead.competitor?.trim() || v.lead.competitorName?.trim()),
    where: 'Whose product now, on Prospect details',
  },
  credit_days: { reads: (v) => v.lead.creditDaysWanted != null, where: 'Credit they want, on Prospect details' },
  decision_maker: { reads: (v) => Boolean(v.lead.decisionMaker?.trim()), where: 'Who signs off, on Prospect details' },
  application_understood: { reads: (v) => Boolean(v.lead.application?.trim()), where: 'What they use it on, on Prospect details' },
};

export default function QualifyScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('lead');
  const notify = useStore((s) => s.notify);

  /*
   * THE CHEVRON CARRIES THE LEAD'S ID, and it did not.
   *
   * This screen is only ever opened as `/lead-qualify?id=X&from=lead`, and
   * `useCameFrom` builds its destination from the word alone — `/lead`, with no
   * id — so `/lead` loaded nothing and drew "This lead is not on this phone".
   * On a checklist that is the worst place for it: the unsaved draft goes with
   * it. One function for the header chevron and the inline link.
   */
  const goBack = () => {
    if (back.from === 'lead' && id) return router.replace(`/lead?id=${id}&from=leads`);
    back.go();
  };

  const [view, setView] = React.useState<LeadFunnelView | null>(null);
  const [ready, setReady] = React.useState(false);
  const [group, setGroup] = React.useState<string>('legal');
  /* Kept as strings because that is what a text box holds. Converted on the
     way out, once, in `saveGroup` — parsing on every keystroke is how a half
     typed "1" becomes a saved 1. */
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [ticks, setTicks] = React.useState<Record<string, boolean>>({});

  const load = React.useCallback(() => {
    let live = true;
    if (!id) return;
    void leadFunnelView(id).then((v) => {
      if (!live || !v) return;
      setView(v);
      if (!ready) {
        const profile = distributorProfileOf(v.lead);
        const next: Record<string, string> = {};
        const on: Record<string, boolean> = {};
        for (const [cid, f] of Object.entries(DISTRIBUTOR_FIELDS)) {
          const raw = profile[f.field];
          if (raw === undefined || raw === null) continue;
          if (f.kind === 'confirm' || f.kind === 'yesno') on[cid] = raw === true;
          else if (f.kind === 'money') next[cid] = String(Math.round(Number(raw) / 100));
          else next[cid] = String(raw);
        }
        const q = qualificationOf(v.lead);
        for (const [k, val] of Object.entries(q)) {
          if (val === true) on[k] = true;
          else if (typeof val === 'string' && val) next[k] = val;
        }
        setDraft(next);
        setTicks(on);
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, [id, ready]);

  useFocusEffect(load);

  if (!view) {
    return (
      <AppFrame title="Qualification" activeTab={null} onBack={goBack} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={goBack} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            This lead is not on this phone
          </T>
        </Card>
      </AppFrame>
    );
  }

  const { lead, salesType } = view;
  const conditions = checklistFor(salesType, 'qualification');
  const isDistributor = salesType === 'distributor';

  /*
   * Whether one condition is answered, asked the same way the gate asks it.
   *
   * `live` is the whole point of the parameter. A ROW on the screen shows what
   * is in the box in front of him, because a switch that did not move when it
   * was pressed reads as a broken switch. Every COUNT — the header and each
   * group chip — shows what has been KEPT, read off the record. They used to be
   * one reading of the draft, so a group filled in and not yet saved reported
   * "8/8" for answers the database had never seen, under a caption saying it
   * saves as you go.
   */
  const savedProfile = distributorProfileOf(lead);
  const savedQualification = qualificationOf(lead);

  const answeredIn = (c: Condition, live: boolean): boolean => {
    if (isDistributor) {
      const f = DISTRIBUTOR_FIELDS[c.id];
      if (!f) return false;
      if (live) {
        if (f.kind === 'confirm') return ticks[c.id] === true;
        /* Both answers count — see `conflict_checked` above. A yes/no is
           answered once it has been TOUCHED, which is why it is stored as a key
           that exists rather than as a boolean that defaults to false. */
        if (f.kind === 'yesno') return c.id in ticks;
        return Boolean((draft[c.id] ?? '').trim());
      }
      const raw = savedProfile[f.field];
      if (f.kind === 'confirm') return raw === true;
      if (f.kind === 'yesno') return raw === true || raw === false;
      return raw !== null && raw !== undefined && String(raw).trim().length > 0;
    }
    const col = SHOP_COLUMNS[c.id];
    if (col) {
      /* The GST is the one that needs both halves — a number written down and
         somebody saying they checked it are two different facts. */
      const tick = live ? ticks[c.id] === true : savedQualification[c.id] === true;
      return c.id === 'gst_verified' ? col.reads(view) && tick : col.reads(view);
    }
    if (live) return ticks[c.id] === true;
    const said = savedQualification[c.id];
    return said === true || (typeof said === 'string' && said.trim().length > 0);
  };

  /** What is KEPT — the number the counts are allowed to quote. */
  const answered = (c: Condition): boolean => answeredIn(c, false);

  const done = conditions.filter(answered).length;
  const shown = isDistributor ? conditions.filter((c) => c.group === group) : conditions;

  const saveGroup = async () => {
    if (isDistributor) {
      const patch: Record<string, unknown> = {};
      /*
       * EVERY condition, not the group on the screen.
       *
       * It built the patch from `shown`, so filling in Commercial capability,
       * switching to Territory and pressing Save wrote Territory and dropped
       * the eight commercial answers — while the header and the chips, reading
       * the draft, went on reporting all of them as answered. Thirty questions
       * gathered over several visits is exactly the form that loses. The write
       * MERGES into what is stored and an untouched condition is skipped
       * rather than written null, so saving the lot costs nothing and cannot
       * blank a group he has not opened.
       */
      for (const c of conditions) {
        const f = DISTRIBUTOR_FIELDS[c.id];
        if (!f) continue;
        if (f.kind === 'confirm' || f.kind === 'yesno') {
          if (c.id in ticks) patch[f.field] = ticks[c.id];
          continue;
        }
        const raw = (draft[c.id] ?? '').trim();
        if (!raw) continue;
        patch[f.field] =
          f.kind === 'money'
            ? Number(raw.replace(/[^\d]/g, '')) * 100
            : f.kind === 'number'
              ? Number(raw.replace(/[^\d]/g, ''))
              : raw;
      }
      /* No group name on the trail any more: the write is the whole checklist,
         and "saved — Territory" against a row that carried all five groups is
         a line somebody would read back as a partial save. */
      const r = await saveDistributorProfile(lead.id, patch);
      if (!r.ok) return notify(r.message);
      load();
      return notify('Saved — every answer on this checklist');
    }

    const answers: Record<string, boolean | string> = {};
    for (const c of conditions) {
      if (c.id in ticks) answers[c.id] = ticks[c.id];
      const typed = (draft[c.id] ?? '').trim();
      if (typed) answers[c.id] = typed;
    }
    const r = await saveQualification(lead.id, answers);
    if (!r.ok) return notify(r.message);
    load();
    notify('Qualification saved');
  };

  return (
    <AppFrame
      title={isDistributor ? 'Distributor qualification' : 'Qualification'}
      activeTab={null}
      onBack={goBack}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={goBack} />

      <Card>
        <T style={[{ fontSize: 17, lineHeight: 23, color: C.ink }, weight(600)]}>
          {lead.company?.trim() || lead.name}
        </T>
        <T s="caption" style={{ marginTop: 2 }}>{stageLabel(view.stage)}</T>
        <Divider style={{ marginVertical: 12 }} />
        {/* A count, never a bar. */}
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(600)]}>
          {done + ' of ' + conditions.length + ' answered'}
        </T>
        {/* KEPT, not typed. The count is what the phone is holding, so it does
            not move until Save has been pressed — and Save writes the whole
            checklist, not the group on the screen. */}
        <T s="caption" style={{ marginTop: 2 }}>
          {done === conditions.length
            ? 'All of them, saved. The rung above is open from the record.'
            : plural(conditions.length - done, 'question') +
              ' still to go. This counts what is saved — press Save and it keeps the lot.'}
        </T>
      </Card>

      {isDistributor ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
          style={{ marginHorizontal: -16, paddingHorizontal: 16, marginTop: 16 }}>
          {Object.keys(GROUP_TITLE).map((g) => {
            const inGroup = conditions.filter((c) => c.group === g);
            const got = inGroup.filter(answered).length;
            return (
              <Choice
                key={g}
                label={GROUP_TITLE[g]}
                sub={got + '/' + inGroup.length}
                selected={group === g}
                onPress={() => setGroup(g)}
                style={{ paddingHorizontal: 14 }}
              />
            );
          })}
        </ScrollView>
      ) : null}

      <View style={{ marginTop: 16, gap: 12 }}>
        {shown.map((c) => {
          const col = isDistributor ? undefined : SHOP_COLUMNS[c.id];
          const f = isDistributor ? DISTRIBUTOR_FIELDS[c.id] : undefined;
          /* The ROW reads the boxes on the screen — a switch that did not move
             when it was pressed reads as a broken switch. The counts above read
             the record. */
          const met = answeredIn(c, true);

          return (
            <Card key={c.id}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(500)]}>{c.says}</T>
                  {f?.hint ? <T s="caption" style={{ marginTop: 2 }}>{f.hint}</T> : null}
                  {col ? (
                    <T s="caption" style={{ marginTop: 2 }}>
                      {met ? 'Answered — ' + col.where : 'Answer it under ' + col.where}
                    </T>
                  ) : null}
                </View>
                {/* A value-backed condition draws no switch, because a switch
                    that cannot satisfy the gate is a control that lies. The
                    GST is the exception and gets both halves. */}
                {col && c.id !== 'gst_verified' ? (
                  <T style={[{ fontSize: 14, color: met ? C.success : C.muted }, weight(600)]}>
                    {met ? 'Done' : 'Not yet'}
                  </T>
                ) : f && (f.kind === 'text' || f.kind === 'number' || f.kind === 'money' || f.kind === 'date') ? null : f?.kind === 'yesno' ? (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Choice
                      label="Yes"
                      selected={ticks[c.id] === true}
                      onPress={() => setTicks({ ...ticks, [c.id]: true })}
                      style={{ paddingHorizontal: 12, minHeight: 40 }}
                    />
                    <Choice
                      label="No"
                      selected={c.id in ticks && ticks[c.id] === false}
                      onPress={() => setTicks({ ...ticks, [c.id]: false })}
                      style={{ paddingHorizontal: 12, minHeight: 40 }}
                    />
                  </View>
                ) : (
                  <Toggle
                    on={ticks[c.id] === true}
                    onPress={() => setTicks({ ...ticks, [c.id]: !ticks[c.id] })}
                    size="sm"
                  />
                )}
              </View>

              {f && (f.kind === 'text' || f.kind === 'number' || f.kind === 'money' || f.kind === 'date') ? (
                <Input
                  value={draft[c.id] ?? ''}
                  onChangeText={(v) => setDraft({ ...draft, [c.id]: v })}
                  placeholder={f.kind === 'money' ? 'In rupees' : f.kind === 'date' ? 'YYYY-MM-DD' : ''}
                  keyboardType={f.kind === 'number' || f.kind === 'money' ? 'number-pad' : 'default'}
                  style={{ marginTop: 10 }}
                />
              ) : null}
            </Card>
          );
        })}
      </View>

      {conditions.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 21, color: C.muted, textAlign: 'center' }}>
            There is no checklist on this ladder. A lead raised before the funnel existed climbs the six rungs it
            started on.
          </T>
        </Card>
      ) : (
        /* One button, and it saves the WHOLE checklist however many groups are
           half filled in. It used to name the group it was standing on, which
           was an honest label for a save that dropped the other four. */
        <PrimaryButton label="Save the checklist" onPress={saveGroup} style={{ marginTop: 18 }} />
      )}

      <SecondaryButton
        label="Back to the lead"
        onPress={() => router.replace(`/lead?id=${lead.id}&from=leads`)}
        style={{ marginTop: 10 }}
      />

      <View style={{ marginTop: 14, borderRadius: radius.lg, backgroundColor: C.wash, padding: 12 }}>
        <T s="caption">
          Everything here is saved on the phone first and goes up when there is signal. Nothing on this screen needs a
          connection.
        </T>
      </View>
    </AppFrame>
  );
}
