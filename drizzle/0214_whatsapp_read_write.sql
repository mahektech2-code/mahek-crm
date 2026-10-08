-- WHATSAPP HAS TWO LEVELS NOW, and nobody's access moves on the day it lands.
--
-- `crm.whatsapp` is the Read level and `crm.whatsapp-reply` the Write level
-- beside it (see `writeOf` in lib/modules.ts). A whole-app grant stores no
-- rows and so already means both. A NARROWED CRM grant stores its rows, and
-- one that held `crm.whatsapp` held replying too — without this it would wake
-- up read-only, which is a narrowing nobody chose.
--
-- `accounts.whatsapp` is new: a narrowed Accounts grant does not reach it, the
-- same as any screen added after somebody was narrowed.
insert into app_module_access (id, user_id, app, module, granted_by_id)
select
  gen_random_uuid()::text,
  a.user_id,
  a.app,
  'crm.whatsapp-reply',
  a.granted_by_id
from app_module_access a
where a.module = 'crm.whatsapp'
on conflict (user_id, module) do nothing;
