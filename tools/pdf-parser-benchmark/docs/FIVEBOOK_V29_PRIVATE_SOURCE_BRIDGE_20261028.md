# 五书 v29：复用真实 SHA 原页，建立 v28 私有待审数据包

日期：2026-10-28。状态：待 GitHub 精确 HEAD 验证；没有凭空生成独立 Gold。

## 分支关系

本变更基于 v28 Draft #206；v28 基于现有私有 Benchmark v24 Draft #198。独立于视觉 Worker #205，不能因为后者 CI 全绿，就声称本次真实书页识别通过。

## 在 Windows D: 已有材料基础上的可执行桥接

脚本：tools/pdf-parser-benchmark/scripts/ebook_fivebook_v28_source_bridge_v29.py

只用已有的、由上游来源链签名/哈希关联的五个 OCR 重点物理页：

- B03 物理 67、B15 物理 109：v13 保存的是九宫格 tile，没有保存 3× 完整 PNG。桥接复用原始 native matrix 中已 SHA 绑定的 1.4× 整页 PNG，明确标记来源分辨率，不冒充 3×。
- B08 物理 64、B29 物理 72、B31 物理 126：复用 v17 3× 完整 PNG；逐项检查 v17 报告、原书 SHA、原图 SHA、未 Gold 状态，并与 native matrix 原书 SHA 交叉绑定。
- 对这五张现有原页生成新私有目录 fivebook_v28_source_bridge_v29，保留 5 张 PNG、一个 v28 packet 和一个 v29 provenance receipt。packet 中 reference=null、candidates=[]、bleedthrough=UNDETERMINED；候选文本不能拿旧系统数据盲目拼接成同页准确率。
- v28 原始选页范围为五书 × 每书四页 = 20 页。**桥接只迁移五张重点页，剩下 15 页未准备；Gold 0/20、CER=null**。五书 0/5 仍不变。
- 不执行 OCR/MinerU/Docling，不调用付费模型，不再次渲染 PDF，也不改动旧的冻结文件。
- 写入只允许新的 D: 私有目录，若已存在则拒绝覆盖，支持 audit-only 对新数据包逐字节核验。
- GitHub Actions Ubuntu 只运行无版权合成字节测试；真实来源审核只在有私有磁盘的 owner-only Windows runner 内运行，日志仅固定状态和页数，原文、图像、SHA 不上传。

## 现场校验和后续

如果 Windows runner 在线且原始证据仍然完整，专用 workflow 可以自动执行一次新私有目录 staging 和第二次只读 audit；如本地 Runner 未在线或证据不足，必须保持未验收。请勿通过手工“放行”或缺失样本当作已完成。

下一步必须从已有的真实 v12/v13/v17/v24 原页中做独立全页九宫格审核，并让三个引擎输出真正绑定到同一来源与同一文本范围。B08 的透印归属未定时不得批准全文 Gold。

禁止公开原书、候选文本、私有截图、GitHub artifact、CI 原文输出；生产 Docling 继续 OFF、Issue #161 OPEN，任何 PR 未经授权不合并。
