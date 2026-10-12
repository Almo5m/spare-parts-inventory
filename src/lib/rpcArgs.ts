// أنواع Supabase المولّدة بتعتبر بعض بارامترات الدوال (RPC) نصوص إجبارية
// حتى لو دالة SQL نفسها بتقبل NULL (زي الملاحظات أو العميل النقدي).
// الدالة دي بتخلّي TypeScript يقبل null في الأماكن دي، من غير ما نغيّر
// ملف الأنواع المولّد (لأنه بيتكتب من جديد كل مرة بنولّده).
export function nullableArg<T>(value: T | null | undefined): T {
  return (value ?? null) as T
}
