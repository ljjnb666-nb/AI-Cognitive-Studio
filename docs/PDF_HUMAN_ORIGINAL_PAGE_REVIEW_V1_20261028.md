# PDF 原始物理页与模型图结构人工核验 v1

2026-10-28 · Draft · 基于 #211 继续，不开启生产自动识别，不等于已完成独立 Gold。

## 用户可用的路径

在 `/studio/library/[sourceDocumentId]/review?page=N` 打开有模型图候选的物理页：

- 左侧新增通过同工作区登录鉴权的**原始 PDF**内嵌浏览器查看器，使用浏览器 `#page=N+1` 定位物理页。失败或浏览器不支持嵌入时提供新标签页查看链接。PDF 全量数据必须先在服务端确认对象长度、文件头和 SHA256，再返回浏览器。没有共享签名 URL 或公开 PDF 地址。
- 同页展示先前 #210 保存的节点、边、方向、bbox、图表说明，全部仍被标记为模型候选。原文区块仍在页面上，候选来源 SHA/解析 run/页号/24h 过期判定保持不变。
- 已获 OWNER/EDITOR 权限的审核者勾选「我已实际对照原始 PDF」，然后可点击「确认图结构与原页一致」或「驳回」。确认仅表示**本次结构核对**，**不能用于事实级 Gold 或播客发布**。
- 如果认为结论错误，可明确「撤回本次结论」，随后再作新决定。每次操作写入 append-only `PdfVisualHumanReviewEvent`，保存审核人、原书 SHA、原候选指纹和时间；不覆盖旧结论。
- POST 采用双重用户身份与工作区检查、同源请求、严格输入 schema、原书与当前 extraction/run/SHA 绑定、候选未过期、候选 JSON 指纹校验，针对候选加 PostgreSQL 事务锁及 `previousEventId` 冲突保护。权限撤销或并发旧审核提交 fail-closed。
- 不修改 `SourceBlock`、`BookIntelligence`、播客素材、原有 Worker 路由及 Gold/CER。

## 隐私和限制

原始 PDF 本身不额外持久化。在线预览为了**先完成 SHA 校验再释放私有字节**，需要暂时在 Web Worker 内聚合完整 PDF（最大 110MB）；大 PDF 加载慢且会增加服务内存开销，不支持 HTTP Range。暂未有独立文件预览频率限额。**不可据此宣布生产性能验收。**

PDF 内嵌查看依赖浏览器本地 PDF viewer；Chromium 的真实登录、图表核对与审核按钮交互已新增专用 Playwright E2E（实际是否通过需按准确 HEAD CI 结果确认）；不同浏览器未 E2E 兼容测试，`#page` 跳转并非由后端渲染引擎保证。人工确认也无法自动证明审核者实际查看内容，因此需要后续审计与正式评测。这一切片不做自动内容修正、不做事实引用升权、真实私有五书 Gold/CER 和付费模型精度声明。

## 验收退出

新增源 PDF 大小/SHA/替换检测、人工核验状态机和真实 PostgreSQL 追加事件/角色变更/过期/冲突测试，准确 HEAD 专项 CI 与主 CI 独立确认；不在同 PR 增加新解析器或人工质量评测基础设施。所有 PR 保持 Draft，未经用户授权不合并。Issue #161 OPEN，生产 UNVERIFIED，Docling 生产 OFF。

## 新增真实浏览器验收（2026-10-28）

沿用原来的 `pdf-human-review-original-source.yml`，没有再开单独 Benchmark/工作流。安装 Playwright Chromium，通过 `playwright.pdf-human-browser.config.ts` 启动本仓库真实 Next.js，在真实 PostgreSQL 17 和 MinIO 上测试：

- 从注册页新建真实 Better Auth 测试账号，再创建一份**代码生成的两页合成 PDF**、SourceDocument、CurrentDocumentExtraction 和来源区块。
- 仅把测试图结构候选入库，**不调用任何付费 Provider**。在物理第 2 页验证图文展示、原始 PDF iframe 指向 `#page=2`、后台原书 SHA 和浏览器认证请求返回的 PDF SHA 一致。
- 未登录浏览器对 PDF 请求必须 404；授权浏览器执行确认 → 撤回 → 驳回三次真实按钮点击并验证 PostgreSQL 不可变事件、候选未变和无播客生成。
- 将本人降级为 VIEWER 后刷新页面，必须阻止新增审核结论。
- 浏览器截图和失败 trace 仅来自合成测试 PDF；绝不上传用户私有电子书截图。
- **明确不覆盖**：Chrome 内嵌 PDF 插件的实际像素是否正确、Edge 和移动端兼容、真实付费模型输出精度、实际私有书页、100MB+ 大 PDF 的性能。这些仍待真实设备验证。



## 大 PDF 原书分段预览补强（2026-10-28）

发现实际原书 B03 约 151,495,200 字节，超过旧版 `source-pdf` 预览上限 110,000,000 字节。旧实现会将 PDF 全部聚合到 Web Heap，因此 B03 无法用于原页审核。

现同一 PR 将原书预览改成**先整本流式校验 SHA256、后条件 S3 GET、支持 HTTP Range 206 的浏览器原书读取**：

- 允许来源 PDF 大小最多 **512,000,000 字节**，每个 Range 响应最多 **8 MiB**。与浏览器 PDF viewer 的物理页导航配合，只按浏览器实际请求的偏移区间读取内容；**不是在服务端裁剪出单页新 PDF**。
- 第一次读取对当前源对象 `HEAD` 获取 `ContentLength` 和 `ETag`，先以 S3 `If-Match` 约束对象并逐块计算完整 SHA256；只有与受授权 `SourceDocument.sha256` 一致、PDF 头部有效才返回数据。仅缓存 5 分钟的校验 Promise 和 ETag 元数据（最多 32 条），**不缓存任何原书字节**。后续每一次 Range 读取继续使用 `If-Match`，拒绝后端对象版本变化和不符的 Content-Range / ETag / Length。
- 原生浏览器若不使用 Range，返回 HTTP 200 全量**边读边传**（不把整书读入 Web 内存），因而可能消耗完整文件网络流量。超过范围、跨段异常时返回 416，匿名和越权仍为 404，且原书响应 no-store。
- `getObjectRangeStream` 由既有 Storage S3 Provider 提供，S3 GET 使用原有私有服务端凭证，不发公开可复用预签名链接。
- 单测包括 **151.5 MB 流式 SHA 合成原书**（不在 Web heap 形成 151.5 MB 对象）、8 MiB 范围限制、尾段和非规范 Range、SHA 篡改、过期/尺寸不符、普通 GET 兼容；真实 MinIO + Chromium/Edge 浏览器测试验证 `206 Content-Range`、字节一致、`HEAD`、416 和未登录访问拦截。
- 这仍不是最终高并发生产级预览服务：首次需要完整读取校验全书，5 分钟后重复校验会增加 MinIO I/O；没有全局跨实例 ETag 校验缓存及下载速率/并发预算，没有 PDF 内嵌像素级截图断言。未做 B03 Windows Edge 实机或私有五书图结构准确率验证。

注意：**数据来源完整 SHA 是通过条件流式校验得到，S3 ETag 本身不是加密哈希，也不能单独取代 SHA 校验。** 若源对象具备相同 ETag 却被恶意篡改，必须依靠受信任的 S3 存储/对象防覆写控制；该设计不宣称抵御可任意伪造 ETag 的存储管理员攻击。

后续必须在真实私有 B03 及 Windows Edge 上测试 PDF 插件的随机访问效率、页面渲染、图框坐标和性能。现有合成 E2E、模拟图结构、未授权访问并不替代私有质量 Gold。


## 实书审核可用性补丁：无图表候选也能核对原始 PDF

此前原书 iframe 误放在 `visual ? ... : null` 条件之内，导致只有 OCR 文本、**尚未产生图表候选**的 PDF 页无法直接与私有原页对照。B03 第 67 物理页恰好需要核对文字、右侧竖排章节栏和装饰图；不应为了看原书而强迫执行付费视觉任务。

现只要拥有已授权、已完成当前提取记录的来源 PDF，就显示原始 PDF，与有没有视觉候选无关。原书响应仍经服务器来源 SHA/ETag 约束和工作区授权；浏览器页面不新建模型任务、不获得播客引用权限。页面新增按**1-based 物理页号**的直接跳转参数 `physicalPage`，从而可直接输入 67。保留既有 `page=66` 0-based URL 兼容；双重参数与越界数字拒绝访问。右栏模型候选仍独立显示缺席/过期状态。

Chromium/Edge 的真实 Next.js Playwright 回归新增：无候选第 1 物理页也有原书 iframe 和 OCR 区块；按页码输入 2 能切到第 2 物理页；原先确认→撤回→驳回、权限降级场景继续存在。

**注意：此修复证明用户无需付费候选即可打开原书，不意味着真实 B03 的整本 SHA/页 67 同源或原生 PDF 像素已核准。**


## B03 大文件入库入口修复（2026-10-28）

新发现的产品级门槛：旧 `/api/studio/upload` 和 Web 上传页面、`createIngestionService` 均限制上传 **100 MiB**，但 B03 原书 151,495,200 bytes（约 144.5 MiB）。即使此前原始 PDF Range 预览已支持 151MB，旧上传 API 仍会在获取上传会话时拒绝 B03。

现保持工作区身份与完整 SHA/尺寸一致性门禁：
- **PDF** 上传会话上限 **200 MiB (209,715,200 bytes)**；**其他文件**上限继续 **100 MiB (104,857,600 bytes)**。API schema、核心 Ingestion Service 的 create/complete 双关口、Worker 环境 `SOURCE_MAX_PDF_UPLOAD_BYTES`、示例配置、前端提示全部一致；既有 `SOURCE_MAX_UPLOAD_BYTES` 仍用于非 PDF。
- 浏览器仍通过预签名 S3 直传，不把 151.5MB 上传请求压给 Next.js 进程。完成阶段要核对存储对象真实字节数、逐块 SHA256、媒体格式，再创建原书存储与解析任务；**仅创建 UploadIntent 不会把缺字节 PDF 标记成成功**。
- 新增真实 PostgreSQL 约束测试：允许声明 151,495,200 bytes 的 PDF intent（测试不分配此体积字节），但拒绝超过 200MiB 的 PDF、同尺寸 EPUB、超过 100MiB 的 TXT；当 MinIO/fake object HEAD 声称 B03 尺寸、流却只有 5 bytes 时必须 fail-closed 且零 SourceDocument。
- 新增 Chromium/微软 Edge 真实登录 API 测试：确认 B03-size PDF 的 upload intent 允许、超限 EPUB/PDF 不允许；**绝不上传任何私有原书字节**。
- `inspectObjectStream` 在最多 64 KiB 的 sniff prefix 处从底层 S3 chunk 显式复制数据，避免 subarray 维持整个大 chunk 的底层 Buffer 生命周期。
- 尽管所有接口和意图测试若通过，可将该工程缺口视为修复，**不可宣称 B03 真 PDF 已完成浏览器直传、MinIO 200MiB 完整 Put/Copy、实际解析、Windows Edge 页图源身份或 Gold**。真实 151.5MB 上传的网络性能、超时、Worker RAM、OCR 容量仍须实机压测。
