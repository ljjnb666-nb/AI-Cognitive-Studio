# B15/B03 离线原图工作台：真实 Microsoft Edge 浏览器验收

## 来源与目标

上游 [Draft #163](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/pull/163) HEAD `4223b5cdced46a23afca4f410910ea441afb9ca8` 在 Windows owner-only 上成功冻结并独立复核了两张原图的中文 HTML 工作台。此前测试确认 HTML 文件、来源 SHA 和无批准草稿协议成立，但**没有操作真实 Edge**。

本阶段只补最后缺口：**使用自托管 Windows 上已经安装的微软 Edge 的真实 Chromium 渲染/DOM/文件协议环境**，检查该私有 HTML 的真实交互；禁止任何 pip/npm/browser/模型下载或对原件写入。

## 测试方式

新 `ebook_blind_review_edge_real_smoke.py`：

1. 通过 v10 `audit-only` 核验 v9 源图 SHA/空白审核表、已冻结的工作台 HTML 和五本三引擎历史回执；验证 HTML SHA 以及 B15、B03 两张本地 PNG 的原始 SHA。
2. 只查找本机已安装的 `msedge.exe`，不使用其它浏览器冒充 Edge。为避免修改用户本人的 Edge 登录状态/缓存，使用临时私有 profile。
3. 在 D: 私有 `blind_source_review_v9` 下创建临时测试目录，复制两张原图，并将浏览器测试脚本注入**测试专用的临时 HTML 副本**；冻结的 v10 正式 HTML 始终逐字节不变。
4. 通过 Edge `--headless=new --dump-dom --virtual-time-budget=15000` 访问临时文件 URL，真实验证：
   - B15 p109 R3C2 默认图片已解码（naturalWidth/naturalHeight 均非零）；
   - 缩放滑块到 170% 后页面显示与图片宽度响应；
   - 点击 B03 时全页图片真实解码、被选按钮和路径正确；
   - 输入测试用的机密占位草稿，点击**本地导出**并在测试专用 HTML 中拦截最终 `<a download>` 的物理写盘（防止测试占位文字落入 Windows 默认 Downloads 文件夹），校验浏览器生成的 JSON Blob 包含 `DRAFT_UNVERIFIED`、B03 p67 FULL 及 `reviewer_approval=null`、`independent_reference_verified=false`、`cer=null`；
   - 切回 B15 时图片重新加载，跨页输入框与分类清空，不发生串页。
5. Edge 设置禁用后台联网、禁扩展、禁同步和本地不可用 HTTP 代理；HTML 自身 CSP `connect-src 'none'`。这证明**脚本没有设计任何网络连接**，但没有抓包证明系统级零 TCP 包；日志必须如实区分。
6. `--dump-dom` 内容可能包含私有 SHA 与测试占位文字，**严格禁止打印、上传 GitHub、写入公开 artifact 或打印详细错误**；Python 只接受不带文字的 `data-acs-edge-real="PASS"` 和 `data-acs-edge-tests="5"` 两个白名单结果，否则严格失败。所有临时 HTML/PNG/profile 在私有 D: 测试目录结束后自动清除。
7. Windows runner 无 Edge、Edge 返回非 0、原图 SHA 漂移、浏览器 DOM 错误、超时，专项 CI 必须 FAIL；不能拿 5/5 synthetic、HTML 生成或静态检查代替真实 Edge 通过。
8. 仍需本 PR 准确 HEAD 的新 6 项合成回归、旧 71 项以及完整主 CI，Windows Owner-only 确认**实际 Edge 执行**才能声称浏览器验收完成。

## 仍未解决的真实 OCR 准确率任务

Edge 能看图片与下载草稿，**不等于原图已经被独立查看转录、审核或生成可信 gold**。本阶段不执行 OCR，不生成真实转录，不计算 CER；用户/审核者后续人工或独立证据审核须另建来源准入记录。B15 局部范围的文字和整页 OCR 不能直接混算 CER。 [Issue #161](https://github.com/ljjnb666-nb/AI-Cognitive-Studio/issues/161) 仍保持 OPEN；所有 PR Draft/Open/Unmerged，未经授权不得合并。

**验收边界**：浏览器自动测试验证真实按钮事件与浏览器生成的 JSON Blob，不验证实际操作系统“另存为”对话框或用户下载目录写盘；该末端保存行为仍是未覆盖的手工/受控 E2E 项目，不能声称完整文件下载交互已实测。另不擅自调用用户本机 Edge 正常 profile。
