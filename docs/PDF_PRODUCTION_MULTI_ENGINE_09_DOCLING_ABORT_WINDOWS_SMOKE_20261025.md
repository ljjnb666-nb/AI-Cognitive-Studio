# PDF 新识别框架｜Docling 租约丢失主动取消 + Windows 离线实机门禁

日期：2026-10-25。承接 #193（真实 Redis、PostgreSQL、MinIO + 模拟识别器 E2E 已通过准确 HEAD CI）。

## 新增防线

此前 PostgreSQL owner token、sidecar 写入事务和 heartbeat 可以**防止失效 owner 写入数据库**，但失联后本地 Python 可能仍然继续跑至超时，占用 CPU 和 RAM。

本切片让 `withDoclingClaimHeartbeat()` 的续期失败回调主动 abort，向 `inspectAndPersistDoclingLayoutSidecar()`、`DoclingLayoutHandle.inspect()` 和 Python bounded spawn 传递取消信号。原始源字节读取仍受尺寸上限，模型输出仍须经过 owner token、数据库租约、内容哈希和非权威 sidecar 校验。取消不能将 Docling 晋升为 OCR Gold、不能改变 canonical extraction。跨主机只能取消**本机 owner 子进程**，不声称可以远程终止未知主机进程。

## 验收

- 确定性测试：续期返回 false 时调用 onLost，模型收到 abort 并返回后仍拒绝成功；模型接收 caller signal 时能中止 bounded 子进程，已经 abort 的请求不会调用模型。
- 新 PR 的全部静态、单测、真实 PG/Redis/MinIO 集成测试必须通过准确 HEAD CI。
- Windows real-Docling smoke 原先只对 #187 运行，本切片把**作者和仓库校验保持原样**，新增指定分支的精确放行；使用现有 private Windows Runner 上 Docling 2.141.0 的离线 artifacts，真实执行第二物理页并拒绝第一页泄漏。只用合成 PDF，不读取私有书本。
- 本 smoke **不是** Windows 单机的真实 Docling + PG + Redis + S3 同进程整链；后续仍需在已确认基础设施的 Windows runner 上做同源整链、再开始候选路由质量评测。Issue #161 继续 OPEN。

生产开关 `DOCLING_LAYOUT_ENABLED=false`、全部 PR Draft / Unmerged，未经授权不合并。
