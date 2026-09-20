import { cx } from "@/components/ui/primitives";
import type { LeadDistributorLink } from "@/lib/services/lead-console-service";

/**
 * §5.9 — THE CHAIN, on a shop we deliver to and do not bill.
 *
 * End customer → the distributor's own salesman → the distributor → Mahek's
 * sales manager, left to right, because that is the order the goods and the
 * money actually travel in and the man standing in the shop is at the left end
 * of it. Boxes rather than a paragraph: the question this answers is "who do I
 * ring about this shop, and who do they answer to", and named boxes answer it
 * at a glance where a sentence has to be read twice.
 *
 * **THE FACTS WERE ALREADY ON THE PAGE AND ANSWERED NOTHING.** Two of them sat
 * as separate entries in the seats panel — a relationship owner in one cell and
 * "Billed by" four cells along — with nothing saying they are two links of one
 * chain, and the distributor's own salesman was not on the screen at all. A
 * grid of eight independent facts is a reference table; this is the same facts
 * in the order somebody uses them.
 *
 * **DRAWN ONLY FOR A THIRD-PARTY LEAD, which is the whole of when it is true.**
 * A direct customer is an account we invoice — there is no chain, we are the
 * far end of it — and a two-box version drawn for one would invent a
 * relationship nobody recorded. The caller decides; this component does not
 * guess from an empty distributor list, because an empty list on a marked shop
 * is a real and different state that this card has to be able to say out loud.
 *
 * **THE DISTRIBUTOR'S SALESMAN IS A NAME AND NOT AN ACCOUNT.** Rahul works for
 * the distributor, has no MahekOne login and never will. His box holds whatever
 * somebody wrote down and says so where nobody has; giving him a `users` row to
 * make the box tidier would put him in every person picker in the product.
 *
 * **A SHOP ON A TERRITORY BOUNDARY HAS TWO DISTRIBUTORS, so this draws a chain
 * PER ARRANGEMENT.** The handset's own version of this card names one and says
 * the count beside it, which is the honest answer on a phone; a console screen
 * has the room to draw both, and it must, because a card claiming a single
 * distributor is confidently wrong about exactly the account that most needs it
 * right. The shop and Mahek's end are common to every chain and are drawn once.
 *
 * **COMMERCIAL AUTHORITY STAYS WITH THE DISTRIBUTOR**, said in words under the
 * chain, because it is the one thing somebody can get wrong while reading this
 * correctly: the shop is ours to visit and the price is not ours to quote. A
 * chain drawn with Mahek at one end and the shop at the other invites exactly
 * that mistake, so the sentence sits where the drawing is.
 *
 * **A MISSING LINK IS NAMED RATHER THAN LEFT OUT.** A chain with a hole in it
 * is something somebody can go and fix; a chain quietly drawn one box shorter
 * looks complete and is the state nobody debugs.
 */
export function RelationshipChain({
  shopName,
  links,
  salesManagerName,
}: {
  shopName: string;
  /** Every arrangement recorded against this shop. Empty is a real answer. */
  links: LeadDistributorLink[];
  /** Mahek's end — the third seat, which drives nothing and says much. */
  salesManagerName: string | null;
}) {
  return (
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        How this shop is served
      </div>
      <p className="mb-3 max-w-[560px] text-[12px] text-pretty text-muted">
        We deliver here and somebody else invoices it. Left to right is the way the goods and the
        money travel.
      </p>

      {links.length === 0 ? (
        /* A marked shop with nobody billing it is not an empty card, it is the
           one row on this screen that somebody has to act on — `convertToThird
           Party` writes the mark and a distributor in one transaction, so a
           shop in this state was converted before distributors were recorded
           and nothing since has said who serves it. */
        <p className="rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
          This shop is marked as one somebody else bills, and no distributor is named against it.
          Until one is, there is nobody to ask about an order taken here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {links.map((l) => (
            <ol
              key={l.distributorId}
              className="m-0 flex list-none flex-wrap items-stretch gap-2 p-0"
            >
              <ChainLink
                role="The shop"
                name={shopName}
                sub="We visit and deliver here."
                first
              />
              <ChainLink
                role="Their salesman"
                name={l.salesmanName}
                missing="Nobody has written down who calls on them"
                sub="The distributor's own man. He has no MahekOne login and never will."
              />
              <ChainLink
                role="Billed by"
                name={l.distributorName}
                sub={
                  l.isPrimary && links.length > 1
                    ? "Who serves it usually."
                    : "Buys from us, invoices the shop."
                }
                strong
              />
              <ChainLink
                role="Mahek"
                name={salesManagerName}
                missing="No sales manager named on this account"
                sub="Our end of the arrangement."
              />
            </ol>
          ))}
        </div>
      )}

      {links.length > 1 ? (
        <p className="mt-2.5 text-[12px] text-muted">
          {links.length} distributors invoice this shop, which is ordinary on a territory boundary.
          Each is drawn as its own chain rather than as one chain with a count beside it, because
          the salesman who calls on the shop is a different man for each of them.
        </p>
      ) : null}

      <p className="mt-3 border-t border-divider pt-2.5 text-[12px] text-pretty text-body">
        <span className="font-medium text-ink">Commercial authority stays with the distributor.</span>{" "}
        The price, the credit and the terms are theirs to agree — ours is coverage and support, not
        the invoice. An order taken here is one they bill.
      </p>
    </section>
  );
}

/**
 * One box, with the arrow before it drawn by the box rather than between them.
 *
 * A separate arrow element between siblings is what breaks when the row wraps
 * on a narrow screen — the arrow ends a line and points at nothing. Hanging it
 * off the box that FOLLOWS means a wrapped chain drops the arrow onto the next
 * line with the box it belongs to.
 */
function ChainLink({
  role,
  name,
  missing,
  sub,
  first,
  strong,
}: {
  role: string;
  name: string | null;
  /** What to say where nobody has recorded this link. */
  missing?: string;
  sub: string;
  first?: boolean;
  strong?: boolean;
}) {
  const known = Boolean(name);
  return (
    <li className="flex items-stretch gap-2">
      {first ? null : (
        <span aria-hidden className="flex items-center text-[13px] text-muted">
          →
        </span>
      )}
      <span
        className={cx(
          "flex min-w-[150px] flex-1 flex-col justify-center rounded-[4px] border px-3 py-2",
          known ? "border-line bg-canvas" : "border-dashed border-line-strong bg-surface",
          strong && known ? "border-brand bg-brand-soft" : "",
        )}
      >
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {role}
        </span>
        <span
          className={cx("text-[13px]", known ? "font-medium text-ink" : "text-warn-ink italic")}
        >
          {name ?? missing}
        </span>
        <span className="mt-0.5 text-[11px] text-pretty text-muted">{sub}</span>
      </span>
    </li>
  );
}
