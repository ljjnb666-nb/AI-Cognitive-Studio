export function estimateSpokenDurationMs(text: string, rates = { chineseCharactersPerSecond: 4.2, englishWordsPerSecond: 2.6 }): number {
  const chinese = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const withoutChinese = text.replace(/[\p{Script=Han}]/gu, " ");
  const englishWords = withoutChinese.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const punctuationPause = (text.match(/[，。！？；,.!?;]/g) ?? []).length * 0.12;
  return Math.max(400, Math.ceil((chinese / rates.chineseCharactersPerSecond + englishWords / rates.englishWordsPerSecond + punctuationPause) * 1000));
}
