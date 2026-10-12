# مجلد Supabase

هنا كل حاجة تخص الباك إند، عشان لو حصلت مشكلة أو اتنقل المشروع نعرف نبني كل حاجة من الصفر.

```
supabase/
├── functions/manage-users/   الـ Edge Function (إضافة مستخدم، تغيير username، إعادة تعيين كلمة مرور)
├── export/                   سكريبت يطلّع كل التعريفات الحقيقية من قاعدة البيانات الشغالة
├── checks/                   فحوصات أمان للقراءة فقط (RLS، الصلاحيات، حسابات يتيمة)
├── migrations/               ملفات الـ migrations (هتتملي من الخطوة 1 تحت)
└── SCHEMA-REFERENCE.md       مرجع الجداول والدوال، مولّد من ملف الأنواع (مرجع بس)
```

## مهم تعرفه
دوال الـ SQL (`create_sale_invoice`، `void_order`، `apply_stocktake`...) وسياسات RLS والـ triggers **متعملة مباشرة في لوحة Supabase ومش متسجلة في الريبو لحد دلوقتي**. فمجلد `migrations/` فاضي عمدًا: مش هنألّف تعريفات من عندنا، لازم تتسحب من القاعدة الفعلية.

## الخطوة 1: سحب الـ migrations الحقيقية (مرة واحدة، 5 دقايق)
1. Supabase Dashboard ← **SQL Editor** ← New query.
2. الصق محتوى `export/export-definitions.sql` واضغط **Run**.
3. اضغط **Download CSV** (أو انسخ عمود `definition`).
4. ابعتلي الناتج وأنا أحوّله لملفات مرتبة جوه `migrations/` (أو احفظه كـ `migrations/00000000000000_baseline.sql`).

بديل بالـ CLI لو مثبّته:
```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db dump --schema public -f supabase/migrations/00000000000000_baseline.sql
```

## الخطوة 2: فحص الأمان
شغّل استعلامات `checks/01-security-audit.sql` واحد واحد، وقارن بالنتيجة المتوقعة المكتوبة فوق كل استعلام. أي نتيجة مختلفة ابعتهالي.

## الخطوة 3: جرّب إعادة البناء
- أنشئ مشروع Supabase تجريبي، شغّل `migrations/` عليه بالترتيب، واتأكد إن التطبيق شغال عليه.
- جرّب نسخة احتياطية كاملة (من الإعدادات) واستعدها على المشروع التجريبي، وقارن عدد الصفوف.

## نشر الـ Edge Function
Dashboard ← Edge Functions ← `manage-users` ← الصق `functions/manage-users/index.ts` ← Deploy.
(أو: `supabase functions deploy manage-users`). لازم تعيد النشر كل ما الملف يتغيّر. خلّي **Verify JWT** مفعّل.
متغيرات `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` بتتوفر للدالة تلقائيًا من Supabase.

## قواعد لأي migration جديد
- اسم الملف: `YYYYMMDDHHMMSS_وصف_قصير.sql` (بالإنجليزي).
- أي تعديل على الجداول أو الدوال يتسجل هنا **في نفس اللحظة** اللي بيتنفذ فيها على القاعدة.
- بعد تعديل الجداول: ولّد الأنواع من جديد
  `npx supabase gen types typescript --project-id "<PROJECT_ID>" --schema public > src/lib/database.types.ts`
  (في PowerShell الأمر `>` بيكتب الملف UTF-16، فاستخدم CMD أو `| Out-File -Encoding utf8`).
- ممنوع أي سر (مفاتيح، باسوردات) يتسجل في الـ migrations.
