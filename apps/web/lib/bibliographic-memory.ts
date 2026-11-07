// Shared by the detail view and PostgreSQL list/detail filters. Match whole
// records so mentioning a date or ISBN within a substantive claim is safe.
const shortName = "[一-鿿]{2,4}";
const dottedName = "[一-鿿]{2,12}(?:[·・][一-鿿]{1,12})+";
const name = "(?:" + shortName + "|" + dottedName + ")";
const role = "(?:作者|译者|编者)";
const contributor = role + "(?:[：:] *" + name + "|为(?:[一-鿿]{1,5}国的" + name + "|" + dottedName + "))";
const pairedCredits = "作者为(?:[一-鿿]{1,5}国的)?" + name + "[，,] *译者为" + name;
const publication = [
  "(?:英文原书|原书|英文|中文)(?:书名|题)(?:为|[：:] *)《[^》]+》",
  "(?:英文|中文|简体中文译本|原版|中文版)?版权(?:年份)?(?:为|[：:] *)[0-9]{4}年",
  "(?:中文版|英文版)?ISBN(?:-1[03])?(?:为|[：:] *)[0-9X][0-9X –—-]{8,24}",
  "出版社(?:为|[：:] *)[一-鿿]{2,20}出版社",
].join("|");
const field = "(?:" + pairedCredits + "|" + contributor + "|" + publication + ")";
export const bibliographicMemoryPattern = "^ *" + field + "(?:[，,；;。] *" + field + ")*[。.]? *$";
const bibliographicMemory = new RegExp(bibliographicMemoryPattern, "i");

export function isBibliographicMemory(content: string): boolean {
  return bibliographicMemory.test(content);
}
