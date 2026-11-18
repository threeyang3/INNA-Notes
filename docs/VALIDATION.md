# 0.1.0 本地验证记录

验证日期：2026-11-18。基线为 `main` 的 `b74c50083731c356592d387f92351d604e490b14`，实现分支为 `feat/iina-video-notes`。

## 已实际执行

环境为 Linux、Node.js v24.22.3，没有运行真实 IINA 或 Obsidian。项目开发脚本要求 Node.js ≥20；本轮实际运行版本为上述 v24，不把其他 Node 版本标为已实测。

```sh
node scripts/build.js
node scripts/check.js
node --test --test-reporter=tap test/*.test.js
git diff --check
node scripts/package.js
```

- **158 项测试通过，0 失败、0 跳过**，包括参数化子用例，共 111 个顶层测试项。
- `dist/main.js` 由 8 个本地模块生成，构建一致性检查通过。
- 声明、权限、引用资源、源码/前端/构建脚本语法检查通过。
- 实际 bundle 在不提供 `require`、`process`、`Buffer`、`window`、`document`、`fetch` 的 VM 中，使用模拟 IINA API 成功初始化。
- 仓库没有 GitHub Actions 工作流，本轮没有运行 GitHub CI。
- `.iinaplgz` 使用明确白名单打包，顶层直接包含 `Info.json`；包内不包含测试、构建脚本、源码目录或 Git 元数据。归档完整性与清单在交付前检查，SHA-256 随包提供。

## 测试证明了什么

| 位置 | 实际覆盖 |
| --- | --- |
| `test/capture.test.js` | 本地来源、暂停/播放、毫秒、未知时长、真实日期格式、切换/空状态拒绝、Unicode 与字面百分号路径 |
| `test/protocol.test.js` | 扁平 YAML、标准图片引用、正文保留、路径隐私、字段校验、不伪造来源与时长 |
| `test/png.test.js` | PNG 签名、IHDR/部分 CRC、块边界、非空 IDAT、终止 IEND、尺寸/文件大小限制、截断与 base64 |
| `test/native.test.js` | 正式 IINA 适配签名的模拟、目录边界/符号链接、`cp -n` 不覆盖、二进制复制与分块逐字节核验、受限临时清理、预览失败隔离 |
| `test/storage.test.js` | 图先发布/Markdown 后发布、图片或 Markdown 回执丢失、同 ID 重试、已有内容冲突、多窗口所有权、保存中禁止接管、改存前核对原提交点 |
| `test/service.test.js` | 快捷操作到最终 Markdown/真实 PNG 字节的模拟闭环；独立使用、多播放器、暂停所有权、重复动作、UI 重载、截图超时、切换/跳转失效、草稿恢复、保存中关窗 |
| `test/ui.test.js` | 安全消息编码、文字不被普通状态刷新覆盖、同 ID 新编辑会话刷新、旧 token 拒绝配合、预览增量更新、显式文字保存与改存 |
| `test/timers.test.js` | 原生 timer 回调自清理、等待取消结算、只读句柄在取消时关闭 |
| `test/build.test.js` | 静态 CommonJS 打包、外部/动态依赖拒绝、缓存和真实入口的无 Node 环境启动 |

模拟截图由测试代码生成真实 PNG 字节；并未用真实 MKV/MP4/MOV 解码。路径和扩展名场景验证的是插件逻辑，不能据此宣称某个视频编码器、HDR 格式或 IINA 视频输出已通过。

## 复审中修正的关键问题

1. IINA v1.5.0 `core.status.url` 已百分号解码，来源以实际 mpv 文件路径建立 URI，避免破坏 `%20` 等字面文件名。
2. WebView 原生消息桥有模板字面量拼接风险，完整消息统一编码，用户文字不插入可执行脚本。
3. `loadFile()` 会清除监听器，按正确顺序注册一次，页面重载只交换状态。
4. 关窗后的 PlayerCore 可被复用；普通关窗保留闲置事件监听，停止窗口观察，待确认截图结束，有限导出可以完成。旧导出不释放新笔记的暂停权限。
5. 使用编辑 token 防止同一捕获被重新接管后，旧正文或迟到动作回写；预览生成期间防止旧截图与新重拍交错。
6. 文件发布不覆盖既有内容，失败保留同一 ID。更换失败草稿目标必须显式操作，并确认原目录尚未发布 Markdown；原目录不可读时不猜测。
7. 大图搬运经官方 `utils.exec` 调用系统二进制 `cp -n`，避免 IINA 1.5 旧 `FileHandle.write` 的原生异常边界与逐字节写入开销；图片核验使用只读 `file.handle`。

官方代码依据见 [API 核查](API_AUDIT.md)。

## 未执行，必须在 Mac 上验收

以下全部仍为**待验收**：官方 CLI 真正打包/链接、IINA 实际安装与启用、macOS TCC 权限、系统文件选择器、WKWebView 外观/焦点/暗亮主题、快捷键冲突、全屏和多窗口操作、字幕合成、HDR/色调映射/高位深/4K/8K 原图、视频帧与毫秒位置偏差、APFS/HFS+ 实际发布、磁盘满/卷卸载等原生故障，以及 Obsidian 实际图片渲染。

测试中模拟的文件系统与 WebView DOM 不能替代这些环境。最终最重要的实机检查仍是：

> 打开本地视频 → 快捷键 → 画面与时间位置 → 输入文字 → 保存 → 在 Obsidian 看见正确图片、正文与来源。

使用 [Mac 验收清单](MAC_ACCEPTANCE.md) 记录结果，不将本文件中的本地通过状态直接复制成真机通过。
