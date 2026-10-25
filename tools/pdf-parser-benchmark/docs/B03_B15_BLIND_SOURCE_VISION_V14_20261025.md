# Stage 1｜B03/B15 高分辨率原图盲识别 v14（候选，非 gold）

## 与 #182 的衔接

#182 已在本机 D: SHA-pinned staged PDF 上生成两页共 18 张 3x 原图九宫格；Windows 真正生成/重放、Linux 合成检查及主 CI 以该 PR 的准确 HEAD 全部成功。

本轮不再创建 OCR 共识，也不让视觉模型看到 RapidOCR、MinerU、Docling 的任何预测。目标是进一步替代人工逐字初筛：直接从用户本机高分辨率**来源图像**提取四个重点区域的「可见文字候选、不确定笔画、图形观察备注」，供后续来源对照和覆盖判断。

## 固定四区域、上限四次请求

- B03 PDF p67 / R1C2：摘要与紧凑字形的候选观察
- B03 PDF p67 / R1C3：右侧竖排或旁注候选观察
- B03 PDF p67 / R2C2：正文中部候选观察
- B15 PDF p109 / R3C2：图表图例文字/实心空心标记候选观察

「区域对应哪一具体文字」是预期调查方向而非代码已证明的页面布局事实。v13 每格强制真实源 PNG SHA 对账，v14 还预检全部 18 张来源图片防篡改，不修改任何现存 frozen 源。

## 云端成本与隐私边界

重用已有 GLM 视觉 Provider 接口（模型配置和 API key 仅从当前 Windows Runner 的私有环境取得）。只有显式启动 --write --allow-cloud-vision 且 API key 存在时才调用；本切片的 owner-only 专项 workflow 在此双条件满足时会发起最多 4 个受控请求、每个区域至多一次，**会向已配置的 GLM 服务提供对应 PNG 图像**，可能产生云端费用。若环境没有可用 key，工作流只做离线只读来源预检并报告 NOT_EXECUTED，不能标记视觉识别成功。

GitHub CI、仓库和 PR 不接收 PNG、文字、模型回复、完整原书哈希、源图坐标或密钥。含原文的 JSON 候选只保留在私有 D:。

已核验第一轮准确 HEAD eeea907aa1e7157b87ca55280330ce91924599ba：Windows 来源预检 PASS、云端步骤 NOT_EXECUTED（Runner 未见可用环境密钥），不可标记为视觉候选已生成。工作流已追加对 GitHub Actions 同仓库 owner 级可选机密 ACS_GLM_VISION_API_KEY / GLM_API_KEY 的映射；密钥由用户在 GitHub Secrets 自行配置或继续从 Runner 私有环境传入，仓库绝不保存值。后续新 HEAD 必须独立验收，不复用首次成功的离线 preflight 结论。

对于每次云调用，先以 O_EXCL 落地不可重试 journal，再发请求。如果网络超时或进程断开，状态视为「可能已经扣费」，没有人工处置不会再次调用；不会无限重试或意外放大成本。已有候选可以无重复付费进行 audit-only。

目标存储目录：

D:\ai-cognitive-pdf-benchmark-data\semantic_gate\multibook_matrix_20261023\b03_b15_blind_visual_triage_v14

## 验收与权威约束

- 8 组纯合成测试，检查外部模型绝不在公共 CI 触发、来源 SHA 不一致立即拒绝、schema 严格、四调用预算、重复执行零新增费用、网络未知时不重试、错输入无写入。
- Windows owner-only 先 check-only，且仅在本地 key 可用时调用模型；最终 audit-only 再验四个私有候选。stdout 严格固定无内容摘要。
- B15 观测不能把候选图例标记到真实曲线强关联；B03 不得自动拼接成完整页参考。
- 结果 status 恒为 SOURCE_IMAGE_ONLY_MODEL_CANDIDATE_NOT_INDEPENDENT_GOLD。无人工来源/出版商独立核对；一个视觉模型的一次/两次调用都不能签发 gold。
- 五书 gold 仍 0/5，真实三引擎 CER 仍 null，Issue #161 OPEN，生产 ARCHITECTURE_NOT_FROZEN。
- 基于 #182、保持 Draft/Open/Unmerged，未经明确授权不合并。

本切片至多完成**四个局部视觉候选**，不是整页、整本乃至图表准确率已验收。下一步应在私有域按来源图逐项复核候选不确定性，并扩展到物理整页九宫格覆盖后才允许独立参考签发。
