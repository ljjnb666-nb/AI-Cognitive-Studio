# PDF-FIGURE-STRUCTURE-03D｜P127 自动导入与私有草稿自动保存

## 阶段和安全状态

本切片在 Draft PR #100 内新增 P127 单图「打开即加载」审阅流程。**仅限已经产生真实 GLM 输出的 RB-PDF-13 原书物理页 P127 / page-002-region-01 / r02**，不枚举整盘、不替用户点击人工审核、不申请新的 GLM 调用、不把机器候选升格为标准答案。后续批量书页需要独立设计 registry、授权与回归。

与 03C 的“本地手动选择三个文件”并存；后者仍保留作为离线应急备用。默认服务未启用私有读取能力；只有用户在 **Windows 本机**显式选择 `--auto-import-p127` 才开启固定 P127 的回环端点。

## 启动方法（需本机工作区已同步至含 03D 的精确版本）

在对应已经审查且安全同步的 PDF Benchmark worktree 执行：

```powershell
cd "D:\所有项目\90_Worktrees\AI-Cognitive-Studio-pdf-parser-benchmark\tools\pdf-parser-benchmark"
node scripts/serve_gt_annotation.mjs --auto-import-p127
```

Windows 终端会显示 `ACS_P127_GRAPH_REVIEW_LOCAL_URL=http://127.0.0.1:<动态端口>/graph-review.html#review-token=<一次性本机凭据>`。**仅在本机 Edge 打开这个完整地址**。随机端口和临时凭据每次启动均变化，不能提前编造地址；不要截图、转发、粘贴完整带 token 的 URL 到聊天或仓库。关闭终端后本机 HTTP 服务停止。

进入页面后自动执行：

1. 本机读取精确三个固定路径：`reports/real-mineru-39440805765-1` 下 `glm-cloud-v1-RB-PDF-13-page-002-region-01-retry-p127-r02-20261021/cloud-vision-proposals.json`、`region-proposals-v1-RB-PDF-13/region-proposals.json` 及 `region-proposals-v1-RB-PDF-13/crops/page-002-region-01.png`。
2. 本地服务检查受控文件路径、symlink、最大体积、SHA 与历史模型证据的合法 schema、身份、物理页码、未审核权限、节点和箭头映射。
3. 浏览器重新计算三份**原始字节**的 SHA，并独立验证 PNG 解码/尺寸、来源及几何关系。不加载任何未通过核验的图节点。
4. 显示所有节点、线段和候选尖端；恢复属于**完全相同输出 SHA** 的旧草稿；如果没有草稿，则创建全部 `UNREVIEWED` 的新草稿。
5. 审阅者只需逐条检查与原图是否一致。修改后会短暂延迟自动保存在 **D 盘原报告目录**的 `private-reviews/P127-graph-review-r02-DRAFT-UNATTESTED.json`。保存使用 SHA 修订号作并发锁：两个标签页对同一版本同时改动时只能有一个获准，另一标签页明确提示冲突并停止自动保存，仍可手动导出自己的未保存草稿。

草稿不会自动变成 Ground Truth，即使全部标为 `VISIBLE_MATCH`。所有导出和保存结果维持 `REVIEW_DRAFT_UNATTESTED`、`humanVerified:false`、`graphVerified:false`。保存成功须看页面提示；直接关闭标签页可能导致最后不足 450ms 的输入未落盘，必须看见“已保存到本机 D 盘”再退出。

## 受控接口与威胁边界

- 只存在 `GET /api/private-graph/p127/bundle`、`GET /api/private-graph/p127/draft`、`PUT /api/private-graph/p127/draft`。其他任意路径、上传、列表、任意文件下载、CSV、PDF、网络模型调用不存在。
- 只有本机 `127.0.0.1` 的准确 Host、临时 64 位十六进制 token、可接受的 Origin / Fetch-Site 才被允许访问。token 放在浏览器 fragment 中，页面脚本以单独 Header 传给同源服务，禁止跨站读取。静态 GT 页保留 `connect-src 'none'`，图审阅页仅允许 `connect-src 'self'`；响应 `no-store`，无 CORS 放行。
- 服务端响应包含选定三份**私人证据**的 base64 字节，只会发给拥有本机会话凭据的同源浏览器。不要截取或粘贴响应；该桥接设计有意将证据保存在本机私有边界内。攻击者如果取得本机终端 URL/token 或运行了具备本机读盘权限的恶意进程，就可能访问这些内容；这不是 Windows 文件权限隔离的替代品。
- 审阅写入固定未认证草稿路径，且只允许遵守 P127 来源、身份、未验证状态及节点边 ID 的 JSON，最大 100KB。使用文件同步、随机临时文件与 rename，拒绝已有坏草稿、链接和来源变更。服务内对该路径执行串行 CAS；**跨多个独立服务实例未承诺分布式锁**，请只运行一个审阅服务器。
- Windows 项目数据根：`D:\ai-cognitive-pdf-benchmark-data`；无 GitHub Actions 上传私有结果、无第三方追踪、无 API Key。普通（不带 flag）启动时，所有 `/api/private-graph/` 请求返回 `PRIVATE_IMPORT_DISABLED`。
- 这里的 SHA 校验是本地**已存在材料之间的完整性与对应关系**门禁，不是原始纸质出版物或人类语义真值证明，也不代替真正独立人工审阅。

## 验收矩阵

- 合成：固定路径三文件加载、 SHA 错误拒绝、软链接阻断、只读默认关闭、无 token/错 Host/恶意 Origin/跨站拒绝、草稿创建/恢复/伪装认证阻断、双并发冲突、固定路由限定、仅 P127 浏览器 CSP 放行。
- 完整主 CI：以 **准确 HEAD** 的成功结论为准，不用旧运行替代新运行。
- 实机：仍需可信 Windows Edge 打开上方 URL，核对 9 个候选节点/10 条候选关系确实加载，修改第一项并等待显示“已保存到本机 D 盘”，刷新后确认恢复。这个过程需用户在本机真实执行或使用明确授权的浏览器控制；**不能用云 CI 或 synthetic Node 测试冒充实机**。
- **尚未完成**：第二名人工复核、箭头方向逐条语义验收、准确率计算、正式 Ground Truth 或播客发布。
