# AI Cognitive Studio | 2026-10-22 图表结构化语义门禁

本文件为 Benchmark 的图表结构审核协议，不代表模型已完成真实书页图形理解。

## 结构化事实
数据包含物理页、书籍匿名 ID、来源 PDF SHA-256、对象及其父容器、关系方向、图表横纵轴语义、趋势类型。
参考文档有 evidence={tier,reviewer}；预测文档有 engine={name,version} 和可选 abstained。
通用入口 tools/pdf-parser-benchmark/scripts/ebook_semantic_structure_gate.py 。
私有预测、原图、参考、报告只允许在 --private-root 下；公共 GitHub 只提交非书籍合成测试。

## 不变量
- L2_AI_VISUAL_PROVISIONAL 仅是 AI 对私有书页视觉阅读形成的暂定参考。
- L3_SYNTHETIC_SELF_AUTHORED 仅适用于自造测试，不能推广为真实书籍图表准确率。
- 所有报告强制 certified_graph_f1=null、human_verified=false、graph_verified=false。
- 发现 humanVerified 或 graphVerified 输入字段时直接拒绝；来源 PDF SHA 或物理页不一致亦拒绝。
- 预测箭头反向、遗漏节点、虚构边与错判曲线类型分别计数；无结构预测必须弃权。

## 本轮 B15 / B31 私有视觉参考
B15 物理第 109 页含生命周期趋势和多序列功能变化曲线；B31 第 126 页含客户端/服务端、不同套接字和有向连接。
私人 L2 参考仅作暂定一致性对照，不提交原图、OCR 原文和整份语义参考。
现有 Docling + RapidOCR / PaddleOCR 三页实测仅证明文字抽取曾成功，未证明恢复曲线、坐标轴和图连接。

## 真实运行状态
独立合成 CI 校验图关系比较与权限边界；在真正的图结构预测接入并执行以前，
只能表述为审核门禁已实现，不能表述为图表识别模型已通过实际验收。
生产 humanVerified / graphVerified / CAS 审核状态保持不变。

## 2026-10-23 增量：L3 多曲线归属与一致性

本切片完善的是**语义预测/参考的数据契约与离线比较器**，不是视觉模型或真实图表识别准确率的认证。它允许在同一张图下有多个 `kind=series` 对象，并分别描述各自趋势，例如：

```json
{
  "objects": [
    {"role":"chart_one","kind":"chart"},
    {"role":"series_one","kind":"series","parent_role":"chart_one"},
    {"role":"series_two","kind":"series","parent_role":"chart_one"}
  ],
  "trends": [
    {"chart_role":"chart_one","series_role":"series_one","shape":"increasing"},
    {"chart_role":"chart_one","series_role":"series_two","shape":"decreasing"}
  ]
}
```

上述只是片段，完整输入仍需要原 `schema_version/page/evidence` 或 `engine` 等来源字段。旧版未填写 `series_role` 的图表整体趋势依然兼容，但不能再把两条不同曲线都折叠成一条整体趋势做“准确”宣称。

新增拒绝条件：
- 对象的 `parent_role` 形成循环层级；即使每个单独父指针存在，也属于结构不一致。
- 相同图表的相同 `x/y` 轴维度同时出现多种意义。在当前 v1 契约没有双纵轴标识的情况下必须弃权或拒绝，不能擅自判断。
- `series_role` 不存在、不是 `kind=series`、或没有在父级链上归属于所声明的 chart。
- 同一图表及同一曲线重复给出互相矛盾的趋势。

这项门禁仍只提供 **provisional agreement**，且要求源书 SHA、物理页完全一致。它**不比较图片框 IoU 来验证曲线意义**，也不自行声称某个识别引擎更准确。所有 `certified_graph_f1` 保持 null、`human_verified/graph_verified` 保持 false，真实 B15/B31 结构候选仍待独立模型和私有数据实测。

专项合成 CI 可在堆叠 PR 上执行；其成功不代表真实书页图表结构理解通过。独立私有结构候选/参考不得上传公共 GitHub。
