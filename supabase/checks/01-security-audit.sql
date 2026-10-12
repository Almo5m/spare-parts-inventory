-- فحوصات أمان قاعدة البيانات (للقراءة فقط). شغّل كل استعلام لوحده في SQL Editor.
-- القاعدة: الاستعلامات 1 و2 و3 و5 المفروض ترجّع "نتيجة فاضية" أو قيم false/النتيجة المتوقعة المكتوبة تحتها.

-- 1) أي جدول RLS فيه مش مفعّل؟  (المتوقع: صفر صفوف)
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by 1;

-- 2) جداول RLS مفعّل فيها لكن من غير أي سياسة (بتمنع الكل، غالبًا مش مقصودة)  (المتوقع: صفر صفوف)
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
order by 1;

-- 3) سياسات مفتوحة لـ anon أو public (أي حد من غير تسجيل دخول)  (المتوقع: صفر صفوف)
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and (roles && array['anon', 'public']::name[])
order by 1, 2;

-- 4) كل السياسات الموجودة (للمراجعة بالعين: لازم كلها مربوطة بـ is_active_user())
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by 1, 2;

-- 5) دوال تقدر anon تنفّذها (من غير تسجيل دخول)  (المتوقع: anon_can_execute = false للكل)
select pr.proname as function_name,
       pr.prosecdef as security_definer,
       has_function_privilege('anon', pr.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', pr.oid, 'execute') as authenticated_can_execute
from pg_proc pr
join pg_namespace n on n.oid = pr.pronamespace
where n.nspname = 'public' and pr.prokind = 'f'
order by anon_can_execute desc, 1;

-- 6) صلاحيات الجداول المباشرة لـ anon (المتوقع: صفر صفوف، أو صلاحيات بلا أثر لأن RLS بيمنع)
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
group by 1
order by 1;

-- 7) حسابات دخول من غير صف في جدول users (المستخدم هيدخل لكن هيلاقي تطبيق فاضي)  (المتوقع: صفر صفوف)
select u.id, u.email, u.created_at
from auth.users u
left join public.users p on p.id = u.id
where p.id is null;

-- 8) صفوف في users من غير حساب دخول  (المتوقع: صفر صفوف)
select p.id, p.username, p.full_name
from public.users p
left join auth.users u on u.id = p.id
where u.id is null;

-- ملحوظة: إيقاف "Allow new users to sign up" مش ممكن يتفحص بـ SQL —
-- ده من Dashboard ← Authentication ← Sign In / Providers (أو Settings حسب النسخة).
