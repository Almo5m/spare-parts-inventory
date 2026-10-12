// Supabase بيرجّع 1000 صف كحد أقصى في الطلب الواحد (إعداد max-rows الافتراضي)،
// وبيقطع الباقي بصمت من غير أي خطأ. الدالة دي بتجيب الجدول على دفعات
// بنفس الحجم لحد ما الدفعة تيجي أقل من الحجم، فالنتيجة بتبقى كاملة.
//
// الاستعمال: اكتب الاستعلام عادي وخلّي آخر حاجة فيه .range(from, to)،
// ومعاه ترتيب ثابت (فيه عمود فريد) عشان الصفحات متتداخلش:
//   fetchAll((from, to) => supabase.from('products').select('*').order('id').range(from, to))
//
// ملحوظة: حجم الدفعة لازم يكون <= حد max-rows في مشروع Supabase (الافتراضي 1000).

interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

export const FETCH_PAGE_SIZE = 1000

export async function fetchAll<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<{ data: T[]; error: string | null }> {
  const all: T[] = []
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await buildPage(from, from + FETCH_PAGE_SIZE - 1)
    if (error) return { data: all, error: error.message }
    const page = data ?? []
    all.push(...page)
    if (page.length < FETCH_PAGE_SIZE) break
  }
  return { data: all, error: null }
}
