// Supabase Edge Function: manage-users
//
// بيستخدم Service Role Key (صلاحية أدمن كاملة) عشان يعمل عمليات لازم
// تتعمل من السيرفر ومينفعش تتعمل من المتصفح مباشرة (لأن كشف الـ
// Service Role Key في الواجهة معناه أي حد يقدر يتخطى كل صلاحيات
// الأمان في النظام):
//   - action: "create"           -> إنشاء حساب دخول جديد + صف في users
//   - action: "update_username"  -> تغيير username/email لمستخدم (نفسك أو غيرك)
//   - action: "reset_password"   -> إعادة تعيين كلمة مرور لمستخدم (نفسك أو غيرك)
//
// أي مستخدم مفعّل (is_active = true) في النظام يقدر يستخدمها — نفس
// فلسفة "كل المستخدمين المفعّلين ليهم نفس الصلاحيات" المطبّقة في باقي
// النظام. الفحص الوحيد اللي بيحصل: إن اللي طالب العملية عنده جلسة
// دخول صحيحة وحسابه مفعّل فعلًا.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// نفس القواعد الموجودة في src/lib/authRules.ts (الدالة بتشتغل على السيرفر فمش
// بتقدر تستورد منه) — لو غيّرت هناك غيّر هنا.
const MIN_PASSWORD_LENGTH = 10
const normalizeUsername = (raw: unknown) => String(raw ?? '').trim().toLowerCase()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'مطلوب تسجيل دخول' }, 401)

    // عميل بصلاحية المستخدم الحالي بس — بنتأكد بيه إنه فعلًا مسجّل
    // دخول وحسابه مفعّل، قبل ما نستخدم صلاحيات الأدمن في أي حاجة
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: callerData, error: callerError } = await supabaseUser.auth.getUser()
    if (callerError || !callerData.user) return json({ error: 'جلسة غير صالحة' }, 401)

    const { data: callerRow } = await supabaseUser
      .from('users')
      .select('is_active')
      .eq('id', callerData.user.id)
      .single()

    if (!callerRow?.is_active) return json({ error: 'حسابك غير مفعّل' }, 403)

    // عميل بصلاحية الأدمن الكاملة (Service Role) — دي اللي بتعمل
    // العمليات الحساسة فعليًا بعد ما اتأكدنا إن الطالب مستخدم شرعي
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body = await req.json()
    const action = body.action as string

    // ---------- إنشاء مستخدم جديد ----------
    if (action === 'create') {
      const username = normalizeUsername(body.username)
      const password = String(body.password ?? '')
      const full_name = String(body.full_name ?? '').trim()
      const phone = body.phone ? String(body.phone).trim() : null

      if (!username || !password || !full_name) {
        return json({ error: 'اسم المستخدم وكلمة المرور والاسم بالكامل مطلوبين' }, 400)
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return json({ error: `كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل` }, 400)
      }
      if (/\s/.test(username)) {
        return json({ error: 'اسم المستخدم لازم يكون من غير مسافات' }, 400)
      }

      const email = `${username}@warehouse.local`

      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

      if (createError || !created.user) {
        const msg = createError?.message.includes('already been registered')
          ? 'اسم المستخدم ده مستخدم بالفعل'
          : createError?.message ?? 'تعذر إنشاء الحساب'
        return json({ error: msg }, 400)
      }

      const { error: insertError } = await supabaseAdmin.from('users').insert({
        id: created.user.id,
        username,
        full_name,
        phone,
        role: body.role || 'sales',
        is_active: true,
      })

      if (insertError) {
        // نتراجع عن حساب الدخول لو فشل إدراج الصف، عشان مايفضلش حساب دخول
        // يتيم من غير صف بيانات مرتبط بيه
        await supabaseAdmin.auth.admin.deleteUser(created.user.id)
        return json({ error: insertError.message }, 400)
      }

      return json({ success: true, id: created.user.id })
    }

    // ---------- تغيير اسم المستخدم (username/email) ----------
    if (action === 'update_username') {
      const user_id = String(body.user_id ?? '')
      const new_username = normalizeUsername(body.new_username)

      if (!user_id || !new_username) return json({ error: 'بيانات ناقصة' }, 400)
      if (/\s/.test(new_username)) {
        return json({ error: 'اسم المستخدم لازم يكون من غير مسافات' }, 400)
      }

      const email = `${new_username}@warehouse.local`

      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user_id, { email })
      if (authError) {
        const msg = authError.message.includes('already been registered')
          ? 'اسم المستخدم ده مستخدم بالفعل'
          : authError.message
        return json({ error: msg }, 400)
      }

      const { error: rowError } = await supabaseAdmin
        .from('users')
        .update({ username: new_username })
        .eq('id', user_id)

      if (rowError) return json({ error: rowError.message }, 400)

      return json({ success: true })
    }

    // ---------- إعادة تعيين كلمة مرور ----------
    if (action === 'reset_password') {
      const user_id = String(body.user_id ?? '')
      const new_password = String(body.new_password ?? '')

      if (!user_id || new_password.length < MIN_PASSWORD_LENGTH) {
        return json({ error: `كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل` }, 400)
      }

      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        password: new_password,
      })
      if (authError) return json({ error: authError.message }, 400)

      return json({ success: true })
    }

    return json({ error: 'عملية غير معروفة' }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'خطأ غير متوقع' }, 500)
  }
})
