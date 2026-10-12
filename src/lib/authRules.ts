// قواعد الدخول في مكان واحد (عشان الواجهة كلها تمشي بنفس القاعدة).
// ملحوظة: الـ Edge Function (supabase/functions/manage-users) ليها نسخة
// من القاعدتين دول لأنها بتشتغل على السيرفر ومش بتستورد من هنا — لو غيّرت
// حاجة هنا غيّرها هناك كمان.

export const MIN_PASSWORD_LENGTH = 10

// اسم المستخدم بيتحول لإيميل داخلي (username@warehouse.local)، فلازم
// نفس الشكل يتكتب بنفس الطريقة كل مرة: من غير مسافات حوالين الاسم وبحروف صغيرة.
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}
