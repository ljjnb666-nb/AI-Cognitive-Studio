/**
 * Conservative normalization/classification helpers for controlled promotion.
 *
 * Candidate evidence remains untouched. These helpers only decide whether a
 * value has enough structure to enter Work/Edition product identity.
 */

export type ProductIdentifierPromotionClassification =
  | { kind: "ISBN10"; value: string }
  | { kind: "ISBN13"; value: string }
  | { kind: "UNCLASSIFIED" }
  | { kind: "INVALID_EXPLICIT_ISBN" };

export function normalizeProductIdentityTitleForComparison(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Comparison-only ISBN normalization for existing product identity.
 *
 * Existing user/legacy values remain authoritative and are never rewritten by
 * this helper. We only ignore conventional presentation separators so a stored
 * value such as 978-0-306-40615-7 compares equal to canonical 9780306406157.
 */
export function normalizeIsbnForComparison(value: string): string {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

export function isPromotableProductLanguage(value: string): boolean {
  const normalized = value.trim();
  return normalized.length <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(normalized);
}

function validIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 10; index++) {
    const char = value[index]!;
    const digit = index === 9 && char === "X" ? 10 : Number(char);
    sum += (10 - index) * digit;
  }
  return sum % 11 === 0;
}

function validIsbn13(value: string): boolean {
  // ISBN-13 is an EAN-13 restricted to the Bookland prefixes assigned to ISBN.
  // A generic 13-digit EAN with a valid checksum is not automatically an ISBN.
  if (!/^(?:978|979)\d{10}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 12; index++) {
    sum += Number(value[index]!) * (index % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(value[12]!);
}

/**
 * Bare digit strings remain UNCLASSIFIED even when their checksum is valid.
 * Promotion requires an explicit ISBN lexical marker in dc:identifier.
 */
export function classifyProductIdentifierForPromotion(value: string): ProductIdentifierPromotionClassification {
  const trimmed = value.trim();
  const urn = /^urn:isbn:\s*(.+)$/i.exec(trimmed);
  const labeled = /^isbn(?:-(10|13))?(?::|\s+)\s*(.+)$/i.exec(trimmed);
  const raw = urn?.[1] ?? labeled?.[2];
  if (!raw) return { kind: "UNCLASSIFIED" };

  const compact = raw.replace(/[\s-]+/g, "").toUpperCase();
  const declaredScheme = labeled?.[1] ?? null;
  if (declaredScheme === "10") {
    return validIsbn10(compact) ? { kind: "ISBN10", value: compact } : { kind: "INVALID_EXPLICIT_ISBN" };
  }
  if (declaredScheme === "13") {
    return validIsbn13(compact) ? { kind: "ISBN13", value: compact } : { kind: "INVALID_EXPLICIT_ISBN" };
  }
  if (validIsbn10(compact)) return { kind: "ISBN10", value: compact };
  if (validIsbn13(compact)) return { kind: "ISBN13", value: compact };
  return { kind: "INVALID_EXPLICIT_ISBN" };
}
