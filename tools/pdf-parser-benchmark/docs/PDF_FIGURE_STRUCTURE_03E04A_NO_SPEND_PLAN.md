# PDF-FIGURE-STRUCTURE-03E-04A｜多区域云端图理解零调用预检

**2026-10-21 · Draft PR #100 · 仅离线计划与计费保护，不是批量 GLM 执行完成**

## 1. 目的和最新事实

用户希望“已有材料全部自动导入，最后只做人工审核”。03E-01/02 已能发现及预览 RB-PDF-12/13 中 15 个原书裁剪区域；03E-03B 已能审核任何**经过源 SHA 和可信登记**的模型图关系结果。

当前生产既有图关系来源：仅 **RB-PDF-13 物理 P127** 的一个成功 GLM r02（9 个节点、10 条候选边，NOT_REVIEWED，graphVerified=false）。真实另外 **14 个区域只有合法的裁剪 PNG，尚没有通用模型图关系**。

本阶段实现 **零付费调用的自动计划**：
- 服务端从受控私有根目录检查规范 Manifest、物理页、PNG 大小及 SHA-256；复用同一份可信审核登记表，已经产生有效图关系的区域不重新请求 GLM。
- `annotation/graph-batch-plan.mjs` 形成确定性的 `acs-offline-graph-batch-plan-v1` 清单和 `planSha256`，只用于将来核对授权对象和来源变化，不构成用户同意。
- 每个裁剪图按“未来**一个图/一次请求**”计算：最多 14 个拟选区域，最多 48,000,000 原图总字节；单图最多 7,000,000 字节。按 Base64 含预留开销初筛不得超过云端 adapter 的 12,000,000 字节单请求门槛。**后续执行必须再按真实完整请求字节和当时模型价格重新硬核验，不可认为预检上限就是实际费用上限。**
- 对已有模型结果、缺失、SHA 不匹配、超限、重复图像 SHA、超出总预算的项都返回明确排除原因，不能静默裁剪或用“失败自动重试”补偿。
- 对每个待识别区域，检查现有 adapter 的初次请求 `.cloud-attempted` 回执、`-stage` 暂存及正式输出（还检查同书籍旧 `batch` 命名空间）。存在任何一次既有可计费尝试的迹象，即使没有响应，仍 **禁止再次请求**；不能清理/覆盖旧回执，也不能以 CI 失败为理由直接重发。

## 2. 本次对外权限

`GET /api/private-graph/batch/plan` 仅在原有 `--auto-import-p127` 本机临时凭据模式下可访问，仍受到原有 Host/Origin/Fetch-Site/256-bit token 限制；无任意文件路径、无参数、无 POST/PUT/DELETE。默认静态标注模式返回 404。

响应只返回计划摘要、每项书籍/物理页/region ID、候选状态与少量计数；**不返回 PDF 原图、PNG 原始字节、候选节点文本、模型回答、目录路径或任何 API Key**。页面批量计划面板显示：已发现、需推理、已有图关系、计划指纹和本轮实际调用 0 次。没有付费执行按钮。

所有计划均固定：
`PREVIEW_ONLY_NO_PROVIDER_DISPATCH`、`needsExplicitPaidAuthorization=true`、`providerRequestsIssued=0`、`dispatchEnabled=false`、`priceEstimate=null`。

**价格仍未核实。** 最大 14 次仅是“拟选请求数上限”，不是货币金额承诺，也不是实际预授权。授权应单独指定区域、调用/币额上限、模型、幂等 run ID、失效机制，再允许 03E-04B 计费执行器提交网络请求。本切片没有该执行器，也没有任何自动重试机制。

## 3. 验收记录

- 最新 JS 和 Python 合成专项通过后才能视为“预检代码已验证”；重点测试：完整性和无重复、候选指纹确定性、已注册有效图关系不重复处理、历史 GLM 回执/暂存/输出自动阻断、价格 unknown、GET-only、未授权和跨站拒绝。
- **保留失败**：[专项首失败 #39569589726](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39569589726)：新 priorAttemptBlocked 安全字段与旧测试夹具不同步，两项测试失败；修复后不能覆盖该事实。
- **保留失败**：[首次 Windows 私有预检 #39569969803](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39569969803)：duplicate 标记变量的 JS 作用域遗漏，源码 SHA 校验通过后运行阶段 fail-closed；没有 GLM 调用。
- [Windows 真正私人 15 区域只读预检 #39570205896](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39570205896)：新作用域修复后检查通过：**15 已发现，1 已有图关系，14 待授权，0 异常，0 模型请求**。这是原 D 盘现有数据的真实结果，未打印私有内容。
- **保留失败**：[首轮合成 Edge #39570755532](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39570755532)：测试中第二本书已注册有效图关系，但计划器使用默认登记表，导致 UI 拟重复识别。修复后让服务端计划器复用**同一份当前可信登记表**，并新增防重复专项回归。
- [修复后合成 Edge 双书 #39571274341](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39571274341)：SUCCESS；双方图关系都已可信登记时待推理 0、已付费请求 0；旧 P127 保存、合成 P51 隔离保存和刷新恢复依然通过。
- [真实 Windows Edge 页面 #39570869221](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39570869221)：SUCCESS；15/15 裁剪真实顺序预览，批量面板显示 14 个待识别、0 次付费调用，P127 图关系保持未认证，原人工草稿 SHA 未变。注意这次真实 Edge 的源码比最终修正共享登记表的代码略早，最终共享登记表已通过合成 Edge 回归，当前真实数据的登记表只有 P127。
- 上述 Windows Runner 和 CI 执行文件均来自经 Git Blob SHA 核验的**公共源码**，原书内容保持本地，不进入 GitHub Action 日志或 artifacts。

## 4. 未完成及下一步

03E-04B 才能实现真正可控的授权/提交状态机（明确用户对新的付费模型调用授权、完整实际请求字节和价格核验、单图计费回执 durable first、幂等及 crash 重启不重发、部分成功、单区域失败隔离、结果证据 SHA 检查与登记审计）。未来 14 图识别成功后再由 03E-03B 的审阅器进入最终人工审核，不能自动升级 `graphVerified`。

**不允许**从 03E-04A 直接触发云端识别，也不允许把此切片称作“14/14 图关系成功解析”。PR #100 仍 Draft、未经用户明确批准不合并；实际 Windows 本地工作树部署不等于 Runner 测试通过。
