-- Lead Management: eight new module keys, and the grants that must not narrow.
--
-- `sales.leads` and `sales.samples` guarded nine screens between them. Three of
-- those screens move to new keys in this release — the verification queue to
-- `sales.lead-qualify`, the nurture schedule and the no-next-action list to
-- `sales.lead-actions` — and the other seven are new.
--
-- AN APP GRANT WITH NO MODULE ROWS ALREADY MEANS EVERY MODULE, so almost
-- nobody needs this: somebody holding the whole Sales Dashboard reaches all ten
-- the moment they exist, which is what every previous module addition has done.
-- What needs it is a grant somebody has deliberately NARROWED to `sales.leads`.
-- Left alone, that person opens the book tomorrow and the verification queue
-- they used today is gone, with nothing on any screen saying why — a silent
-- revocation caused by a rename, which is exactly the failure `modules.ts`
-- warns about in its own header.
--
-- So a narrowed lead grant is widened to the whole workspace. That is the
-- generous direction and it is the correct one here: these ten are one job,
-- they were one grant yesterday, and nobody has yet had the chance to say they
-- wanted less. Somebody who genuinely wants a narrower lead grant unticks it on
-- the Access screen afterwards, which is where that decision belongs.
--
-- `sales.samples` is deliberately NOT a trigger. It is a real, separate grant
-- today — the sample desk without the book is a coherent thing to hold — and
-- widening it would hand somebody the whole funnel on the strength of a group
-- label changing.
--
-- THE APP IS READ OFF THE ROW, NEVER WRITTEN AS A LITERAL, and that is not a
-- style choice. `sales` is not an original member of `app_id`: it is added by
-- `ALTER TYPE ... ADD VALUE` in 0061. A value added to an enum may not be USED
-- in the transaction that adds it, and drizzle-kit applies every pending
-- migration in ONE transaction — so on a database being built from nothing,
-- 0061 and this file are the same transaction, and `'sales'::app_id` here is an
-- unsafe use of a new enum value. It fails on a fresh build and passes on every
-- database that already has the app, which is the worst of both: green on a
-- developer's machine, red in CI, and red on the next clean deploy.
--
-- `a.app` is a value read from an existing row rather than a literal resolved
-- against the type, so it needs no such resolution. The `sales.leads` filter is
-- text and already implies the app: no other app has that module key.

insert into app_module_access (id, user_id, app, module)
select
  -- `app_module_access.id` is TEXT, not uuid — the cast is not decoration.
  gen_random_uuid()::text,
  a.user_id,
  a.app,
  m.module
from app_module_access a
cross join (
  values
    ('sales.lead-funnel'),
    ('sales.lead-intake'),
    ('sales.lead-qualify'),
    ('sales.lead-commercial'),
    ('sales.lead-appointments'),
    ('sales.lead-actions'),
    ('sales.lead-handovers'),
    ('sales.lead-oversight')
) as m(module)
where a.module = 'sales.leads'
  and not exists (
    select 1
    from app_module_access existing
    where existing.user_id = a.user_id
      and existing.app = a.app
      and existing.module = m.module
  );
