-- EDIT AND DELETE NOW COUNT ON EVERY ERP PAGE, AND NOBODY'S ACCESS MOVES.
-- Until Nov 2026 the Access / Edit / Delete ticks in Manage access were
-- enforced on the Purchase pages only; on every other ERP page Access alone
-- let somebody do everything the page offered (its own checks — a manager's
-- level, a power — aside, which still apply). From this release the server
-- refuses an Edit or Delete act without its tick on every page
-- (`action-ticks.ts`, `idTick`). So that the deploy takes nothing from
-- anybody, every grant already in the screen model gets Edit and Delete on
-- each non-Purchase ERP page it holds — exactly what it could do yesterday.
-- From then on an administrator narrows a person in Manage access and it
-- takes effect. Purchase's pages are left as they are (their ticks have been
-- enforced since the Purchase redesign), and so are tab rows (`erp.x.y`).
-- Runs once (the journal); a re-run would undo narrowing done since.
update app_screen_access s
   set can_edit = true, can_delete = true
  from app_access a
 where a.user_id = s.user_id
   and a.app = s.app
   and a.position is not null
   and s.app::text = 'erp'
   and s.screen like 'erp.%'
   and s.screen not like 'erp.%.%'
   and s.screen not in ('erp.requisitions', 'erp.purchaseOrders', 'erp.inward', 'erp.testing', 'erp.register', 'erp.quoteManager', 'erp.barcode', 'erp.dashboard', 'erp.settings')
   and (s.can_edit = false or s.can_delete = false);
