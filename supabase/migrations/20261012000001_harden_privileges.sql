-- ============================================================================
-- تحصين الصلاحيات (Defense in depth)
--
-- المشكلة اللي اتكشفت من تصدير القاعدة الفعلية:
--  1) كل الدوال كانت قابلة للتنفيذ من أي حد معاه الـ anon key (المفتاح العام اللي ظاهر في
--     المتصفح) حتى من غير تسجيل دخول. أغلب دوال العمليات فيها فحص is_active_user() جواها،
--     لكن 3 دوال مفيهاش فحص خالص: notify و log_activity (بتكتب في الإشعارات وسجل العمليات)
--     و cleanup_old_notifications (بتمسح إشعارات). يعني أي حد من الإنترنت كان يقدر يملّي
--     سجل العمليات بكلام مزيف أو يمسح الإشعارات.
--  2) دور anon عنده كل الصلاحيات على كل الجداول (ده الافتراضي في Supabase). RLS بيمنعه
--     دلوقتي، لكن لو جدول اتعمل ونسيت تفعّل عليه RLS يبقى مفتوح للعالم.
--  3) أدوار anon و authenticated عندهم TRUNCATE (مش بيتأثر بـ RLS) و REFERENCES و TRIGGER.
--
-- التطبيق بيتعامل مع القاعدة بدور authenticated بس (بعد تسجيل الدخول)، والـ Edge Function
-- بتستخدم service_role. فمفيش حاجة في التطبيق بتعتمد على anon.
-- جرّبه على مشروع تجريبي الأول لو تحب.
-- ============================================================================

-- 1) الدوال: مسموح لـ authenticated بس. دوال الـ triggers مش لازم أي حد ينفّذها يدويًا.
--    (صلاحية EXECUTE بتتفحص وقت إنشاء الـ trigger مش وقت تشغيله، فسحبها آمن.)
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname like 'trg\_%' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- 2) الجداول والـ sequences: مفيش وصول مباشر لـ anon
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 3) صلاحيات خطيرة وملهاش استخدام في التطبيق (TRUNCATE مش بيتأثر بـ RLS)
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- 4) أي جدول/دالة جديدة تتعمل بعد كده متتفتحش لـ anon تلقائيًا
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon, public;
