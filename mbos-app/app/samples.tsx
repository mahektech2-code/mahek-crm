import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, DashedButton, T } from '../src/components/ui/primitives';
import { color as C, weight, type BadgeTone } from '../src/theme/tokens';
import { listSamples, requestSample, type Sample } from '../src/data/requests';
import { getCustomer } from '../src/data/customers';
import { isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * Samples given out and never followed up are the quietest way a sales day
 * leaks money, so the age of each one is on the row and a late one says so in
 * words rather than in a colour alone.
 */

function toneFor(state: string): BadgeTone {
  return state === 'Converted' ? 'success' : state === 'Awaiting feedback' ? 'amber' : state === 'Requested' ? 'info' : 'teal';
}

/** A sample nobody chased is a sample that was given away. */
function isOverdue(x: Sample, today: string): boolean {
  return !!x.followUpDate && x.followUpDate < today && x.state !== 'Converted' && x.state !== 'Rejected';
}

export default function SamplesScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const custId = useStore((s) => s.custId);

  const [rows, setRows] = React.useState<Sample[]>([]);
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [today] = React.useState(() => isoDate(new Date()));
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = React.useCallback(() => {
    let live = true;
    void listSamples().then(async (r) => {
      if (!live) return;
      setRows(r);
      /* The row says whose shop it is, so the customer's name is fetched for
         the ids on screen rather than joined into every sample query. */
      const map: Record<string, string> = {};
      for (const id of Array.from(new Set(r.map((x) => x.customerId)))) {
        const c = await getCustomer(id);
        if (c) map[id] = c.name;
      }
      if (live) setNames(map);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  return (
    <AppFrame title="Samples" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <DashedButton
        label="+ Request a sample"
        tone="primary"
        onPress={async () => {
          const c = custId ? await getCustomer(custId) : null;
          if (!c) return notify('Open a customer first — a sample is requested for a shop');
          /* The trial follow-up is set for him, a week out, rather than asked
             for on a screen the customer is waiting through. */
          const followUp = isoDate(new Date(Date.now() + 7 * 86_400_000));
          await requestSample({
            customerId: c.id,
            productId: null,
            productName: 'To be confirmed',
            cans: 1,
            reason: 'Requested on the customer list',
            followUpDate: followUp,
          });
          load();
          notify('Sample request · product, quantity, then approval');
        }}
      />

      <View style={{ gap: 12, marginTop: 16 }}>
        {rows.map((x) => {
          const days = Math.max(0, Math.round((now - x.requestedAt) / 86_400_000));
          const name = names[x.customerId] ?? 'Unknown customer';
          return (
            <Pressable key={x.id} onPress={() => notify(name + ' · ' + (x.productName ?? ''))} accessibilityRole="button">
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{name}</T>
                    <T s="caption" style={{ marginTop: 2 }}>{x.productName ?? ''}</T>
                  </View>
                  <Badge tone={toneFor(x.state)}>{x.state}</Badge>
                </View>
                <T s="caption" style={{ marginTop: 10 }}>{plural(days, 'day') + ' ago'}</T>
                {isOverdue(x, today) ? (
                  <T style={[{ fontSize: 14, color: C.warnInk, marginTop: 4 }, weight(500)]}>
                    Feedback is late — worth a call
                  </T>
                ) : null}
              </Card>
            </Pressable>
          );
        })}
      </View>
    </AppFrame>
  );
}
