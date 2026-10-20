# PDF-FIGURE-EVIDENCE-01：MinerU 图片引用持久化

本切片只改变隔离的 PDF Benchmark，不修改正式生产导入/解析或播客生成链路。原书、OCR 文本、图片和模型都保留在 D 盘私有目录；禁止上传 GitHub 仓库、Actions Artifacts 或日志。

## 已确认事实

- 真正的 MinerU 4.0.3 六页运行 #39440805765 执行成功；6/6 页码标记有效。
- Markdown 有 6 条 doc:sha-prefix/tier:flash/page:N/block:M 图像引用，但报告目录中无对应独立图片。
- 只有引用不能证明完整图形、箭头或流程关系已还原。

## 脚本功能

python/mineru_figure_evidence.py：

1. 输入仅允许 RB-PDF-12、RB-PDF-13 和符合约定的本地 real-mineru run ID。
2. 同时核验原书 PDF 与对应三页子集的 manifest、SHA-256、大小、页码映射，拒绝改书与混版。
3. 校验 MinerU 页码序列、图像 blockRef、文档 SHA 前缀、tier、所在页与重复引用；从不把 doc: 当作 URL 或文件路径。
4. 使用已安装的 pypdfium2 渲染**带图像引用的完整 PDF 页**为 PNG，并在新的同一 run 目录下保存。不是精确图框裁剪。
5. 保存 figure-evidence.json：原书页码、源 SHA、Markdown SHA、PNG SHA、字节数、像素大小、该页关联的 figure refs。
6. 明确设置 figureRegionBounds=null、diagramEdges=null、graphSemantics=NOT_VERIFIED，绝不凭 OCR 字词捏造箭头/时序关系。
7. 独立新目录和 staging 原子提交，不覆盖既有报告。stdout 只输出脱敏状态、数量，不包含原书、OCR 正文或文件完整路径。

Windows 预检 #39444666485 已确认 MinerU Python 环境安装了 pypdfium2、Pillow，以及本地 pdftoppm。无需下载新依赖或模型。

## 执行示例

由受信任且固定 SHA 的脚本在 Windows Runner 上执行，而不是从有 19 项未提交改动的原工作树直接执行：

    D:\ai-cognitive-pdf-benchmark-data\python\mineru\Scripts\python.exe -I -B python\mineru_figure_evidence.py --fixture RB-PDF-12 --source-run real-mineru-39440805765-1

RB-PDF-13 同样执行一次。PNG 保留在 D 盘的原报告目录下。不上传原书。

## 验收

- PAGE_VISUAL_FALLBACK_PERSISTED：私有整页 PNG 已保存并与源页、图像 blockRef 关联。
- GRAPH_SEMANTICS_NOT_VERIFIED：图节点、边、箭头方向、时间顺序仍未证明。
- 生产解析器替换与内容生成自动化：本切片不批准；下一切片需要独立视觉模型或人工证据恢复结构并核验来源。

GitHub 云端 CI 只运行合成单元测试；真实 Windows PNG 持久化必须单独取得脱敏本机证据。
