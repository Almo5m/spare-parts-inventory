// أداة بسيطة لحفظ أي فورم في localStorage أثناء الكتابة فيه،
// عشان لو المستخدم قفل التطبيق أو غيّر الصفحة بالغلط، البيانات ترجع
// تلقائيًا لما يفتح نفس الفورم تاني. بعد نجاح الحفظ الفعلي في قاعدة
// البيانات، لازم تنادي clearDraft عشان المسودة متفضلش متخزنة من غير داعي.

const PREFIX = 'draft:'

export function loadDraft<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveDraft<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // تجاهل أي خطأ تخزين (مساحة ممتلئة أو متصفح خاص)
  }
}

export function clearDraft(key: string): void {
  localStorage.removeItem(PREFIX + key)
}

// بتمسح كل المسودات (بنناديها عند تسجيل الخروج، عشان بيانات فاتورة نصف مكتوبة
// متفضلش على الجهاز لو حد تاني استخدمه)
export function clearAllDrafts(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  } catch {
    // تجاهل أخطاء التخزين
  }
}
