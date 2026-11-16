import React from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { BoxInput, CardHead, LeadCard, LeadGlyph } from '../src/components/leads/v3-parts';
import { PrimaryButton } from '../src/components/ui/primitives';
import { skuText, useSkus } from '../src/components/ui/sku';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import {
  BLANK_VERIFY,
  correctionRefusal,
  fieldChecksFrom,
  forgetFieldChecks,
  takeFieldChecks,
  VerifyFieldRow,
  type VerifyAnswer,
} from '../src/components/leads/verify-field-row';
import { color as C, weight } from '../src/theme/tokens';
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
import { cleanDecimal, cleanWhole, parseDecimal, parseWhole, typedFromDecimal } from '../src/lib/decimal-input';
import { cleanAmount, paiseFromTyped, typedFromPaise } from '../src/lib/money-input';
import { CUSTOMER_TYPES, gstinRefusal, normaliseGstin } from '../src/engines/leads';
import { useStore } from '../src/state/store';
import { Swap } from '../src/components/ui/motion';
import { skuLines } from '../src/lib/sku-lines';

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
  { field: 'potential', label: 'How much they can buy' },
  { field: 'competitor', label: 'Which brand they use now' },
  { field: 'required_product', label: 'Which of our products they need' },
  { field: 'contact_person', label: 'Who to ask for' },
  { field: 'decision_maker', label: 'Who decides to buy' },
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
/* `CUSTOMER_TYPES` is the engine's list — the same one the New lead form
   draws, so a code never reads as two different words on two screens. */

/**
 * The schema's own ceiling on `fieldChecks`, restated here because this is the
 * one screen that can exceed it. Nine findings is what the form can answer and
 * forty is what the wire will take, so the difference is the backlog — and a
 * payload refused for length would take the seven prospect answers beside it
 * down too, which is the one thing a drain must not cost.
 */
const FIELD_CHECK_LIMIT = 40;

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
  const productSku = useSkus([product?.id]);
  const [productQuery, setProductQuery] = React.useState('');
  const [hits, setHits] = React.useState<{ id: string; name: string; formulation: string | null; sku: string | null }[]>([]);
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
        setLitres(typedFromDecimal(litresHere, 2));
        /* To the paisa, not rounded to the rupee — a box that rounds on the
           way in rewrites the figure on a save nobody meant as an edit. */
        const potentialHere =
          v.lead.estimatedPotentialPaise != null ? typedFromPaise(v.lead.estimatedPotentialPaise) : '';
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
          monthly_litres: typedFromDecimal(litresHere, 2),
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
      if (live) setHits(r.map((p) => ({ id: p.id, name: p.name, formulation: p.formulation, sku: p.sku })));
    });
    return () => {
      live = false;
    };
  }, [productQuery]);

  if (!view) {
    return (
      <AppFrame title="Prospect details" tone="canvas" activeTab={null} onBack={goBack} contentStyle={{ padding: 14 }}>
        <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 26, alignItems: 'center' }}>
          <Icon name="person" size={28} color={C.faint} strokeWidth={2} />
          <Text style={[{ fontSize: 16, lineHeight: 21, color: C.ink, textAlign: 'center', marginTop: 8 }, weight(800)]}>
            This lead is not on this phone
          </Text>
          <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, textAlign: 'center', marginTop: 4 }, weight(400)]}>
            Go back and open it from the list
          </Text>
        </View>
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
    if (refusal) return notify(refusal, 'warn');
    /* Checked before anything is saved, so the number he is reading off the
       certificate is still in front of him when the phone says it is wrong. */
    const gstWrong = gstinRefusal(gstin);
    if (gstWrong) return notify(gstWrong, 'warn');
    saving.current = true;
    try {
      /*
       * THE ROWS ARE BUILT BEFORE THE SAVE AND TRAVEL WITH IT, which is the
       * change: they used to be written to `kv` after it, because the wire had
       * nowhere to put them. `payloadExtras` has somewhere now — see
       * `saveProspectFields` — so they go up with the answers they are about,
       * in one queued write, rather than as a second thing that could be
       * delivered without its record or its record without it.
       *
       * The clock is read HERE and not during a render, which is what
       * `fieldChecksFrom` takes `at` for.
       */
      const rows = fieldChecksFrom(checks, originals, me, Date.now());

      /* AND THE ONES THAT HAD NOWHERE TO GO come with them. Everything
         answered before `leadSchema` learned the field is still in `kv`; each
         save carries as many of the oldest as the schema's forty will hold. */
      const backlog = await takeFieldChecks(lead.id, Math.max(0, FIELD_CHECK_LIMIT - rows.length));

      const r = await saveProspectFields(lead.id, {
        customerType: customerType.trim() || null,
        monthlyLitres: parseDecimal(litresNow),
        /* Rupees on the screen, paise in the store — the only place the two
           meet, exactly as the new-lead form does it. */
        estimatedPotentialPaise: potentialNow ? paiseFromTyped(potentialNow) || null : null,
        competitor: competitorNow || null,
        requiredProductId: product?.id ?? null,
        requiredProductName: product?.name ?? null,
        contactPerson: contactNow || null,
        decisionMaker: decisionMakerNow || null,
        creditDaysWanted: parseWhole(creditDays),
        application: application.trim() || null,
        gstin: normaliseGstin(gstin) || null,
        prospectReasonCode: reasonCode ?? lead.prospectReasonCode ?? null,
      }, [...backlog, ...rows]);
      if (!r.ok) return notify(r.message, 'warn');

      /*
       * AND THE BACKLOG IS FORGOTTEN, now that it has been sent.
       *
       * Only what was actually carried, and only after the save has queued —
       * the outbox is durable, so a queued row reaches the office on whatever
       * signal comes next. The rows written on THIS screen are not remembered
       * at all any more: they went up with the answers they are about, and a
       * second local copy of a row already on the wire is a copy that can only
       * ever be sent twice.
       *
       * It runs AFTER the save and can never fail one, like a photograph and
       * for the same reason — a failure here costs at worst one shop's answers
       * being sent again, and never the answer itself. No save on this app is
       * refused for want of signal, and none is refused for want of a local
       * write either.
       */
      await forgetFieldChecks(lead.id, backlog.length);

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

  /* Picked and searching are one field in two states, so the one replaces the
     other in place rather than the form jumping by the height of a list. */
  const productField = () => (
    <Swap id={product ? 'picked' : 'search'}>{productFieldState()}</Swap>
  );
  const productFieldState = () =>
    product ? (
      <ProductHit
        label={product.name}
        sub={skuText(productSku.get(product.id)) ?? undefined}
        picked
        a11y={'Picked: ' + product.name + '. Tap to unpick'}
        onPress={() => pickProduct(null)}
      />
    ) : (
      <>
        <TextInput
          value={productQuery}
          onChangeText={setProductQuery}
          placeholder="Thinner, Nano, M5x4"
          placeholderTextColor={C.faint}
          accessibilityLabel="Which of our products they need"
          style={[{ minHeight: 44, borderRadius: 22, backgroundColor: C.canvas, paddingHorizontal: 14, fontSize: 15, color: C.ink }, weight(400)]}
        />
        <View style={{ gap: 6, marginTop: 8 }}>
          {hits.map((p) => (
            <ProductHit
              key={p.id}
              /* The SKU's own name leads and the formulation sits under
                 it — the rule the order form runs, in `src/lib/sku-lines.ts`. */
              label={skuLines({ name: p.name, formulation: p.formulation }).lead}
              sub={[skuText(p.sku), skuLines({ name: p.name, formulation: p.formulation }).detail].filter(Boolean).join(' · ') || undefined}
              onPress={() => pickProduct({ id: p.id, name: p.name })}
            />
          ))}
          {productQuery.trim() && hits.length === 0 ? (
            <Text style={[{ fontSize: 12, color: C.faint }, weight(400)]}>No product matches that.</Text>
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

  /* Each answer sits in one card, as V3 draws it: a plain answer is a row
     with its label, and an answer the record already holds is the verify
     box — confirm, correct, or could not check — under the same label. */
  const verifyOr = (
    field: keyof typeof CHECKED_LABELS,
    reported: string,
    plain: React.ReactNode,
    extra?: Partial<React.ComponentProps<typeof VerifyFieldRow>>,
  ) =>
    originals[field] ? (
      <VerifyFieldRow
        field={field}
        label={CHECKED_LABELS[field]}
        reported={reported}
        answer={checks[field] ?? BLANK_VERIFY}
        onChange={(patch) => patchCheck(field, patch)}
        {...extra}
      />
    ) : (
      plain
    );

  return (
    <AppFrame
      title="Prospect details"
      tone="canvas"
      hero={
        <Text style={[{ fontSize: 13, lineHeight: 18, color: HERO.lavender.muted, marginTop: 4 }, weight(400)]}>
          {(lead.company?.trim() || lead.name) + ' · ' + stageLabel(input.stage) + ' · fill everything on this page'}
        </Text>
      }
      activeTab={null}
      onBack={goBack}
      contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      {/* What the gate is still waiting on, in the gate's own words — at the
          top now, so the page opens on what it owes. The last answer swaps
          the list for the all-answered line in place. No buzz: nothing is
          saved yet, and Save confirms with its own toast. Every condition is
          read off the same values the save sends, so somebody working down
          this list cannot reach the bottom and still be refused. */}
      <Swap id={outstanding.length ? 'open' : 'done'}>
        <View style={{ backgroundColor: C.navy, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14 }}>
          {outstanding.length ? (
            <>
              <View
                accessible
                accessibilityLabel={'Answer these to make it a Prospect: ' + outstanding.map((c) => c.says).join('. ')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[{ fontSize: 22, color: C.lime }, weight(800)]}>{String(outstanding.length)}</Text>
                <Text style={[{ fontSize: 13, color: '#FFFFFF' }, weight(700)]}>to answer before Prospect</Text>
              </View>
              <View style={{ marginTop: 6, gap: 2 }}>
                {outstanding.map((c) => (
                  <Text key={c.id} style={[{ fontSize: 13, lineHeight: 19, color: C.onNavyMuted }, weight(400)]}>{'• ' + c.says}</Text>
                ))}
              </View>
            </>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="tick" size={18} color={C.lime} strokeWidth={2.4} />
              <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>
                All answered. Save, then move it up on the lead page.
              </Text>
            </View>
          )}
        </View>
      </Swap>

      <LeadCard style={{ borderRadius: 22 }}>
        <CardHead>Kind of business</CardHead>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {CUSTOMER_TYPES.map((t) => {
            const on = customerType === t.value;
            return (
              <Pressable
                key={t.value}
                onPress={() => setCustomerType(t.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t.label + (t.hint ? '. ' + t.hint : '')}
                style={({ pressed }) => ({
                  flexGrow: 1,
                  flexBasis: '45%',
                  minHeight: 56,
                  borderRadius: 16,
                  borderWidth: on ? 2 : 1,
                  borderColor: on ? C.primary : C.border,
                  backgroundColor: on ? C.primaryTint : pressed ? C.wash : C.surface,
                  paddingHorizontal: on ? 11 : 12,
                  paddingVertical: on ? 9 : 10,
                })}>
                <Text style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{t.label}</Text>
                {t.hint ? <Text style={[{ fontSize: 11, lineHeight: 15, color: C.muted }, weight(400)]}>{t.hint}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </LeadCard>

      <LeadCard style={{ borderRadius: 22 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <LeadGlyph name="drop" size={18} color={C.muted} strokeWidth={2} />
          <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 13, color: C.ink }, weight(700)]}>Litres a month</Text>
          <Text style={[{ fontSize: 11, color: C.faint }, weight(400)]}>total, not only ours</Text>
        </View>
        <View style={{ marginTop: 10 }}>
          {verifyOr(
            'monthly_litres',
            originals.monthly_litres + ' L',
            <BoxInput
              value={litres}
              onChangeText={(v) => setLitres(cleanDecimal(v, 2))}
              placeholder="200"
              keyboardType="decimal-pad"
              suffix="L"
              accessibilityLabel="Litres a month. How much they use in total. Not only ours."
            />,
            { placeholder: '200', keyboardType: 'decimal-pad' },
          )}
        </View>
      </LeadCard>

      <LeadCard padded={false} style={{ borderRadius: 22 }}>
        <QBlock icon="money" label="Can buy a month, ₹ about">
          {verifyOr(
            'potential',
            '₹' + originals.potential + ' a month',
            <BareInput value={potential} onChangeText={(v) => setPotential(cleanAmount(v))} placeholder="40,000" keyboardType="decimal-pad" a11y="How much they can buy a month, in rupees, about" />,
            { placeholder: '40000', keyboardType: 'decimal-pad' },
          )}
        </QBlock>
        <QBlock icon="shop" label="Brand they use now">
          {verifyOr(
            'competitor',
            originals.competitor,
            <BareInput value={competitor} onChangeText={setCompetitor} placeholder="Asian, Berger, a local brand" a11y="Which brand they use now" />,
            { placeholder: 'Asian, Berger, a local brand' },
          )}
        </QBlock>
        <QBlock icon="sample" label="Which of our products they need">
          {originals.required_product ? (
            <VerifyFieldRow
              field="required_product"
              label={CHECKED_LABELS.required_product}
              reported={originals.required_product}
              answer={checks.required_product ?? BLANK_VERIFY}
              /* The product is a PICK, not a box, so a correction hands the
                 search back to this screen rather than owning one. Choosing
                 "Correct" empties the pick — a corrected product with the old
                 one still selected is the overwrite this pattern exists to
                 stop, arriving through the one field that has no text box —
                 and the two verdicts that leave the value alone put it back. */
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
              renderCorrected={() => <View>{productField()}</View>}
            />
          ) : (
            productField()
          )}
        </QBlock>
        <QBlock icon="person" label="Who to ask for when we call">
          {verifyOr(
            'contact_person',
            originals.contact_person,
            <BareInput value={contact} onChangeText={setContact} placeholder="Suresh, on the counter" a11y="Who to ask for when we call" />,
            { placeholder: 'Suresh, on the counter' },
          )}
        </QBlock>
        {/* Not one of the eight — the specification says "if known", and a
            gate that refused on an optional field would be one nobody could
            pass. It IS one of the twelve at qualification, so it is asked
            here where the salesman is already standing in front of the man. */}
        <QBlock icon="people2" label="Who decides to buy · optional">
          {verifyOr(
            'decision_maker',
            originals.decision_maker,
            <BareInput value={decisionMaker} onChangeText={setDecisionMaker} placeholder="The owner, his son" a11y="Who decides to buy. Optional." />,
            { placeholder: 'The owner, his son' },
          )}
        </QBlock>
        <QBlock icon="cal" label="Credit they want, days · optional">
          <BareInput
            value={creditDays}
            onChangeText={(v) => setCreditDays(cleanWhole(v))}
            placeholder="30"
            keyboardType="number-pad"
            a11y="Credit they want, in days. Optional. Whole days only."
          />
          {creditDays.includes('.') ? (
            <Text style={{ fontSize: 12, lineHeight: 16, color: C.danger, marginTop: 4 }}>Whole days only.</Text>
          ) : null}
        </QBlock>
        <QBlock icon="note" label="What they will use it on · optional">
          <BareInput value={application} onChangeText={setApplication} placeholder="Furniture polish, spray booth" a11y="What they will use it on. Optional." />
        </QBlock>
        <QBlock tag="GST" label="GST · needed before a sample" last>
          <BareInput value={gstin} onChangeText={setGstin} placeholder="27AAPFU0939F1ZV" autoCapitalize="characters" a11y="GST number. Optional now. Needed before a sample." />
        </QBlock>
      </LeadCard>

      {/* -------------------------------------------------- §24 and §5 */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <SideTile
          glyph="arrow"
          ink={C.primaryDeep}
          title="Next"
          body={lead.nextAction ? lead.nextAction + (lead.nextActionDate ? ' · ' + pretty(lead.nextActionDate) : '') : 'Set next action'}
          a11y={lead.nextAction ? 'Next: ' + lead.nextAction + (lead.nextActionDate ? ', ' + pretty(lead.nextActionDate) : '') : 'Set next action'}
          onPress={() => setNextOpen(true)}
        />
        <SideTile
          icon="warn"
          ink={lead.prospectReasonCode ? C.primaryDeep : C.warnInk}
          title="Why follow up"
          body={lead.prospectReasonCode ? labelOf(config.prospectReasons, lead.prospectReasonCode) : 'Not said yet'}
          bodyInk={lead.prospectReasonCode ? C.ink : C.warnInk}
          a11y={lead.prospectReasonCode ? 'Why: ' + labelOf(config.prospectReasons, lead.prospectReasonCode) : 'Say why to follow up'}
          onPress={() => setReasonOpen(true)}
        />
      </View>

      {/*
        SAID PLAINLY, because he has just typed a sentence for somebody to
        read. The corrected ANSWER goes up with everything else; the pair and
        the reason behind it have nowhere on the wire to land yet. Drawn only
        where there is a correction to be honest about.
      */}
      {Object.values(checks).some((a) => a.verdict === 'corrected') ? (
        <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center' }, weight(400)]}>
          Corrected answers go to the office · reasons stay on this phone for now
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pressable
          onPress={() => router.replace(`/lead?id=${lead.id}&from=leads`)}
          accessibilityRole="button"
          accessibilityLabel="Back to the lead"
          style={({ pressed }) => ({ width: 140, height: 60, borderRadius: 30, backgroundColor: pressed ? C.wash : C.surface, alignItems: 'center', justifyContent: 'center' })}>
          <Text style={[{ fontSize: 14, color: C.ink }, weight(700)]}>Back to lead</Text>
        </Pressable>
        <PrimaryButton
          label="Save details"
          tone="navy"
          onPress={() => save()}
          disabled={Boolean(refusal)}
          whyDisabled={refusal ?? undefined}
          style={{ flex: 1, height: 60, minHeight: 60, borderRadius: 30 }}
        />
      </View>

      <ReasonSheet
        key={reasonOpen ? 'why-open' : 'why-shut'}
        open={reasonOpen}
        onClose={() => setReasonOpen(false)}
        title="Why follow up this shop?"
        body="Choose one reason. A shop becomes a Prospect only with a real reason."
        options={config.prospectReasons}
        confirmLabel="Save reason"
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
            if (!r.ok) return notify(r.message, 'warn');
            load();
            notify('Next: ' + n.action);
          });
        }}
      />
    </AppFrame>
  );
}

/* ------------------------------------------------------- V3 form pieces */

/** One question of the answers card: icon, 11-point label, the answer under it. */
function QBlock({ icon, tag, label, last = false, children }: { icon?: IconName; tag?: string; label: string; last?: boolean; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, minHeight: 56, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.hairline }}>
      <View style={{ width: 20, paddingTop: 2, alignItems: 'center' }}>
        {tag ? (
          <Text style={[{ fontSize: 11, color: C.muted }, weight(800)]}>{tag}</Text>
        ) : icon ? (
          <Icon name={icon} size={20} color={C.muted} strokeWidth={2} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint }, weight(400)]}>{label}</Text>
        {children}
      </View>
    </View>
  );
}

/** The borderless box inside a question row. */
function BareInput({ a11y, ...input }: { a11y: string } & TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={C.faint}
      accessibilityLabel={a11y}
      {...input}
      style={[{ fontSize: 16, lineHeight: 21, color: C.ink, paddingVertical: 2, paddingHorizontal: 0, minHeight: 28 }, weight(400)]}
    />
  );
}

/** A product search hit, or the one picked. */
function ProductHit({ label, sub, picked = false, a11y, onPress }: { label: string; sub?: string; picked?: boolean; a11y?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label + (sub ? '. ' + sub : '')}
      style={({ pressed }) => ({
        borderRadius: 14,
        borderWidth: picked ? 2 : 0,
        borderColor: C.primary,
        backgroundColor: picked ? C.primaryTint : pressed ? C.hairline : C.canvas,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      })}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{label}</Text>
        {sub ? <Text style={[{ fontSize: 11, lineHeight: 15, color: C.muted }, weight(400)]}>{sub}</Text> : null}
      </View>
      {picked ? <Icon name="close" size={14} color={C.primaryDeep} strokeWidth={2.4} /> : null}
    </Pressable>
  );
}

/** One of the two tiles at the foot: the next action, the reason. */
function SideTile({
  icon,
  glyph,
  ink,
  title,
  body,
  bodyInk = C.ink,
  a11y,
  onPress,
}: {
  icon?: IconName;
  glyph?: 'arrow';
  ink: string;
  title: string;
  body: string;
  bodyInk?: string;
  a11y: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => ({ flex: 1, minHeight: 76, borderRadius: 20, backgroundColor: pressed ? C.wash : C.surface, paddingHorizontal: 12, paddingVertical: 10 })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {glyph ? <LeadGlyph name={glyph} size={15} color={ink} /> : icon ? <Icon name={icon} size={15} color={ink} strokeWidth={2.2} /> : null}
        <Text style={[{ fontSize: 12, color: ink }, weight(700)]}>{title}</Text>
      </View>
      <Text numberOfLines={2} style={[{ fontSize: 13, lineHeight: 18, color: bodyInk, marginTop: 4 }, weight(400)]}>
        {body}
      </Text>
    </Pressable>
  );
}
