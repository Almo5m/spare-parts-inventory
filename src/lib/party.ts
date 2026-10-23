// اسم العميل زي ما بيظهر على الفاتورة والقوائم:
// العميل المسجّل، أو الاسم اللي اتكتب للعميل النقدي (بعلامة «نقدي»)، أو «عميل نقدي» لو مفيش اسم.
export function invoicePartyName(
  registeredName: string | undefined,
  cashName: string | null | undefined
): string {
  if (registeredName) return registeredName
  const typed = cashName?.trim()
  return typed ? `${typed} (نقدي)` : 'عميل نقدي'
}
