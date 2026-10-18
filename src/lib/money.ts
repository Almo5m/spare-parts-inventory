// دوال مشتركة للمبالغ والتواريخ والربح، عشان كل الصفحات تحسب بنفس الطريقة.

// تقريب لقرشين. نفس التقريب اللي بتعمله قاعدة البيانات، فالإجماليات بتطابق.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// إجمالي سطر واحد بعد التقريب (الكمية × السعر)
export function lineTotal(quantity: number, price: number): number {
  return round2(quantity * price)
}

// نسبة الخصم على الفاتورة: الإجمالي بعد الخصم ÷ قبله. بتتضرب في إيراد أي سطر
// عشان الربح يتحسب على اللي اتدفع فعلًا مش على السعر قبل الخصم.
export function netRatio(totalAmount: number, discountAmount: number | null | undefined): number {
  const gross = totalAmount + (discountAmount ?? 0)
  return gross > 0 ? totalAmount / gross : 1
}

// مفتاح اليوم بالتوقيت المحلي (YYYY-MM-DD). toISOString بترجّع اليوم بتوقيت UTC،
// وده كان بيزحزح مبيعات النهار يوم كامل في الرسم البياني.
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
