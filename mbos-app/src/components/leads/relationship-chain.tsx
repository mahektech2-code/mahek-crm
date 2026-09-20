import React from 'react';
import { ScrollView, View } from 'react-native';
import { Card, T } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { color as C, radius, weight } from '../../theme/tokens';

/**
 * §5.9 — THE CHAIN, on a shop we deliver to and do not bill.
 *
 * End customer → the distributor's own salesman → the distributor → Mahek's
 * sales manager, left to right, because that is the order the goods and the
 * money actually travel in and a salesman standing in the shop is at the left
 * end of it. Four boxes rather than a paragraph: the question this answers is
 * "who do I ring about this shop, and who do they answer to", and a list of
 * names with labels answers it at a glance where a sentence has to be read.
 *
 * DRAWN ONLY FOR A THIRD-PARTY LEAD, and that is the whole of when it is true.
 * A direct customer is an account we invoice — there is no chain, we are the
 * other end of it — and drawing a two-box version for one would invent a
 * relationship nobody recorded. A distributor lead is the chain's own middle
 * and has no shop under it yet.
 *
 * THE DISTRIBUTOR'S SALESMAN IS A NAME AND NOT AN ACCOUNT. Rahul works for the
 * distributor, has no MahekOne login and never will, so his box holds whatever
 * somebody wrote down and says so where nobody has. Giving him a `users` row to
 * make this box tidier would put him in every person picker in the product.
 *
 * COMMERCIAL AUTHORITY STAYS WITH THE DISTRIBUTOR, said in words under the
 * chain, because it is the one thing a salesman can get wrong while reading
 * this correctly: the shop is his to visit and the price is not his to quote.
 * A chain drawn with Mahek at one end and the shop at the other invites exactly
 * that mistake, so the sentence sits where the drawing is.
 *
 * A MISSING LINK IS NAMED RATHER THAN LEFT OUT. A chain with a hole in it is
 * what somebody has to fix; a chain drawn with three boxes looks complete and
 * is the state nobody debugs. `distributorCount` above two is said as well —
 * a shop on a territory boundary is served by two, one column can only ever
 * name one, and a card claiming a single distributor on such a shop is wrong
 * about exactly the account that most needs it right.
 */
export function RelationshipChain({
  shopName,
  distributorSalesmanName,
  distributorName,
  distributorCount,
  salesManagerName,
}: {
  shopName: string;
  distributorSalesmanName: string | null;
  distributorName: string | null;
  /** How many accounts invoice this shop, as the office counts them. */
  distributorCount: number | null;
  salesManagerName: string | null;
}) {
  const links: { role: string; name: string | null; missing: string }[] = [
    { role: 'The shop', name: shopName, missing: '' },
    {
      role: 'Their salesman',
      name: distributorSalesmanName,
      missing: 'Nobody has written down who calls on them',
    },
    { role: 'Billed by', name: distributorName, missing: 'No distributor named' },
    {
      role: 'Mahek',
      name: salesManagerName,
      missing: 'No sales manager on this lead yet',
    },
  ];

  return (
    <Card>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: 'stretch', gap: 8 }}>
        {links.map((l, i) => (
          <View key={l.role} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                minWidth: 132,
                maxWidth: 176,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderWidth: 1,
                borderColor: l.name ? C.border : C.warnInk,
                borderRadius: radius.lg,
                backgroundColor: l.name ? C.surface : C.wash,
              }}>
              <T s="caption">{l.role}</T>
              <T
                style={[
                  { fontSize: 14, lineHeight: 19, marginTop: 2, color: l.name ? C.ink : C.warnInk },
                  weight(l.name ? 500 : 400),
                ]}>
                {l.name ?? l.missing}
              </T>
            </View>
            {i < links.length - 1 ? <Icon name="forward" size={14} color={C.faint} /> : null}
          </View>
        ))}
      </ScrollView>

      <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 10 }}>
        We deliver to this shop and the distributor invoices it. Price, credit and any commercial promise stay
        theirs — yours is the visit and what you hear in it.
      </T>

      {(distributorCount ?? 0) > 1 ? (
        <T style={{ fontSize: 14, lineHeight: 20, color: C.warnInk, marginTop: 6 }}>
          {'The office has ' + distributorCount + ' distributors invoicing this shop. Only one of them is named here.'}
        </T>
      ) : null}
    </Card>
  );
}
