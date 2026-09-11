import React from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import { color as C, radius, weight } from '../src/theme/tokens';
import {
  leadFunnelView,
  saveProspectFields,
  setNextAction,
  type LeadFunnelView,
} from '../src/data/lead-funnel';
import { searchProducts } from '../src/data/customers';
import { currentSession } from '../src/data/session';
import { PROSPECT_CONDITIONS, labelOf, stageLabel } from '../src/engines/funnel';
import { pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * §5 §6 — the eight answers a Suspect owes, on ONE screen.
 *
 * One, because a salesman standing outside a shop will not come back to a
 * second one. Eight fields split across two pages is a record half-answered
 * every time the shop gets busy, and the half that is missing is always the
 * half the gate is waiting on.
 *
 * The fields are COLUMNS rather than checklist ticks, which is what makes the
 * gate honest: it reads the value, so there is no state where the form looks
 * complete and the rung is still shut, and no tick sitting beside an empty
 * box. What is drawn under the button is the same `PROSPECT_CONDITIONS` list
 * the gate refuses on — the screen and the rule are one file.
 *
 * "Decision maker" is on this form and is NOT one of the eight. The
 * specification says "if known", and a gate that refused on an optional field
 * would be a gate nobody could pass.
 */

/**
 * §6 — what kind of business it is, and it is a CODE rather than a word.
 *
 * The four are `customers.customer_type`'s own enum, which MahekOne has held
 * since long before the funnel and which a price list is decided from. A chip
 * reading "Paint shop" would be a fifth value the column does not accept, and
 * the whole lead update would be refused on it — so the code is what is
 * stored and the label is only what a salesman reads.
 */
const CUSTOMER_TYPES: readonly { code: string; label: string; hint: string }[] = [
  { code: 'retailer', label: 'Shop', hint: 'Sells over a counter' },
  { code: 'dealer', label: 'Dealer', hint: 'Sells on, in volume' },
  { code: 'manufacturer', label: 'Manufacturer', hint: 'Uses it in what they make' },
  { code: 'distributor', label: 'Distributor', hint: 'Stocks and supplies others' },
];

export default function ProspectForm() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('lead');
  const notify = useStore((s) => s.notify);

  const [view, setView] = React.useState<LeadFunnelView | null>(null);
  const [me, setMe] = React.useState<{ id: string; name: string } | null>(null);
  const [ready, setReady] = React.useState(false);

  const [customerType, setCustomerType] = React.useState('');
  const [litres, setLitres] = React.useState('');
  const [potential, setPotential] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [product, setProduct] = React.useState<{ id: string; name: string } | null>(null);
  const [productQuery, setProductQuery] = React.useState('');
  const [hits, setHits] = React.useState<{ id: string; name: string; formulation: string | null }[]>([]);
  const [contact, setContact] = React.useState('');
  const [decisionMaker, setDecisionMaker] = React.useState('');
  const [creditDays, setCreditDays] = React.useState('');
  const [application, setApplication] = React.useState('');
  const [gstin, setGstin] = React.useState('');
  const [reasonOpen, setReasonOpen] = React.useState(false);
  const [nextOpen, setNextOpen] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) return;
    void Promise.all([leadFunnelView(id), currentSession()]).then(([v, s]) => {
      if (!live || !v) return;
      setView(v);
      setMe(s ? { id: s.user.id, name: s.user.name } : null);
      /* Filled from the record ONCE, on the first load. A focus that refilled
         the boxes would throw away whatever was half-typed when somebody
         glanced at another screen — and the React Compiler rules forbid
         resetting state in an effect on a prop change for the same reason. */
      if (!ready) {
        setCustomerType(v.lead.customerType ?? '');
        setLitres(v.lead.monthlyLitres != null ? String(v.lead.monthlyLitres) : '');
        setPotential(
          v.lead.estimatedPotentialPaise != null ? String(Math.round(v.lead.estimatedPotentialPaise / 100)) : '',
        );
        setCompetitor(v.lead.competitor ?? '');
        setProduct(
          v.lead.requiredProductId
            ? { id: v.lead.requiredProductId, name: v.lead.requiredProductName ?? 'Chosen product' }
            : null,
        );
        setContact(v.lead.contactPerson ?? '');
        setDecisionMaker(v.lead.decisionMaker ?? '');
        setCreditDays(v.lead.creditDaysWanted != null ? String(v.lead.creditDaysWanted) : '');
        setApplication(v.lead.application ?? '');
        setGstin(v.lead.gstin ?? '');
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, [id, ready]);

  useFocusEffect(load);

  React.useEffect(() => {
    let live = true;
    if (!productQuery.trim()) {
      setHits([]);
      return;
    }
    void searchProducts(productQuery, 8).then((r) => {
      if (live) setHits(r.map((p) => ({ id: p.id, name: p.name, formulation: p.formulation })));
    });
    return () => {
      live = false;
    };
  }, [productQuery]);

  if (!view) {
    return (
      <AppFrame title="Prospect details" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            This lead is not on this phone
          </T>
        </Card>
      </AppFrame>
    );
  }

  const { lead, input, config } = view;

  const save = async (reasonCode?: string) => {
    const r = await saveProspectFields(lead.id, {
      customerType: customerType.trim() || null,
      monthlyLitres: litres.trim() ? Number(litres.replace(/[^\d]/g, '')) : null,
      /* Rupees on the screen, paise in the store — the only place the two
         meet, exactly as the new-lead form does it. */
      estimatedPotentialPaise: potential.trim() ? Number(potential.replace(/[^\d]/g, '')) * 100 : null,
      competitor: competitor.trim() || null,
      requiredProductId: product?.id ?? null,
      requiredProductName: product?.name ?? null,
      contactPerson: contact.trim() || null,
      decisionMaker: decisionMaker.trim() || null,
      creditDaysWanted: creditDays.trim() ? Number(creditDays.replace(/[^\d]/g, '')) : null,
      application: application.trim() || null,
      gstin: gstin.trim() || null,
      prospectReasonCode: reasonCode ?? lead.prospectReasonCode ?? null,
    });
    if (!r.ok) return notify(r.message);
    load();
    notify('Saved');
  };

  /* What is still missing, read off the SAME conditions the gate refuses on —
     so somebody working down this list cannot reach the bottom and still be
     refused, which is the failure that makes people stop trusting a checklist
     entirely. */
  const outstanding = PROSPECT_CONDITIONS.filter((c) => {
    switch (c.id) {
      case 'customer_type': return !customerType.trim();
      case 'monthly_litres': return !litres.trim();
      case 'potential_value': return !potential.trim();
      case 'competitor': return !competitor.trim();
      case 'required_product': return !product;
      case 'contact_person': return !contact.trim();
      case 'next_action': return !(lead.nextAction && lead.nextActionDate && lead.nextActionOwnerId);
      case 'prospect_reason': return !lead.prospectReasonCode;
      default: return false;
    }
  });

  return (
    <AppFrame
      title="Prospect details"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <T style={[{ fontSize: 17, lineHeight: 23, color: C.ink }, weight(600)]}>
          {lead.company?.trim() || lead.name}
        </T>
        <T s="caption" style={{ marginTop: 2 }}>
          {stageLabel(input.stage) + ' · everything on this page in one go'}
        </T>
      </Card>

      <View style={{ marginTop: 16 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What kind of business</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CUSTOMER_TYPES.map((t) => (
            <Choice
              key={t.code}
              label={t.label}
              sub={t.hint}
              selected={customerType === t.code}
              onPress={() => setCustomerType(t.code)}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Litres a month</SectionLabel>
        <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
        <T s="caption" style={{ marginTop: 6 }}>What they actually get through, of everything — not just ours.</T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What they could be worth a month</SectionLabel>
        <Input value={potential} onChangeText={setPotential} placeholder="40000" keyboardType="number-pad" />
        <T s="caption" style={{ marginTop: 6 }}>In rupees, roughly.</T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Whose product are they on now</SectionLabel>
        <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian, Berger, a local brand" />
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Which of ours do they need</SectionLabel>
        {product ? (
          <Choice
            label={product.name}
            selected
            onPress={() => { setProduct(null); setProductQuery(''); }}
            style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
          />
        ) : (
          <>
            <Input value={productQuery} onChangeText={setProductQuery} placeholder="Thinner, Nano, M5x4" />
            <View style={{ gap: 8, marginTop: 8 }}>
              {hits.map((p) => (
                <Choice
                  key={p.id}
                  label={p.name}
                  sub={p.formulation ?? undefined}
                  selected={false}
                  onPress={() => { setProduct({ id: p.id, name: p.name }); setProductQuery(''); }}
                  style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
                />
              ))}
              {productQuery.trim() && hits.length === 0 ? (
                <T s="caption">Nothing in the catalogue matches that.</T>
              ) : null}
            </View>
          </>
        )}
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Who we ask for when we ring</SectionLabel>
        <Input value={contact} onChangeText={setContact} placeholder="Suresh, on the counter" />
      </View>

      {/* Not one of the eight — the specification says "if known", and a gate
          that refused on an optional field would be one nobody could pass. It
          IS one of the twelve at qualification, so it is asked here where the
          salesman is already standing in front of the man. */}
      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Who actually signs off a purchase</SectionLabel>
        <Input value={decisionMaker} onChangeText={setDecisionMaker} placeholder="Optional — the proprietor, his son" />
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Credit they want, in days</SectionLabel>
        <Input value={creditDays} onChangeText={setCreditDays} placeholder="Optional — 30" keyboardType="number-pad" />
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What they will use it on</SectionLabel>
        <Input value={application} onChangeText={setApplication} placeholder="Optional — furniture polish, spray booth" />
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>GST number</SectionLabel>
        <Input value={gstin} onChangeText={setGstin} placeholder="Optional here — required before a sample goes out" autoCapitalize="characters" />
      </View>

      {/* -------------------------------------------------- §24 and §5 */}
      <View style={{ marginTop: 18, gap: 10 }}>
        <SecondaryButton
          label={lead.nextAction ? 'Next: ' + lead.nextAction : 'Say what happens next'}
          onPress={() => setNextOpen(true)}
        />
        {lead.nextActionDate ? <T s="caption">{pretty(lead.nextActionDate)}</T> : null}

        <SecondaryButton
          label={
            lead.prospectReasonCode
              ? 'Why: ' + labelOf(config.prospectReasons, lead.prospectReasonCode)
              : 'Say why this is worth pursuing'
          }
          onPress={() => setReasonOpen(true)}
        />
      </View>

      {/* What the gate is still waiting on, in the gate's own words. */}
      {outstanding.length ? (
        <View
          style={{
            marginTop: 16,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.lg,
            backgroundColor: C.surface,
            padding: 12,
            gap: 6,
          }}>
          <T s="caption">Still to answer before this can be a Prospect</T>
          {outstanding.map((c) => (
            <T key={c.id} style={{ fontSize: 15, lineHeight: 21, color: C.ink }}>{'· ' + c.says}</T>
          ))}
        </View>
      ) : (
        <View style={{ marginTop: 16 }}>
          <T style={[{ fontSize: 15, lineHeight: 21, color: C.success }, weight(500)]}>
            All eight answered. Save, then move it up from the record.
          </T>
        </View>
      )}

      <PrimaryButton label="Save the details" onPress={() => save()} style={{ marginTop: 16 }} />
      <SecondaryButton
        label="Back to the lead"
        onPress={() => router.replace(`/lead?id=${lead.id}&from=leads`)}
        style={{ marginTop: 10 }}
      />

      <ReasonSheet
        key={reasonOpen ? 'why-open' : 'why-shut'}
        open={reasonOpen}
        onClose={() => setReasonOpen(false)}
        title="Why is this worth pursuing?"
        body="Ten answers, and none of them is a text box — this is the question that stops a shop somebody walked past becoming a prospect."
        options={config.prospectReasons}
        confirmLabel="That is why"
        onConfirm={(code) => {
          setReasonOpen(false);
          void save(code);
        }}
      />

      <NextActionSheet
        key={nextOpen ? 'next-open' : 'next-shut'}
        open={nextOpen}
        onClose={() => setNextOpen(false)}
        meId={me?.id ?? ''}
        meName={me?.name ?? 'You'}
        current={{ action: lead.nextAction, date: lead.nextActionDate, ownerId: lead.nextActionOwnerId }}
        onSave={(n) => {
          setNextOpen(false);
          void setNextAction(lead.id, n).then((r) => {
            if (!r.ok) return notify(r.message);
            load();
            notify('Next: ' + n.action);
          });
        }}
      />
    </AppFrame>
  );
}
