import React from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import {
  BLANK_VERIFY,
  correctionRefusal,
  fieldChecksFrom,
  rememberFieldChecks,
  VerifyFieldRow,
  type VerifyAnswer,
} from '../src/components/leads/verify-field-row';
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
 *
 * **WHERE A VISIT ALREADY FOUND A VALUE, THE BOX IS NOT A BOX.** §5.1 asks for
 * the Section 4 fields to be "captured OR CORRECTED", and a plain input over a
 * value somebody already wrote down can only ever do the first — it overwrites
 * the earlier reading silently, so nothing afterwards records that the two
 * disagreed or why. Those rows are `VerifyFieldRow` instead: confirm, correct
 * with a stated reason, or say plainly that nobody would answer. It is the
 * same control the office's verification screen draws, for the same reason
 * §1 gives — one book, and a second visit CHECKS the first rather than typing
 * over it.
 *
 * **SIX OF THEM, AND ONLY WHERE THERE IS SOMETHING TO CHECK.** The six are
 * §5.1's own list — the monthly requirement, the potential, the product, the
 * competitor, the contact and the decision maker. What kind of business this
 * is, the credit days, the application and the GST number are left as plain
 * boxes: the first is a four-chip pick where "correct it" is the tap itself,
 * and the other three are optional details nobody is being checked on. A field
 * the record has no answer for falls back to a plain input whatever list it is
 * on, because "Confirm" over an empty box is asking somebody to confirm
 * nothing.
 */

/**
 * The finding codes, which are `VERIFICATION_FINDINGS`' own and not a second
 * spelling of them — the office counts corrections by these, and a code typed
 * into a screen and into nothing else is a correction that arrives naming a
 * field nobody can look up. The words beside them are this screen's, because
 * "Litres a month" is what the heading above the row says and a refusal that
 * named the field differently would read as being about a different field.
 */
const CHECKED: readonly { field: string; label: string }[] = [
  { field: 'monthly_litres', label: 'Litres a month' },
  { field: 'potential', label: 'What they could be worth' },
  { field: 'competitor', label: 'Whose product they are on' },
  { field: 'required_product', label: 'Which of ours they need' },
  { field: 'contact_person', label: 'Who we ask for' },
  { field: 'decision_maker', label: 'Who signs off a purchase' },
];

const CHECKED_LABELS: Record<string, string> = Object.fromEntries(
  CHECKED.map((c) => [c.field, c.label]),
);

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

  /*
   * THE CHEVRON CARRIES THE LEAD'S ID, and it did not.
   *
   * This screen is only ever opened as `/lead-prospect?id=X&from=lead`, and
   * `useCameFrom` builds its destination from the word alone — `/lead`, with no
   * id. `/lead` then reads an empty id, loads nothing, and draws "This lead is
   * not on this phone": the first control on the screen said the shop he is
   * standing in front of had vanished. One function for the header chevron and
   * the inline link, so the label and where it lands cannot drift apart.
   */
  const goBack = () => {
    if (back.from === 'lead' && id) return router.replace(`/lead?id=${id}&from=leads`);
    back.go();
  };

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

  /*
   * WHAT THE RECORD HELD WHEN THIS SCREEN OPENED, kept apart from what is in
   * the boxes. It is the `original` half of every before/after pair, and it is
   * a copy taken at that moment on purpose: the lead's own columns are live —
   * a save rewrites them — so reading one back to find out what a correction
   * corrected would answer with whatever it says afterwards.
   */
  const [originals, setOriginals] = React.useState<Record<string, string>>({});
  const [originalProduct, setOriginalProduct] = React.useState<{ id: string; name: string } | null>(
    null,
  );
  const [checks, setChecks] = React.useState<Record<string, VerifyAnswer>>({});

  /* Double taps are guarded by a ref rather than by state: state is a render
     behind, and the second tap of a double tap lands inside that gap. */
  const saving = React.useRef(false);

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
        /* TWO COLUMNS, ONE FACT — the capture form writes what he was told in
           the shop into `monthlyVolumeLitres`/`competitorName` and the office
           writes the same two into `monthlyLitres`/`competitor`. Reading only
           the second pair opened this form with both boxes empty ten minutes
           after he had answered them, and the outstanding list below then
           printed both as still to answer. `leadGateInput` coalesces the same
           way, so the boxes and the gate agree. */
        const litresHere = v.lead.monthlyLitres ?? v.lead.monthlyVolumeLitres;
        setLitres(litresHere != null ? String(litresHere) : '');
        const potentialHere =
          v.lead.estimatedPotentialPaise != null
            ? String(Math.round(v.lead.estimatedPotentialPaise / 100))
            : '';
        setPotential(potentialHere);
        const competitorHere = (v.lead.competitor ?? v.lead.competitorName ?? '').trim();
        setCompetitor(competitorHere);
        const productHere = v.lead.requiredProductId
          ? { id: v.lead.requiredProductId, name: v.lead.requiredProductName ?? 'Chosen product' }
          : null;
        setProduct(productHere);
        setOriginalProduct(productHere);
        setContact(v.lead.contactPerson ?? '');
        setDecisionMaker(v.lead.decisionMaker ?? '');
        /* Taken in the same breath as the boxes, off the same values, so the
           row can never show one thing and the pair record another. */
        setOriginals({
          monthly_litres: litresHere != null ? String(litresHere) : '',
          potential: potentialHere,
          competitor: competitorHere,
          required_product: productHere?.name ?? '',
          contact_person: (v.lead.contactPerson ?? '').trim(),
          decision_maker: (v.lead.decisionMaker ?? '').trim(),
        });
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
      <AppFrame title="Prospect details" activeTab={null} onBack={goBack} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={goBack} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            This lead is not on this phone
          </T>
        </Card>
      </AppFrame>
    );
  }

  const { lead, input, config } = view;

  const patchCheck = (field: string, patch: Partial<VerifyAnswer>) =>
    setChecks((prev) => ({ ...prev, [field]: { ...(prev[field] ?? BLANK_VERIFY), ...patch } }));

  /*
   * WHAT THE FIELD IS WORTH NOW, which is a different question on a checked
   * row to an unchecked one.
   *
   * With nothing recorded, the box is the answer. With something recorded, the
   * VERDICT decides: only a correction moves the value, and a row nobody has
   * touched keeps exactly what was there — so a salesman who opens this form
   * to fill in the GST number cannot blank the other man's six answers by
   * saving.
   */
  const answered = (field: string, typed: string) => {
    const was = originals[field] ?? '';
    if (!was) return typed.trim();
    const a = checks[field];
    return a?.verdict === 'corrected' ? a.corrected.trim() : was;
  };

  const litresNow = answered('monthly_litres', litres);
  const potentialNow = answered('potential', potential);
  const competitorNow = answered('competitor', competitor);
  const contactNow = answered('contact_person', contact);
  const decisionMakerNow = answered('decision_maker', decisionMaker);

  /* Said before the button is pressed, never after it: refused at the save,
     the sentence somebody had in mind is already gone and the other seven
     answers go with it. */
  const refusal = correctionRefusal(checks, CHECKED_LABELS);

  const save = async (reasonCode?: string) => {
    if (saving.current) return;
    /* `PrimaryButton` keeps a button with a `whyDisabled` PRESSABLE and hands
       the press to us, so this is where the refusal is actually spoken — the
       same shape `collect()` in pay.tsx uses. */
    if (refusal) return notify(refusal);
    saving.current = true;
    try {
      const r = await saveProspectFields(lead.id, {
        customerType: customerType.trim() || null,
        monthlyLitres: litresNow ? Number(litresNow.replace(/[^\d]/g, '')) : null,
        /* Rupees on the screen, paise in the store — the only place the two
           meet, exactly as the new-lead form does it. */
        estimatedPotentialPaise: potentialNow ? Number(potentialNow.replace(/[^\d]/g, '')) * 100 : null,
        competitor: competitorNow || null,
        requiredProductId: product?.id ?? null,
        requiredProductName: product?.name ?? null,
        contactPerson: contactNow || null,
        decisionMaker: decisionMakerNow || null,
        creditDaysWanted: creditDays.trim() ? Number(creditDays.replace(/[^\d]/g, '')) : null,
        application: application.trim() || null,
        gstin: gstin.trim() || null,
        prospectReasonCode: reasonCode ?? lead.prospectReasonCode ?? null,
      });
      if (!r.ok) return notify(r.message);

      /*
       * THE PAIRS TRAVEL WITH THE SAVE, and after it rather than before.
       *
       * `saveProspectFields` queues the lead's own fields, so by the time this
       * runs the record is safe and a failure here costs the reason and never
       * the answer — the same discipline a photograph gets, and the same
       * reason no save on this app is ever refused for want of signal. The
       * wire cannot carry them yet (see `verify-field-row.tsx`), so they wait
       * on the phone rather than being handed to a schema that would strip
       * them without a word.
       */
      await rememberFieldChecks(
        lead.id,
        fieldChecksFrom(checks, originals, me, Date.now()),
      );

      /*
       * And the rows are re-baselined against what was just written. The
       * record now HOLDS the corrected answer, so leaving the row quoting the
       * old one would invite the same correction to be made and recorded
       * twice — one shop appearing to have contradicted itself on one
       * afternoon.
       */
      setOriginals((prev) => ({
        ...prev,
        monthly_litres: prev.monthly_litres ? litresNow : '',
        potential: prev.potential ? potentialNow : '',
        competitor: prev.competitor ? competitorNow : '',
        required_product: prev.required_product ? (product?.name ?? '') : '',
        contact_person: prev.contact_person ? contactNow : '',
        decision_maker: prev.decision_maker ? decisionMakerNow : '',
      }));
      setOriginalProduct(product);
      setChecks({});
      load();
      notify('Saved');
    } finally {
      saving.current = false;
    }
  };

  /*
   * The catalogue search, written once and used by both shapes of the product
   * field — plain where nothing was recorded, and the corrected half of the
   * row where something was. Two copies of it is how the picker on one of them
   * quietly stops mirroring the name into the pair.
   */
  const pickProduct = (p: { id: string; name: string } | null) => {
    setProduct(p);
    setProductQuery('');
    if (checks.required_product?.verdict === 'corrected') {
      patchCheck('required_product', { corrected: p?.name ?? '' });
    }
  };

  const productField = () =>
    product ? (
      <Choice
        label={product.name}
        selected
        onPress={() => pickProduct(null)}
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
              onPress={() => pickProduct({ id: p.id, name: p.name })}
              style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
            />
          ))}
          {productQuery.trim() && hits.length === 0 ? (
            <T s="caption">Nothing in the catalogue matches that.</T>
          ) : null}
        </View>
      </>
    );

  /* What is still missing, read off the SAME conditions the gate refuses on —
     so somebody working down this list cannot reach the bottom and still be
     refused, which is the failure that makes people stop trusting a checklist
     entirely. */
  const outstanding = PROSPECT_CONDITIONS.filter((c) => {
    switch (c.id) {
      case 'customer_type': return !customerType.trim();
      /* Read off the EFFECTIVE value rather than the box, or a row somebody
         has confirmed — where there is no box at all — would read as still
         unanswered and the list would ask for what is already on the record. */
      case 'monthly_litres': return !litresNow;
      case 'potential_value': return !potentialNow;
      case 'competitor': return !competitorNow;
      case 'required_product': return !product;
      case 'contact_person': return !contactNow;
      case 'next_action': return !(lead.nextAction && lead.nextActionDate && lead.nextActionOwnerId);
      case 'prospect_reason': return !lead.prospectReasonCode;
      default: return false;
    }
  });

  return (
    <AppFrame
      title="Prospect details"
      activeTab={null}
      onBack={goBack}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={goBack} />

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
        {originals.monthly_litres ? (
          <VerifyFieldRow
            field="monthly_litres"
            label={CHECKED_LABELS.monthly_litres}
            reported={originals.monthly_litres + ' litres a month'}
            answer={checks.monthly_litres ?? BLANK_VERIFY}
            onChange={(patch) => patchCheck('monthly_litres', patch)}
            placeholder="200"
            keyboardType="number-pad"
          />
        ) : (
          <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
        )}
        <T s="caption" style={{ marginTop: 6 }}>What they actually get through, of everything — not just ours.</T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What they could be worth a month</SectionLabel>
        {originals.potential ? (
          <VerifyFieldRow
            field="potential"
            label={CHECKED_LABELS.potential}
            reported={'₹' + originals.potential + ' a month'}
            answer={checks.potential ?? BLANK_VERIFY}
            onChange={(patch) => patchCheck('potential', patch)}
            placeholder="40000"
            keyboardType="number-pad"
          />
        ) : (
          <Input value={potential} onChangeText={setPotential} placeholder="40000" keyboardType="number-pad" />
        )}
        <T s="caption" style={{ marginTop: 6 }}>In rupees, roughly.</T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Whose product are they on now</SectionLabel>
        {originals.competitor ? (
          <VerifyFieldRow
            field="competitor"
            label={CHECKED_LABELS.competitor}
            reported={originals.competitor}
            answer={checks.competitor ?? BLANK_VERIFY}
            onChange={(patch) => patchCheck('competitor', patch)}
            placeholder="Asian, Berger, a local brand"
          />
        ) : (
          <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian, Berger, a local brand" />
        )}
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Which of ours do they need</SectionLabel>
        {originals.required_product ? (
          <VerifyFieldRow
            field="required_product"
            label={CHECKED_LABELS.required_product}
            reported={originals.required_product}
            answer={checks.required_product ?? BLANK_VERIFY}
            /* A SKU is picked, not typed, so the row hands the catalogue
               search back to this screen rather than owning one. Choosing
               "Correct" empties the pick — a corrected product with the old
               one still selected is the overwrite this pattern exists to
               stop, arriving through the one field that has no text box — and
               the two verdicts that leave the value alone put it back. */
            onChange={(patch) => {
              patchCheck('required_product', patch);
              if (patch.verdict === 'corrected') {
                setProduct(null);
                setProductQuery('');
              } else if (patch.verdict) {
                setProduct(originalProduct);
                setProductQuery('');
              }
            }}
            renderCorrected={() => (
              <View>
                <T s="caption" style={{ marginBottom: 6 }}>Which of ours they actually need</T>
                {productField()}
              </View>
            )}
          />
        ) : (
          productField()
        )}
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Who we ask for when we ring</SectionLabel>
        {originals.contact_person ? (
          <VerifyFieldRow
            field="contact_person"
            label={CHECKED_LABELS.contact_person}
            reported={originals.contact_person}
            answer={checks.contact_person ?? BLANK_VERIFY}
            onChange={(patch) => patchCheck('contact_person', patch)}
            placeholder="Suresh, on the counter"
          />
        ) : (
          <Input value={contact} onChangeText={setContact} placeholder="Suresh, on the counter" />
        )}
      </View>

      {/* Not one of the eight — the specification says "if known", and a gate
          that refused on an optional field would be one nobody could pass. It
          IS one of the twelve at qualification, so it is asked here where the
          salesman is already standing in front of the man. */}
      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Who actually signs off a purchase</SectionLabel>
        {originals.decision_maker ? (
          <VerifyFieldRow
            field="decision_maker"
            label={CHECKED_LABELS.decision_maker}
            reported={originals.decision_maker}
            answer={checks.decision_maker ?? BLANK_VERIFY}
            onChange={(patch) => patchCheck('decision_maker', patch)}
            placeholder="The proprietor, his son"
          />
        ) : (
          <Input value={decisionMaker} onChangeText={setDecisionMaker} placeholder="Optional — the proprietor, his son" />
        )}
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

      {/*
        SAID PLAINLY, because he has just typed a sentence for somebody to
        read. The corrected ANSWER goes up with everything else; the pair and
        the reason behind it have nowhere on the wire to land yet, and a
        salesman who believes his manager is reading that sentence this evening
        has been misled by a screen rather than by anybody. Drawn only where
        there is a correction to be honest about.
      */}
      {Object.values(checks).some((a) => a.verdict === 'corrected') ? (
        <T s="caption" style={{ marginTop: 14 }}>
          The office gets the corrected answer. Why it changed is kept on this phone until their side
          can hold it.
        </T>
      ) : null}

      <PrimaryButton
        label="Save the details"
        onPress={() => save()}
        disabled={Boolean(refusal)}
        whyDisabled={refusal ?? undefined}
        style={{ marginTop: 16 }}
      />
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
