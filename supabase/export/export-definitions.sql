-- تصدير كل تعريفات قاعدة البيانات (الهيكل، القيود، الفهارس، RLS، السياسات، الدوال، الـ triggers)
-- كنص SQL قابل لإعادة التنفيذ — ده اللي بيتحوّل بعدين لملفات migrations.
--
-- طريقة الاستعمال (من غير أي تثبيت):
--  1) Supabase Dashboard ← SQL Editor ← New query
--  2) الصق الاستعلام كله واضغط Run
--  3) من نتيجة الاستعلام اضغط "Download CSV" (أو انسخ عمود definition كله)
--  4) احفظ الناتج في supabase/migrations/ كملف اسمه: 00000000000000_baseline.sql
--     (ابعتهولي لو عايزني أحوّله لملفات مرتبة)
--
-- بيقرا بس ومبيغيّرش أي حاجة. مفيش أي بيانات (صفوف) في الناتج، تعريفات بس.

select kind, name, definition
from (
  -- 0) الأنواع المعرّفة (enums)
  select 0 as ord, 'enum' as kind, t.typname::text as name,
         format('create type public.%I as enum (%s);', t.typname,
           (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
              from pg_enum e where e.enumtypid = t.oid)) as definition
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype = 'e'

  union all
  -- 1) الجداول بأعمدتها وقيمها الافتراضية
  select 1, 'table', c.relname::text,
         format(E'create table public.%I (\n  %s\n);', c.relname,
           (select string_agg(
                     format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                            case when a.attnotnull then ' not null' else '' end,
                            case when d.adbin is not null then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end),
                     E',\n  ' order by a.attnum)
              from pg_attribute a
              left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped))
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'

  union all
  -- 2) القيود: المفاتيح الأساسية، الأجنبية، unique، check
  select 2, 'constraint', con.conrelid::regclass::text || '.' || con.conname,
         format('alter table %s add constraint %I %s;', con.conrelid::regclass, con.conname, pg_get_constraintdef(con.oid))
  from pg_constraint con
  where con.connamespace = 'public'::regnamespace

  union all
  -- 3) الفهارس (اللي ليها قيد مرتبط هتظهر مرتين — عادي، احذف المكرر عند التحويل)
  select 3, 'index', i.indexname::text, i.indexdef || ';'
  from pg_indexes i
  where i.schemaname = 'public'

  union all
  -- 4) حالة RLS لكل جدول
  select 4, 'rls', c.relname::text,
         format('alter table public.%I %s row level security;', c.relname,
                case when c.relrowsecurity then 'enable' else 'disable' end)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'

  union all
  -- 5) سياسات RLS
  select 5, 'policy', p.tablename || '.' || p.policyname,
         format('create policy %I on public.%I as %s for %s to %s using (%s)%s;',
                p.policyname, p.tablename, p.permissive, p.cmd,
                array_to_string(p.roles, ', '),
                coalesce(p.qual, 'true'),
                case when p.with_check is not null then ' with check (' || p.with_check || ')' else '' end)
  from pg_policies p
  where p.schemaname = 'public'

  union all
  -- 6) الدوال (الجسم الكامل لكل دالة RPC)
  select 6, 'function', pr.proname::text, pg_get_functiondef(pr.oid) || ';'
  from pg_proc pr
  join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.prokind in ('f', 'p')

  union all
  -- 7) الـ triggers
  select 7, 'trigger', t.tgname::text, pg_get_triggerdef(t.oid) || ';'
  from pg_trigger t
  where not t.tgisinternal
    and t.tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)

  union all
  -- 8) صلاحيات تنفيذ الدوال (مين يقدر ينادي كل دالة)
  select 8, 'function_privileges', pr.proname::text,
         format('-- %s: anon=%s, authenticated=%s, security_definer=%s',
                pr.proname,
                has_function_privilege('anon', pr.oid, 'execute'),
                has_function_privilege('authenticated', pr.oid, 'execute'),
                pr.prosecdef)
  from pg_proc pr
  join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public' and pr.prokind = 'f'
) x
order by ord, name;
