export const supportedTypes = [
  "SUMMARY",
  "CONCEPT",
  "ARGUMENT",
  "CLAIM",
  "QUOTE",
  "QUESTION",
  "COUNTERPOINT",
  "EXAMPLE",
  "STORY",
] as const;
export type CognitionType = (typeof supportedTypes)[number];

export const cognitionTypeLabels: Record<CognitionType, string> = {
  SUMMARY: "核心观点",
  CONCEPT: "关键概念",
  ARGUMENT: "主要论证",
  CLAIM: "关键主张",
  QUOTE: "原文证据",
  QUESTION: "值得质疑",
  COUNTERPOINT: "值得质疑",
  EXAMPLE: "案例",
  STORY: "故事",
};

export function isCognitionType(
  value: string | undefined,
): value is CognitionType {
  return Boolean(value && supportedTypes.includes(value as CognitionType));
}
