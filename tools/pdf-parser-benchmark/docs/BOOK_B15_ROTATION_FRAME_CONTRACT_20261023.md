# B15 旋转 270° 页面的私有空间坐标契约（2026-10-23）

## 当前状态
- B15：PDF **物理页 109**，PyMuPDF 实测 `page.rotation=270`（源于先前的真实 Windows Benchmark 日志）。
- Docling Picture provenance 在其**单页 PDF 文档坐标系**中给出归一化 bbox；不能由函数名推断它是未旋转 PDF 坐标还是显示旋转后的坐标。
- B31：PDF 物理页 126，旋转为 0°，已有私有 ROI matcher 仍照原逻辑运行。
- 当前尚没有经过检查的真实私有 `B15_B31_roi_candidates.private.json` 与 B15 旋转锚点，所以真实空间 IoU、箭头方向、图表语义 **仍为 UNVERIFIED**。不准将此处的合成测试记为实书正确率。

## 防止虚假的几何匹配
- 原先 B15 帧未知时返回 `ROTATED_DISPLAY_TRANSFORM_UNVERIFIED`，不假装与 PDF 显示帧相同。本改动保留这个默认。
- **只有** D 盘私有侧存在参考文件及 `semantic_gate/B15_roi_frame_calibration.private.json` 后，才尝试校准空间对齐。
- 该 sidecar 必须声明 Docling picture 框的真实坐标帧 `PDF_UNROTATED_TOPLEFT` 或 `PDF_DISPLAY_TOPLEFT`。前者按 PDF 页旋转角度转换 bbox；后者本身已在显示帧，不重复旋转。
- 必须声明 B15、物理页 109、与 SHA 固定语料一致的文件哈希、源 PDF 旋转角度 270°；三至十二对**不同位置、非共线**的视觉锚点，标注候选帧与显示帧中对应的真实位置。归一化残差上限 0.02/轴。该校准是 L2 AI 视觉参考，不是人工金标准。
- 匹配仍使用原一对一最大基数、IoU >= 0.10/覆盖率 >= 0.20 的保守门禁。任何非法 frame / SHA / 物理页 / 坐标 / 非有限数 / 伪造金标准字段都会拒绝，不绕过既有 `match()` 校验。
- 270° 顺时针时，未旋转归一化点 `(x,y)` 对应显示归一化点 `(y,1-x)`；另外验证 0/90/180/270 的边界和逆变换。
- 匹配摘要只包含匿名计数及状态，不包含图片、图表原文、具体锚点、具体 bbox、source SHA。所有私有参考、候选与报告仅保存在 D 盘私有数据根目录。

## 私有 sidecar 的字段
`semantic_gate/B15_roi_frame_calibration.private.json`：
- `schema_version`：1
- `authority`：`PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH`
- `book_id`：`B15`、`physical_page`：109
- `source_document_sha256`：与已有 B15 Manifest 完全一致的 SHA-256
- `source_pdf_rotation_degrees`：270
- `candidate_frame`：`PDF_UNROTATED_TOPLEFT` **或** `PDF_DISPLAY_TOPLEFT`（必须通过独立锚点确认）
- `reference_frame`：`PDF_DISPLAY_TOPLEFT`
- `anchor_pairs`：列表，每个对象仅包含 `candidate_point: [x,y]`、`display_point: [x,y]`，至少三组分散的不共线点

注意：**本文件不提供或猜测实际 B15 的 anchor 坐标**。锚点应从私有 PDF 渲染图与同页 Docling provenance 实际证据中独立生成，不能将 Docling 自己的预测框简单变换后当作独立视觉真值，否则会形成循环验证。用户不需逐条人工审批，AI 视觉标注可作为 L2 provisional，但没有独立可核验证据不得启动空间 match。

## 执行入口与局限
原 Windows `ebook_windows_docling_real.py` 自动检测 sidecar。如果参考缺失，继续报告 `PRIVATE_REFERENCE_UNAVAILABLE`；若有参考但无校准，B15 继续报告 `ROTATED_DISPLAY_TRANSFORM_UNVERIFIED`；只有校准契约通过，才会报告 `PROVISIONAL_SPATIAL_OVERLAP_ONLY` 或 `NO_SPATIAL_MATCH_UNVERIFIED`。

也可以通过 `ebook_roi_rotation_contract.py` 的 private-root/reference/candidate/calibration/output 五参数在 D 盘私有目录离线运行。标准输出只有状态，不输出书籍图像或坐标。其目的为**真实证据准备与空间门禁**，不是图表识别算法选型；`graph_semantics=UNVERIFIED`、`certified_graph_f1=null` 不变。

CI 中只用完全虚构的坐标做合成测试，检查数学转换及安全性质；**没有跑真实 B15/B31 空间正确率测试**。相关真实图表含义（坐标轴、柱形、方向箭头、关键数值）必须另行建立独立语义真值。
