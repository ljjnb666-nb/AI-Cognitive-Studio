# PDF 生产智能识别｜阶段二第一切片：RapidOCR 本地执行器

## 从 Benchmark 转向生产开发

现有五书样本已让 RapidOCR 3.9.2、MinerU Basic 4.0.3、Docling Standard + RapidOCR 实际处理过相同 PDF 物理页，但尚无独立 gold CER 排名。当前开发路线以原生文字优先、扫描页 RapidOCR、复杂版面 Docling/MinerU 候选、疑难局部视觉为目标。本 PR 直接修改 ingestion 与正式 Worker，不再添加私有 Benchmark 工作台。

## 已有生产不变量

- 复用 PDF.js isolated child 的真实 PDF 原生文本与每页证据，以及 TEXT/NON_TEXT_CONTENT/EMPTY 分类，路由物理页从 0 开始。
- 复用 pdf-run 的 page OCR durable attempt、租约/claim/generation、重试上限、tenant scoped hash-addressed 结果存储和质量发布门禁。
- 原 mineru provider 保留；无 OCR 配置时行为不变。

## 新增能力

- 仅显式 OCR_PROVIDER=rapidocr 启用。RAPIDOCR_PYTHON_PATH 必须绝对且存在，单 Worker concurrency=1；RapidOCR/MinerU 配置混用或超出超时/结果预算在启动时拒绝。
- 本机 Python 先 probe 验证 rapidocr==3.9.2、onnxruntime==1.22.1 以及 det/rec 本地 ONNX 模型。模型文件内容 SHA-256 汇总指纹作为真实 provenance，不允许用环境声明版本冒充。
- 一个 OCR_REQUIRED 物理页对应一次 Python 子进程：临时 PDF → PyMuPDF 1.6x 来源渲染 → RapidOCR BGR 推理 → 单条严格 JSON 文本输出。原始文件和 OCR 文本不进日志，stdout/stderr 有 cap，子进程有 deadline、离线代理、2 CPU 线程及像素上限，无 shell。
- Node 端只接受严格 SUCCEEDED + string；无内容不算成功。超时树真正已停时才交给既有 durable 失败预算处理，树终止未知时 terminal fail-closed，避免默认重复调用。
- 只有 MinerU provider 启动持久化服务器历史重对账，RapidOCR 不伪造 MinerU server identity。

## 验证

新增单测覆盖配置孤儿变量、真实探针版本与权重指纹、精确 physicalPageIndex、进程输入字节、临时目录清理、伪成功、NUL、额外协议字段、超时终止不确定和非法页号。需要准确 HEAD CI + 真实已安装 RapidOCR Windows 环境的合成 PDF smoke，随后才可开启受控用户 PDF 集成试验。

## 明确尚未实现

这一切片暂未把 Docling 的章节表格/图表结构结果融合进正式 DocumentExtraction，也没有多引擎同请求自动重试及 GLM 语义裁决。后续继续开发 Docling 结构层与 MinerU 按需备用路由，而不是把当前 adapter 宣称为已完成的全链路。五书 gold 仍 0/5、CER=null，既有 #161 OPEN；未经用户明确授权不得合并 Draft PR。
