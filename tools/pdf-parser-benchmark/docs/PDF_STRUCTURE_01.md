# PDF-STRUCTURE-01 — 结构证据门禁（隔离实验第一切片）

## 边界

本切片仅扩展 `tools/pdf-parser-benchmark`。不影响正式书籍导入、PDF.js/MinerU 生产路由、数据库、工作台和现有发布门禁。所有真实 PDF、OCR、Ground Truth、页面截图、复核文字和机器原始输出继续留在私有目录；仓库只存合成测试和不含私有内容的说明。

当前 `NormalizedOutput` 提供块文字、kind、子集页索引、可选 bbox/confidence、页标记，但**不提供经验证的图形节点/边/箭头/时间语义**。识别到“请求、响应”等标签不代表正确理解流程图。

## 代码

`src/structure/evidence.mjs` 提供纯函数 `evaluateStructureEvidence({ reference, normalized })`：

- 参考数据持有经过校验的 `sourcePages1Based`，严格绑定子集页索引和原书物理页。不能使用书本印刷页码或 MinerU 的 Markdown 注释推断。
- 检查输出页容器唯一性、块页索引及 `pageMarkers` 证据；无法绑定页码时返回 `PAGE_BINDING_UNVERIFIED`，不对该页打分。
- 对参考元素只做确定性文字证据核对：`MISSING` / `AMBIGUOUS` / `FLATTENED_TEXT_PRESENT` / `TYPED_TEXT_PRESENT`。
- 对按明确参考顺序列出的正文锚点报告可比较对、顺序和 `complete`。部分匹配不可冒充全页满分。
- 流程图边、箭头、时序、版面关系统一为 `NOT_VERIFIABLE_FROM_NORMALIZED`，不生成虚构结构分数、解析器排名或“理解图形成功”结论。
- 输出仅包含元素 ID、状态和计数；不会携带参考或候选正文。

### 参考输入契约（完全合成示例）

```json
{
  "schemaVersion": "acs-pdf-structure-reference-v1",
  "fixtureId": "SYN-STRUCT-01",
  "sourcePages1Based": [51],
  "pages": [{
    "subsetPageIndex": 0, "sourcePhysicalPage": 51,
    "elements": [
      { "id": "body_a", "kind": "paragraph", "text": "测试段落" },
      { "id": "node_a", "kind": "figure_label", "text": "起点" },
      { "id": "node_b", "kind": "figure_label", "text": "终点" }
    ],
    "linearOrder": ["body_a"],
    "relations": [{ "id": "edge_1", "kind": "FLOW", "from": "node_a", "to": "node_b" }]
  }]
}
```

参考必须由独立于被测解析器的证据建立。用户本轮九页 AI 视觉复核必须标注 `AI_ASSISTED_NON_BLIND`，不能冒充人工双人认证，也不能将真实参考数据提交到 Git。

## 真实风险场景（不是解析器真实结构得分）

- RB-PDF-13 / P51：正文绕排与“图 1-21”图中文字混入正文。
- RB-PDF-13 / P127：TCP 客户端与服务器的通信箭头、代码格式。
- RB-PDF-13 / P379：802.11 DIFS/SIFS 时序、数据与确认方向。
- RB-PDF-12 / P261：插画页与画面文字；不得以 OCR 字符覆盖率代替图像含义。

这些样本有本地私有原书页图像证据，但此前用户导出的 JSON 没有保留可直接验证的完整 `normalized.json` 块种类和页归属。**尚未生成真实的逐解析器结构准确率**，不得从报告文本反推或捏造。

## 验收和下一切片

运行隔离工具的 `npm test`（Vitest 将发现 `tests/structure-evidence.test.mjs`），不需要真实 PDF 或模型下载。

下一步在 Windows 私有目录中只读加载准确 Manifest 和每个候选原始 `normalized.json`，用独立参考锚点生成可验证的分类矩阵。只有取得真正的结构化关系输出及对应来源证据后，才可以增加节点、箭头、时序关系的准确率指标。不得因本切片的门禁通过，就直接替换生产解析器。
