# PDF-FIGURE-STRUCTURE-03E-03A｜跨书页图关系候选与独立审核草稿契约

**日期：2026-10-21 · 状态：Draft PR #100 · 无 GLM 新调用**

## 本切片实际完成的工作

在不修改旧 P127 已验证格式、路径和审核结果的前提下，新增两个内部模块：

- `annotation/region-graph-review.mjs`：跨 `RB-PDF-12/13`、不同物理页和不同 `regionId` 的严格候选验证及审阅草稿。它只接受已经经过可信代码登记的书页来源，核对源 Manifest、裁剪 SHA、结果 SHA、provider、模型、请求尝试类别、候选节点/边、整页坐标和所有 **NOT_REVIEWED** 状态。模型输出不能指定审核对象的权威来源。
- `annotation/region-review-store.mjs`：每个区域草稿文件名由 `fixtureId + regionId + 完整 64 位十六进制结果 SHA` 绑定；存放在固定私有 `private-region-reviews-v1` 子目录。文件写入使用排他锁、SHA revision 的 compare-and-swap、同步临时文件及原子 rename。两个标签页/进程对同一版本竞争，必须有至少一个写入被拒绝；跨区域和跨结果文件不能互相覆盖。崩溃留下的锁**不能自动清除**，需要人工核查后处理。

所有新草稿一直保持 `REVIEW_DRAFT_UNATTESTED` / `humanVerified=false` / `graphVerified=false`。这是一种**候选记录**，不构成人工最终批准，更不能发布播客知识。

## 尚未接通的部分——不要误报为最终产品完成

目前这个通用模块还是**仅限内部使用的数据契约和私有保存能力**，没有开放任意新图区域的 HTTP 审核 API，也没有让其他 14 张只有裁剪的区域进入“节点/边最终审核”。旧 P127 审核页仍使用已经验收的专用接口、专用草稿格式；**不得将 P127 的旧草稿直接迁移或当成新区域草稿**。

03E-03B 必须再建立**可信的图结果登记表（明确输出相对路径、书籍/页码/区域、实际结果 SHA 和 model attempt）**，只有经过代码核验、原始来源及结果 SHA 校验的结果才能出现在统一审阅列表。出于误用和隐私风险，不能递归搜集目录下任意新 JSON，不能根据 PNG 伪造图节点，不能接受 URL 自带的文件路径或模型参数，也不能擅自批量发送裁剪图到 GLM。

对新区域的云端模型推理仍需要单独的费用、图片数量与调用范围授权。只读预览已有 15 张 PNG 不收费；并不意味着已经成功解析了 15 张图关系。

## 测试和回归范围

- 原 P127 03C/03D/03E-01/03E-02 单元和真实 Edge 检查保持不动。
- 新 `tests/region-graph-review.test.mjs` 验证两本书、P127/P51、来源身份/错页/错 SHA/节点边坐标/伪造人工审批等。
- 新 `tests/region-review-store.test.mjs` 验证独立草稿、结果 SHA 变更、并发 CAS、遗留锁和符号链接拒绝。
- Windows 真实 P127 回归仅使用可信 Runner 内的原始私有数据只读对照，不创建新草稿，不打印内容。
- **历史失败保留**：最初 [#39563721664](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39563721664) 混入旧 P127 六项测试；随后 [#39563923003](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/actions/runs/39563923003) 清理时误删了新套件依赖的辅助函数；均为测试装配问题，已分别针对性修复。准确 HEAD CI 结果应重新核验，不能以旧失败或旧成功推断新结果。

**开放门禁**：03E-03B 多区域 GUI 接入、真正其他区域的推理、新的图关系人工语义审核、人工认证/双人独立复核均尚未执行。PR #100 继续 Draft / Open / Unmerged。
