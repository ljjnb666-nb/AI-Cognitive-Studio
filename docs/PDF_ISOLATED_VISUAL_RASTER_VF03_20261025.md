# VF03｜可信 PDF 来源页隔离渲染 + 不可变存储接线（显式调用，非生产自动化）

## 为什么需要

- VF01（#175）证实：原生文字可成功提取，但同页源图像不一定进入 canonical IMAGE Block。
- VF02（#176）提供租户隔离、原子写一次、内容寻址 PNG 存储与读回验证，已通过真实 MinIO 门禁，但此前需要外部调用方自行提供 PNG 与所声称的原 PDF SHA。
- VF03 连接两者：从**本次传入的 PDF 原始字节**计算 SHA，要求与调用者给定的已知源 SHA 完全相等，再从该 PDF 的指定 **0-based 物理页**渲染一个 PNG，并交由 VF02 的只写一次接口保存。

## 具体实现

1. `packages/ingestion/src/pdf-visual-raster-child.mjs` 是独立 Node 子进程，运行 PDF.js + 锁定版本的本地 Native Canvas，只渲染一个明确页号。禁止 PDF.js 代码求值，且有限制：PDF 输入不超过 32 MiB，物理页小于 2000，渲染倍率 0.8–1.5，像素上限 400 万，PNG 上限 8 MiB。
2. `renderAndStorePdfSourcePage` 先检查 SHA 和 `%PDF-` 头、复制输入并在私有临时目录保存，启动子进程（192 MB V8 heap、30 秒超时、stdout/stderr 关闭），校验 PNG 内容后调用 VF02 的服务器原子条件存储，并于成功或失败后清理临时文件。
3. 由于用户书籍原文、临时路径和错误堆栈可能敏感，主/子进程均不打印 PDF 文字、源页图、目录或源 SHA；失败统一稳定错误码。子进程不调用 OCR、LLM、视觉 API 或云端服务。
4. `packages/ingestion/tests/pdf-visual-raster.test.ts` 用 **PDFKit 自生成的两页图文 PDF** 验证真实 PDF.js 子进程、不同物理页独立地址、同页重放的不可变结果、源 SHA 不匹配、越界/损坏 PDF 和异常脱敏。不使用 B03/B15 任何版权内容。

## 权威与生产边界

- 新接口只在代码级**显式调用**，未被生产 `runPdfExtraction`、ingestion worker、quality gate、outbox、DB、租户权限验证或播客/短视频流程调用。
- PDF 传入来源真实性仍由上游的已授权、不可变源对象和 `expectedOriginalPdfSha256` 负责；光是 SHA 一致不说明上传者权限正确，不说明原书图表全部可靠解析。
- 只证明特定 PDF 物理页有一个经过统一进程渲染和字节存储的图像。Receipt 的 `sourcePdfToPageImageVerified` 仍为 false（尚无独立渲染对照）、`imageToTextAnchorsVerified`、`figureSemanticsVerified`、`independentImageGoldAvailable` 仍为 false。
- 不能把整张页面 PNG 自动当作裁剪图、原始内嵌图片或结构化图表；也不能直接送给模型生成播客事实陈述。不能宣称旧书已补数据或现有质量门禁已经保护了全部图文。

## 后续最小切片

先完成 VF03 完整 CI 后，再以独立 PR 添加租户权限检查、源对象读取、资源门控（优先受限作业）、可恢复 outbox、lease fencing、idempotency 和 image↔text anchor schema，另行决定什么情况下触发生成。进入正式引擎路由需要 Issue #161 的跨引擎独立参考、CER 和图例/曲线对账。

保持 Draft/Open/Unmerged，未经用户明确授权不合并。
