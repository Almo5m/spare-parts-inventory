# مجلد Supabase

كل حاجة تخص الباك إند هنا، عشان لو حصلت مشكلة أو اتنقل المشروع نعرف نبني كل حاجة من الصفر.

```
supabase/
├── migrations/               تعريفات القاعدة الفعلية + التحسينات (انظر الجدول تحت)
├── functions/manage-users/   الـ Edge Function (إضافة مستخدم، تغيير username، إعادة تعيين كلمة مرور)
├── tests/db_scenarios.py     اختبارات حقيقية لقاعدة البيانات (Postgres مؤقت، مفيش اتصال ببياناتك)
├── export/                   سكريبت يطلّع التعريفات من قاعدة شغّالة (اتعمل بيه الـ baseline)
├── checks/                   فحوصات أمان للقراءة فقط
└── SCHEMA-REFERENCE.md       مرجع الجداول والدوال، مولّد من ملف الأنواع (مرجع بس)
```

## الـ migrations

| الملف | إيه هو | يتنفذ على القاعدة الشغّالة؟ |
|---|---|---|
| `00000000000000_baseline.sql` | **تسجيل** للوضع الفعلي وقت التصدير (30 جدول، 32 سياسة، 20 دالة). اتولّد من تصدير قاعدتك الحقيقية. | **لا!** القاعدة فيها كل ده بالفعل. ده بس لو بنيت مشروع جديد من الصفر. |
| `20261012000001_harden_privileges.sql` | سحب صلاحيات anon (كان يقدر ينفّذ 3 دوال من غير تسجيل دخول) وTRUNCATE | نعم |
| `20261012000002_add_missing_indexes.sql` | فهارس ناقصة (تواريخ وأعمدة الربط) | نعم |
| `20261012000003_add_non_negative_checks.sql` | قيود "مفيش أرقام سالبة" (NOT VALID) | نعم، **بعد** فحص الصفوف القديمة (الاستعلامات جواه) |
| `20261012000004_validate_rpc_inputs.sql` | تحقق من المدخلات داخل `create_sale_invoice` و`create_order` و`apply_stocktake` + قيد على معامل التحويل | نعم |

### إزاي تطبّقها على القاعدة الشغّالة
1. اعمل **نسخة احتياطية** الأول (من الإعدادات في الموقع، وتأكد من أرقام الصفوف).
2. Supabase Dashboard ← SQL Editor، وشغّل الملفات **واحد واحد** بالترتيب: `…0001` ثم `…0002` ثم `…0004` ثم `…0003`.
3. بعد كل واحد جرّب الموقع: بيع، طلبية، مرتجع، جرد، إلغاء.
4. لو رجعت صفر صفوف من استعلامات الفحص في `…0003`، شغّل أسطر `validate constraint` اللي في آخره.

### بعد التطبيق: فحص إن القاعدة بقت زي ما المفروض
شغّل `checks/01-security-audit.sql`. الاستعلام 5 (الدوال) لازم يبقى `anon_can_execute = false` للكل، والاستعلام 6 (صلاحيات anon على الجداول) لازم يرجّع صفر صفوف.

## الاختبارات
```bash
python -m pip install pgserver
python supabase/tests/db_scenarios.py     # أو: npm run test:db
```
بتبني قاعدة Postgres مؤقتة على جهازك، وتطبّق كل الـ migrations، وتجرّب: ثغرة anon، منطق FIFO والأرصدة والإلغاء، المرتجعات والدفعات، وكل المدخلات الغلط. لازم تطلع `كل الاختبارات نجحت`. شغّلها بعد أي migration جديد.
حدودها: الأدوار (anon/authenticated) و`auth.uid()` متقلَّدين بشكل مبسّط، فهي مش بديل لتجربة على مشروع Supabase تجريبي.

## نشر الـ Edge Function
Dashboard ← Edge Functions ← `manage-users` ← الصق `functions/manage-users/index.ts` ← Deploy. لازم تعيد النشر كل ما الملف يتغيّر. خلّي **Verify JWT** مفعّل.
متغيرات `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` بتتوفر للدالة تلقائيًا.

## قواعد لأي migration جديد
- اسم الملف: `YYYYMMDDHHMMSS_وصف_قصير.sql` (بالإنجليزي).
- أي تعديل على الجداول أو الدوال يتسجل هنا **في نفس اللحظة** اللي بيتنفذ فيها على القاعدة.
- شغّل `python supabase/tests/db_scenarios.py` قبل ما تنفّذه على القاعدة الحقيقية.
- بعد تعديل الجداول ولّد الأنواع من جديد: `npx supabase gen types typescript --project-id "<PROJECT_ID>" --schema public > src/lib/database.types.ts` (في PowerShell الأمر `>` بيكتب UTF-16، فاستخدم CMD أو `| Out-File -Encoding utf8`).
- ممنوع أي سر (مفاتيح، باسوردات) يتسجل في الـ migrations.