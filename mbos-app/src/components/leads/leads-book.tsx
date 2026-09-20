import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../../theme/tokens';
import { createLead, leadThresholds, listLeads, visitCapThresholds, type Lead } from '../../data/leads';
import { leadSources } from '../../data/config';
import { takePhoto } from '../../native/capture';
import { CUSTOMER_TYPES, LEAD_FILTERS, OTHER_SOURCE, leadAlert, leadSourceLabel, visitCapLabel, visitCapState, type DuplicateMatch, type LeadFilter, type LeadSource, type LeadThresholds, type VisitCapThresholds } from '../../engines/leads';
import { offeredSalesTypes, salesTypeLabel, type LeadSalesType } from '../../engines/funnel';
import { dmy, inrFromPaise, isoDate, plural, pretty } from '../../lib/format';
import { useStore } from '../../state/store';

/**
 * Leads — shops that are not on the book yet.
 *
 * The list is ordered by what was promised: a follow-up date the salesman gave
 * somebody comes first, and a lead nobody promised anything sits under them
 * rather than off the bottom of the screen. Archived is a filter and never a
 * delete — a shop that said no in March is exactly who somebody wants to find
 * in September.
 *
 * The one thing the form does differently to every other form here is that it
 * checks the number against the customers as well as the leads, and when it
 * finds one it SHOWS the record. A refusal with nothing to open is how the
 * same shop gets typed in twice with a digit changed.
 */

const STAGE_TONE: Record<string, BadgeTone> = {
  New: 'info',
  Contacted: 'teal',
  Qualified: 'amber',
  Negotiation: 'amber',
  Converted: 'success',
  Lost: 'danger',
};

/**
 * The lead book, drawn the same wherever it is opened.
 *
 * It was a screen and is now a component, because the same list has two doors:
 * the Customers tab, where a salesman chooses between the shop he sells to and
 * the shop he is still working on, and the More screen's own Leads row, which
 * is the door that already existed and is in people's hands. Two copies of a
 * list this dense is two lists that disagree about one lead within a release,
 * and the half that drifts is always the half somebody is reading.
 *
 * It owns its OWN ScrollView rather than sitting inside the frame's, so both
 * doors pass `scroll={false}`: a frame that scrolls around a component that
 * scrolls is the one way to get two scroll positions and neither of them
 * working.
 */
export function LeadsBook() {
  const notify = useStore((s) => s.notify);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);

  const [filter, setFilter] = React.useState<LeadFilter>('All');
  const [rows, setRows] = React.useState<Lead[]>([]);
  /* Null until the thresholds arrive from configuration. A default written in
     here would be a business rule living in a screen, and the sentence it
     produced would be wrong on any handset whose office had changed it. */
  const [cfg, setCfg] = React.useState<LeadThresholds | null>(null);
  /* Null until configuration arrives. A default typed here would be a business
     rule living in a screen, and it would disagree with the server the day the
     office changed it — which is the one disagreement this cap cannot afford,
     since the server is what refuses the visit. */
  const [capCfg, setCapCfg] = React.useState<VisitCapThresholds | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));

  /* the form */
  const [formOpen, setFormOpen] = React.useState(false);
  /* See `save`. Not state: a second tap arrives before a re-render would. */
  const saving = React.useRef(false);
  const [name, setName] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [city, setCity] = React.useState('');
  /**
   * THE CODE, NOT THE WORD, and the list is the office's.
   *
   * This held one of five labels typed into `engines/leads.ts`, which the wire
   * then translated down to four codes — three of which `leads.sources`, the
   * one authoritative list, has never contained. So every lead raised here was
   * filed under a channel nobody can count. What is stored now is the code, and
   * the words beside it are whatever the office last published.
   *
   * Null until the list has arrived and until he has answered. Defaulting to
   * the first chip is the app quietly answering a question about attribution on
   * a salesman's behalf, and "Salesman Prospecting" would then be the largest
   * bar on the chart by construction.
   */
  const [sources, setSources] = React.useState<LeadSource[] | null>(null);
  const [source, setSource] = React.useState<string | null>(null);
  /* §— what "Other" has to say. Only ever read when the source is `other`, and
     deliberately NOT cleared when the answer moves off it: the web form does
     the same, because it is a record of what somebody believed on the day. */
  const [sourceDetail, setSourceDetail] = React.useState('');
  /**
   * §2 — asked before anything else is typed, and null until it is answered.
   *
   * It picks the ladder, so it decides which questions the rest of the funnel
   * asks: a distributor answers thirty and a shop answers twelve. Defaulting
   * it to "Direct customer" would be the app quietly choosing, and every lead
   * anybody raised in a hurry would be on the wrong ladder with nothing on the
   * screen saying so.
   */
  const [salesType, setSalesType] = React.useState<LeadSalesType | null>(null);
  const [potential, setPotential] = React.useState('');
  const [followUp, setFollowUp] = React.useState<string | null>(null);
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [dup, setDup] = React.useState<DuplicateMatch | null>(null);
  /* §A and §C. All optional and all below a divider — a salesman outside a
     closed shop with a name and a number must still be able to save, and a
     fourteen-field form is how you get fourteen empty fields. */
  const [address, setAddress] = React.useState('');
  const [custType, setCustType] = React.useState<string | null>(null);
  const [requirement, setRequirement] = React.useState('');
  const [litres, setLitres] = React.useState('');
  const [decisionMaker, setDecisionMaker] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [shopPhotoId, setShopPhotoId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listLeads(filter), leadThresholds(), visitCapThresholds(), leadSources()]).then(
      ([r, t, c, srcs]) => {
        if (!live) return;
        setRows(r);
        setCfg(t);
        setCapCfg(c);
        setSources(srcs);
      },
    );
    return () => {
      live = false;
    };
  }, [filter]);

  useFocusEffect(load);

  /*
   * WHAT HE TYPED SURVIVES A DISMISSAL, and it did not.
   *
   * `BottomSheet` closes on a scrim tap and on Android's back gesture, and the
   * only way back in is this button — which used to clear all fourteen fields
   * on the way IN. So one stray tap above the longest form in the app, filled
   * one-handed in the street, cost the whole shop the moment he pressed "+ Add
   * lead" again, with nothing asked and nothing said.
   *
   * Nothing is cleared now until something has been done with it: a save that
   * worked, or Cancel, which is somebody deliberately saying to throw it away.
   * Re-opening shows him exactly what he had.
   */
  const clearForm = React.useCallback(() => {
    setName('');
    setCompany('');
    setMobile('');
    setCity('');
    setSource(null);
    setSourceDetail('');
    setSalesType(null);
    setPotential('');
    setFollowUp(null);
    setAddress('');
    setCustType(null);
    setRequirement('');
    setLitres('');
    setDecisionMaker('');
    setCompetitor('');
    setShopPhotoId(null);
    setErr(null);
    setDup(null);
  }, []);

  const openForm = React.useCallback(() => setFormOpen(true), []);

  /* The + sheet on every screen offers "Add lead", which lands here with the
     form already asked for — the salesman is standing outside the shop. */
  React.useEffect(() => {
    if (sheet === 'leadForm') {
      set({ sheet: null });
      openForm();
    }
  }, [sheet, set, openForm]);

  const shootShop = async () => {
    /* `parentId: 'pending'` because the lead does not exist yet — the salesman
       shoots the shop while he is standing in front of it and types the rest
       afterwards. `handleLead` binds it the moment the row is written. */
    const shot = await takePhoto({ parentType: 'lead', parentId: 'pending', kind: 'shop_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    setShopPhotoId(shot.mediaId);
  };

  const save = async () => {
    /* One lead per press. `createLead` awaits a duplicate check, a GPS fix and
       a write, and a second tap inside that window is the ordinary way a shop
       ends up on the book twice — the duplicate check cannot catch it, because
       neither row is written yet when the other starts. A ref rather than
       state: state is a render away and the second tap is not. */
    if (saving.current) return;

    /* The ladder is asked FIRST and refused first, in that order, so the
       message somebody reads names the question at the top of the form rather
       than the one they have just finished typing. */
    if (!salesType) return setErr('Which kind of sale is this? It decides what the rest of the funnel asks.');
    if (!name.trim()) return setErr('Say who this is — a name or the shop.');
    if (mobile.replace(/\D/g, '').length < 10) return setErr('A ten-digit mobile, so somebody can ring them.');
    if (!source) return setErr('Say how you found them. It is the one question only you can answer.');
    /* Refused on the phone as well as in the office, because being told after
       the fact loses the sentence he had in mind while he was standing there. */
    if (source === OTHER_SOURCE && !sourceDetail.trim()) {
      return setErr('Say where this one actually came from — "Other" with nothing behind it is a source nobody can count later.');
    }

    saving.current = true;
    try {
      const rupees = Number(potential.replace(/[^\d]/g, ''));
      const result = await createLead({
        name,
        company,
        mobile,
        city,
        source,
        /*
         * THE SENTENCE RIDES IN THE NOTE, AND THAT IS AN INTERIM SAID OUT LOUD.
         *
         * `customers.lead_source_detail` is on the server and `handleLead`
         * writes it; `leads.sourceDetail` is on this phone and the pull fills
         * it. What is missing is the one step between them — `createLead` has
         * no argument to carry it UP, and adding one is another file. Dropped,
         * the answer he was just refused for not giving would go nowhere,
         * which is the worst of the three options; put in the note it reaches
         * `leadNotes` on the record, where a person reads it, and nothing is
         * lost in the meantime.
         *
         * The moment that argument lands this becomes
         * `sourceDetail: sourceDetail.trim()` and the prefix goes with it.
         */
        note: source === OTHER_SOURCE && sourceDetail.trim()
          ? 'Source details: ' + sourceDetail.trim()
          : undefined,
        /* Rupees on the screen, paise in the store — the only place the two meet. */
        estimatedPotentialPaise: rupees > 0 ? rupees * 100 : null,
        nextFollowUpDate: followUp,
        salesType,
        address,
        customerType: custType,
        requirement,
        monthlyVolumeLitres: Number(litres.replace(/[^\d]/g, '')) || null,
        decisionMaker,
        competitorName: competitor,
        shopPhotoId,
        today,
      });

      if (!result.ok) {
        setErr(result.message);
        setDup(result.duplicate ?? null);
        return;
      }

      setFormOpen(false);
      /* One of the two places anything is thrown away — this one and Cancel. The
         next "+ Add lead" is a different shop; this one is on the list behind
         the sheet. */
      clearForm();
      load();
      notify('Lead added · ' + (company.trim() || name.trim()));
    } finally {
      saving.current = false;
    }
  };

  const openDuplicate = () => {
    if (!dup) return;
    setFormOpen(false);
    if (dup.kind === 'customer') {
      set({ custId: dup.id, pTab: 0 });
      router.push('/customer');
    } else {
      router.push(`/lead?id=${dup.id}&from=leads`);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
        style={{ marginHorizontal: -16, paddingHorizontal: 16 }}>
        {LEAD_FILTERS.map((f) => (
          <Choice key={f} label={f} selected={filter === f} onPress={() => setFilter(f)} style={{ paddingHorizontal: 16 }} />
        ))}
      </ScrollView>

      <DashedButton label="+ Add lead" tone="primary" onPress={openForm} style={{ marginTop: 12 }} />

      {rows.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            {filter === 'All' ? 'No leads yet' : 'Nothing at ' + filter}
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            {filter === 'All'
              ? 'A shop you walk past and a name somebody gives you both start here.'
              : 'Every lead is still on All — nothing has been deleted.'}
          </T>
        </Card>
      ) : (
        <T s="caption" style={{ marginTop: 12 }}>{plural(rows.length, 'lead')}</T>
      )}

      <View style={{ gap: 12, marginTop: 8 }}>
        {rows.map((x) => {
          const alert = cfg ? leadAlert(x, today, cfg) : null;
          const overdue = !!x.nextFollowUpDate && x.nextFollowUpDate < today && x.stage !== 'Converted' && x.stage !== 'Lost';
          return (
            <Pressable
              key={x.id}
              onPress={() => router.push(`/lead?id=${x.id}&from=leads`)}
              accessibilityRole="button">
              <Card style={overdue ? { borderLeftWidth: 3, borderLeftColor: C.danger } : undefined}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                      {x.company?.trim() || x.name}
                    </T>
                    <T s="caption" style={{ marginTop: 2 }}>
                      {/* The ladder is named on the row, because which kind of
                          sale this is changes what the next call is about —
                          and it is the one fact about a lead that cannot be
                          guessed from its name. */}
                      {[x.company?.trim() ? x.name : null, x.salesType ? salesTypeLabel(x.salesType as LeadSalesType) : null, x.city, leadSourceLabel(x.source, sources ?? [])]
                        .filter(Boolean)
                        .join(' · ')}
                    </T>
                  </View>
                  <Badge tone={STAGE_TONE[x.stage] ?? 'neutral'}>{x.stage}</Badge>
                </View>

                <T style={[{ fontSize: 15, marginTop: 10, color: x.estimatedPotentialPaise ? C.ink : C.muted }, weight(500)]}>
                  {x.estimatedPotentialPaise
                    ? inrFromPaise(x.estimatedPotentialPaise) + ' a month, he reckons'
                    : 'Worth not estimated yet'}
                </T>

                <T style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: overdue ? C.danger : C.muted }}>
                  {x.nextFollowUpDate ? 'Next ' + pretty(x.nextFollowUpDate) : 'No follow-up set'}
                </T>

                {alert ? (
                  <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 4, color: C.warnInk }, weight(500)]}>{alert}</T>
                ) : null}

                {/* "Visit 2 / 3" — §B. Drawn only where it means something: a
                    qualified prospect visited a fourth time is a negotiation,
                    not a stall, and carries no counter at all. */}
                {capCfg && visitCapLabel(x.stage, x.visitCount, capCfg) ? (
                  <T
                    style={[
                      {
                        fontSize: 14,
                        lineHeight: 20,
                        marginTop: 4,
                        color:
                          visitCapState(x.stage, x.visitCount, capCfg) === 'decide'
                            ? C.warnInk
                            : C.muted,
                      },
                      weight(500),
                    ]}>
                    {visitCapLabel(x.stage, x.visitCount, capCfg)}
                    {visitCapState(x.stage, x.visitCount, capCfg) === 'decide'
                      ? ' · a decision is due'
                      : ''}
                  </T>
                ) : null}

                {/* Why it is not moving. On a held lead this is the whole point
                    of the status — without it "On hold" reads as "forgotten". */}
                {x.holdReason ? (
                  <T s="caption" style={{ marginTop: 4 }} numberOfLines={2}>
                    {'Waiting: ' + x.holdReason}
                  </T>
                ) : null}

                {x.archived ? <T s="caption" style={{ marginTop: 4 }}>Archived — still here, just out of the way</T> : null}
              </Card>
            </Pressable>
          );
        })}
      </View>

      {/* ------------------------------------------------------------ form */}
      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>New lead</T>
        <T s="caption" style={{ marginTop: 2 }}>
          The number is checked against your book before this saves.
        </T>

        {/* --------------------------------------------------- §2 the ladder
            First on the form, because it decides what the rest of the funnel
            asks — and changed afterwards only deliberately, from the record,
            with a reason. Three chips rather than a dropdown: the sentence
            under each is what somebody standing outside a shop reads to
            choose, and a dropdown hides two of the three. */}
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of sale is this?</SectionLabel>
          <View style={{ gap: 8 }}>
            {/* OFFERED, not all three. Mahek does not appoint distributors
                through MahekOne, so that ladder is withdrawn for new leads —
                the note on `SALES_TYPES` in the funnel engine has the whole of
                it. The leads already on it keep everything they have. */}
            {offeredSalesTypes().map((t) => (
              <Choice
                key={t.code}
                label={t.label}
                sub={t.hint}
                selected={salesType === t.code}
                onPress={() => { setSalesType(t.code); setErr(null); }}
                style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who you spoke to</SectionLabel>
          <Input value={name} onChangeText={(v) => { setName(v); setErr(null); }} placeholder="Suresh Patil" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Shop name</SectionLabel>
          <Input value={company} onChangeText={setCompany} placeholder="Patil Hardware & Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Mobile</SectionLabel>
          <Input
            value={mobile}
            onChangeText={(v) => { setMobile(v); setErr(null); setDup(null); }}
            placeholder="98220 11001"
            keyboardType="phone-pad"
          />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>City</SectionLabel>
          <Input value={city} onChangeText={setCity} placeholder="Nagpur" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How you found them</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(sources ?? []).map((s) => (
              <Choice
                key={s.code}
                label={s.label}
                selected={source === s.code}
                onPress={() => setSource(s.code)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        {/*
          * ONLY UNDER "OTHER", and required there — the same shape the web
          * intake form draws, for the same reason. "Other" is the cheapest
          * answer on any list: left free it becomes the biggest bar on the
          * chart with nothing behind it, and the sentences are what tell Mahek
          * which eleventh channel is worth adding to the list. A box that is
          * dead on nine answers in ten is furniture, and people stop reading
          * furniture, so it is drawn rather than disabled.
          */}
        {source === OTHER_SOURCE ? (
          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Source details</SectionLabel>
            <Input
              value={sourceDetail}
              onChangeText={(v) => { setSourceDetail(v); setErr(null); }}
              placeholder="A builder on the site next door sent him"
            />
          </View>
        ) : null}

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What they might buy a month</SectionLabel>
          <Input
            value={potential}
            onChangeText={setPotential}
            placeholder="40000"
            keyboardType="number-pad"
          />
          <T s="caption" style={{ marginTop: 6 }}>In rupees, roughly. Leave it empty if you would only be guessing.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Go back to them on</SectionLabel>
          <Pressable
            onPress={() => setCal(true)}
            accessibilityRole="button"
            style={{
              minHeight: 52,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
              justifyContent: 'center',
              paddingHorizontal: 14,
            }}>
            <T style={{ fontSize: 16, color: followUp ? C.ink : C.faint }}>
              {followUp ? dmy(followUp) : 'Pick a day'}
            </T>
          </Pressable>
        </View>

        <Divider style={{ marginTop: 20, marginBottom: 4 }} />
        <SectionLabel style={{ marginTop: 12 }}>What you learned in the shop</SectionLabel>
        <T s="caption" style={{ marginTop: 4 }}>
          All optional. Save what you have — you can add the rest from the lead later.
        </T>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Where the shop is</SectionLabel>
          <Input value={address} onChangeText={setAddress} placeholder="Shop 4, Itwari Market, near the bus stand" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of business</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CUSTOMER_TYPES.map((t) => (
              <Choice
                key={t.value}
                label={t.label}
                selected={custType === t.value}
                onPress={() => setCustType(custType === t.value ? null : t.value)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What they want</SectionLabel>
          <Input value={requirement} onChangeText={setRequirement} placeholder="Thinner for a spray booth" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How much a month</SectionLabel>
          <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
          {/* LITRES, not cans. There is no pack size agreed yet — a shop says
              "about two hundred litres" long before anybody knows what they
              will buy it as. */}
          <T s="caption" style={{ marginTop: 6 }}>In litres, as they say it.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who decides</SectionLabel>
          <Input value={decisionMaker} onChangeText={setDecisionMaker} placeholder="The proprietor, Mr Patil" />
          <T s="caption" style={{ marginTop: 6 }}>If that is not the person you spoke to.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who they buy from now</SectionLabel>
          <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>The shop front</SectionLabel>
          <DashedButton
            label={shopPhotoId ? 'Photo taken \u2713 \u00b7 retake' : 'Take a photo'}
            onPress={shootShop}
          />
        </View>

        {err ? (
          <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
            <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
            {dup ? (
              <SecondaryButton
                label={dup.kind === 'customer' ? 'Open ' + dup.name : 'Open the lead'}
                onPress={openDuplicate}
                style={{ marginTop: 10 }}
              />
            ) : null}
          </View>
        ) : null}

        {/* Closing the sheet any other way — the scrim, the back gesture —
            keeps what he typed and brings it straight back. Cancel is the one
            gesture that means throw it away, so it is the one that clears. */}
        <T s="caption" style={{ marginTop: 18 }}>
          Close this by mistake and what you have typed will still be here. Cancel throws it away.
        </T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <SecondaryButton
            label="Cancel"
            onPress={() => {
              setFormOpen(false);
              clearForm();
            }}
            style={{ flex: 1, borderRadius: radius.xl }}
          />
          <PrimaryButton label="Add lead" onPress={save} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
      </BottomSheet>

      {/* ------------------------------------------------------- follow-up */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={followUp ?? ''}
          disabledReason={(iso) => (iso < today ? 'That day has gone.' : null)}
          onPick={(iso) => {
            setFollowUp(iso);
            setCal(false);
          }}
        />
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>
    </ScrollView>
  );
}
