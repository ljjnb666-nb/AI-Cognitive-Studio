# B03 原书身份与物理页只读核验

本阶段只在 Windows 私有数据目录识别 B03 原始 PDF，并核查来源 SHA256、总物理页数和第 67 页可否渲染。**不执行 OCR/模型、不安装依赖、不上传私有原书。**

- 脚本路径：tools/private-pdf-review/verify_b03_source_readonly.py。
- 默认只扫描 D:\ai-cognitive-pdf-benchmark-data；可用 --root 指定经过确认的私有原书根目录。
- 固定 B03 文件长度 151,495,200 字节和已归档的完整 SHA256；不按猜测书名推断身份。拒绝多份完全匹配、超宽扫描、软链接及 Windows Junction/reparse 路径。
- 使用 4 MiB 流式 SHA；若本机预装 PyMuPDF (fitz)，验证总页数 271 和第 67 页小尺寸渲染，最长边限制 768 像素。不会导出像素或扫描内容。
- 输出固定的 ACS_B03_PRIVATE_SOURCE_PROOF JSON，只包含安全枚举与 PASS/NOT_VERIFIED；**不输出私有路径、书名、原文、图片或任意异常内容**。
- 即使完整 PDF SHA 和第 67 页渲染均成功，仍不能证明此前上传的 Library 单张 PNG 与当前 PDF 密码学同源。uploaded_library_png_identity 始终为 NOT_ATTESTED。
- 完全验证 PASS 返回退出码 0；任何缺库、未测、找不到或校验失败均返回 2。
- GitHub CI 只用合成字节运行 unittest，不在 self-hosted Windows Runner 读取私有材料。未经代码审查，不能让 PR head 在 Windows Runner 自动执行。

## Windows PowerShell 示例（须先审查并同步受信任脚本）

    python -I -B .\tools\private-pdf-review\verify_b03_source_readonly.py --root D:\ai-cognitive-pdf-benchmark-data

如原书不在默认数据根目录，工具只报 B03_SHA_NOT_FOUND；不要为了测试绿灯篡改期待 SHA。

本轮的 Windows SHA、271页及页面渲染**尚未实际执行**，上传 Library PNG 的同源性、全页 Gold/CER 和生产验收仍为未验证。