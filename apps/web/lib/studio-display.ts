export const masteryLabel: Record<string, string> = {
  UNASSESSED: "尚未验证",
  NEEDS_REVIEW: "需要再梳理",
  DEVELOPING: "正在形成",
  DEMONSTRATED: "已表现出理解",
};

export const rubricCriterionLabel: Record<string, string> = {
  CORE_MEANING: "核心意思",
  COVERAGE: "关键内容",
  NO_OVERCLAIM: "没有过度延伸",
  DEFINITION: "概念定义",
  DISTINCTION: "与相近概念的区别",
  EXAMPLE: "举例说明",
  CORE_CLAIM: "核心主张",
  REASONING_LINK: "推理关系",
  BOUNDARY_OR_COUNTEREXAMPLE: "适用边界或反例",
  PARAPHRASE: "换一种说法",
  IMPLICATION: "含义与影响",
  PROBLEM: "要回答的问题",
  ASSUMPTIONS: "隐含前提",
  PRINCIPLE_LINK: "与原则的联系",
  RELEVANT_DETAIL: "相关细节",
  GENERALIZATION_BOUNDARY: "概括的边界",
};

export function rubricLabel(key: string) {
  return rubricCriterionLabel[key] ?? "理解要点";
}

export function displayMastery(value: string | null | undefined) {
  return masteryLabel[value ?? "UNASSESSED"] ?? "尚未验证";
}

export function statusTone(value: string) {
  if (/失败|未完成|停用|拒绝|已取消|需处理/.test(value)) return "danger";
  if (/处理中|生成中|解析中|理解中|合成中|规划中|设计中|撰写中|润色中|核验中|整理中|检索中|准备中|渲染中|检查中|组装中|调整中|正在|待配置|需要/.test(value)) return "warning";
  if (/完成|就绪|启用|可阅读|已绑定|已提取|可播放/.test(value)) return "success";
  return "muted";
}
