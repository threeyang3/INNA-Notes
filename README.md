# IINA Video Notes

为 macOS 的 IINA 播放器采集**本地视频截图、播放位置与文字笔记**，独立保存为 Markdown 和 PNG。打开视频、按快捷键、写下感想、保存，即可在 Obsidian 中阅读；采集和保存不需要 Obsidian 或 MediaCore 运行。

项目名称使用播放器的正确拼写 **IINA**；GitHub 仓库地址沿用 `threeyang3/INNA-Notes`。

> **当前版本为 0.1.1。** 修复了插件启用后 IINA 冷启动时的菜单初始化崩溃。运行环境为 **IINA 1.5.x（最低 1.5.0）**。

## 一次笔记怎样完成

1. 在 IINA 中打开本地 MKV、MP4、MOV 等视频。
2. 在该播放器的「插件」菜单使用「创建视频笔记」，或按默认快捷键 **⌘⇧N**。
3. 插件固定此刻的视频来源、标题、整数毫秒位置、捕获日期和暂停状态，同时请求当前画面的 PNG 截图。
4. 在笔记窗口输入文字，按 **⌘↵** 或点击保存。
5. 到输出目录查看 Markdown。目录位于 Obsidian Vault 内时，直接打开该文件，正文中的相对路径会显示截图。

默认继续播放，视频向前播放不会改变已捕获的时间位置。可在设置中启用「开始笔记时自动暂停」。

| 想记录的内容 | 操作 |
| --- | --- |
| 截图与文字 | 保留「附上截图」，填写正文后保存 |
| 只有截图 | 保留「附上截图」，正文留空后保存 |
| 只有文字与时间位置 | 关闭「附上截图」，填写正文后保存 |

截图未完成时，可以继续写文字；插件不会把失败的截图悄悄丢掉后报告整条保存成功。仅文字保存是一个明确的用户选择。

## 安装与打包

### 从 GitHub 直接安装（推荐）

**不需要下载 ZIP、不需要克隆仓库，也不需要运行 Node.js。** 使用 **IINA 1.5.x**：

1. 打开 **IINA → 设置（Settings）→ 插件（Plugins）**。
2. 点击 **从 GitHub 安装（Install from GitHub）**。
3. 粘贴仓库地址 `https://github.com/threeyang3/INNA-Notes`，或仅输入 `threeyang3/INNA-Notes`。
4. 点击安装，核对并批准所需的本地文件权限，启用 **IINA Video Notes**。
5. 在 IINA 中打开本地视频，使用 **插件 → IINA Video Notes → 创建视频笔记**，或按 **⌘⇧N**。

插件名称是 **IINA Video Notes**；GitHub 仓库历史名称为 **INNA-Notes**，输入仓库地址时不要更改拼写。

本项目已将 `Info.json`、`dist/main.js` 和 `ui/` 运行资源直接提交在仓库根目录，IINA 无须在安装时构建。根据 IINA 1.5.0 源码，GitHub 安装先尝试最新 Release 内的 `.iinaplgz` 安装包；若没有合适的 Release 资源，则直接下载默认 `main` 分支。因此**一键安装不要求先创建 GitHub Release**。自动更新读取 `main/Info.json` 的 `ghVersion`；以后正式发布新版本应递增整数 `ghVersion`，并同步更新 `version`、已提交的构建产物及安装包。

IINA 1.5.0 已完成冷启动与视频笔记菜单的实机核验。其他原生场景的覆盖范围见 [验证记录](docs/VALIDATION.md) 和 [Mac 验收清单](docs/MAC_ACCEPTANCE.md)。

### 通过本地 `.iinaplgz` 安装（备用）

从 [GitHub Releases](https://github.com/threeyang3/INNA-Notes/releases/latest) 下载 `IINA-Video-Notes-0.1.1.iinaplgz` 后用 IINA 打开，也可以在插件设置里选择“安装本地插件”。发布页同时提供 `SHA256SUMS`。

官方安装机制见 [IINA：Creating Plugins](https://docs.iina.io/pages/creating-plugins.html)。

### 从源码构建

只需 **Node.js 20 或以上**。项目没有 npm 运行依赖或开发依赖，无须安装 React、数据库、服务端或额外的视频处理工具。Node 只用于本地构建和测试，不在 IINA 中运行。

```sh
git clone https://github.com/threeyang3/INNA-Notes.git
cd INNA-Notes


npm test
npm run build
npm run check
npm run package
```

`npm run package` 生成 `.iinaplgz`，文件位置以命令输出为准。构建后的 `dist/main.js` 随仓库提交，使安装端不必构建。也可以在 Mac 上使用官方 CLI：

仓库的 `packages/` 保留发布过的安装包及其 SHA-256。更新源码后，重新打包并核对发布包的版本和校验值。

```sh
npm run build
/Applications/IINA.app/Contents/MacOS/iina-plugin pack .
```

`.iinaplgz` 本质上是 ZIP；顶层应直接包含 `Info.json`，不能额外套一层仓库目录。最终分发包仍须经过真实 IINA 安装检查。

### 本地开发与调试

```sh
npm run build
/Applications/IINA.app/Contents/MacOS/iina-plugin link .
```

修改源码后重新构建，再重载插件或重新打开播放器，避免继续使用旧实例。结束开发时运行：

```sh
/Applications/IINA.app/Contents/MacOS/iina-plugin unlink .
```

出现问题时记录 IINA 版本、插件版本、播放器状态、面板报错及输出文件是否存在。路径、视频标题、草稿和截图可能包含私人信息，提交 issue 前去除不希望公开的内容。API 实现与文档差异见 [API 核查说明](docs/API_AUDIT.md)。

## 保存到哪里

### 默认独立目录

未选择 Obsidian 文件夹时，导出位于：

```text
@data/exports/IINA/
```

在已核对的 IINA v1.5.0 中，`@data/` 对应：

```text
~/Library/Application Support/com.colliderli.iina/plugins/.data/io.github.threeyang3.iina-video-notes/
```

「查看输出目录」可直接在 Finder 中找到结果。`@data/` 与插件包分开，不是临时目录。来源见 [API 核查：数据目录与卸载](docs/API_AUDIT.md#数据目录与卸载)。

### Obsidian Vault 收件箱

在笔记窗口「设置」中选择文件夹，例如 Vault 内的 `Video Captures/IINA`。**所选文件夹本身就是输出根目录**，不会再增加一层 `IINA`。

| 相对输出根的路径 | 用途 |
| --- | --- |
| `<capture-id>.md` | 完整笔记，含来源、时间位置与正文 |
| `assets/<capture-id>.png` | 此笔记引用的 PNG；无截图时省略 |
| `.iina-staging/*.pending` | 发布期间的暂存文件，消费端应忽略 |

建议使用 Mac 本地 APFS/HFS+ 卷上的目录或 Vault。当前发布方式要求目标文件系统支持**同卷硬链接**。exFAT、部分云盘挂载或虚拟文件系统不支持时，保存会失败并保留草稿，不退回到可能覆盖文件的写入方式。需要同步时，可让同步软件同步本地 Vault；仍需确认 Markdown 与图片都已到达其他设备。

改变默认目录不会迁移或删除旧记录。**已经建立发布计划的失败草稿仍绑定原目录**，以便在同一位置重试而不产生重复笔记；编辑器显示其绑定目录。需要重新授权时，通过设置再次选择原文件夹。

如果原目标不支持硬链接等功能，可以先在设置中选一个新目录，再回到草稿，明确点击保存位置旁的「改存当前目录」。插件必须确认旧目录可读，而且该 ID 的最终 Markdown 尚未发布，才更改此草稿的目标。改存保留原 ID、捕获时间、正文和截图，不搬迁或删除旧目录中的文件；它也不会自动保存，检查新位置后再点击保存。

**旧目录不可读或已经存在该 ID 的 Markdown 时，会拒绝改存**，因为无法排除重复发布。应先恢复原目录访问或检查原来的导出结果，不能通过切换目录绕开这项核对。

## 设置与权限

| 设置 | 默认行为 |
| --- | --- |
| 保存目录 | 插件数据目录；可通过系统选择器改为 Vault 收件箱 |
| 截图模式 | 包含字幕；可改为不含字幕 |
| 自动暂停 | 关闭，保持观看时的播放状态 |
| 创建笔记快捷键 | `Meta+Shift+n`，即 ⌘⇧N；可修改或留空仅使用菜单 |
| 导出完整本地路径 | 开启，便于后续回源和作品关联 |

快捷键保存后在当前播放器生效；其他已打开的播放器会在下一次使用本插件菜单时刷新。⌘↵ 用于面板内保存，Esc 用于保留草稿后关闭或返回上一页。

`Info.json` 只申请 `file-system`、`show-alert`、`show-osd`，分别用于本地文件操作、系统选择/提示和播放器反馈。不申请网络权限，不上传视频、截图或文字，不读取 MediaCore、Obsidian 或其他应用的账号与数据库。权限定义见 [IINA：Development Guide](https://docs.iina.io/pages/dev-guide.html)。

### 完整路径与隐私

默认的 `video_source_uri` 包含完整本地路径，可能暴露用户名、磁盘名和目录名；同步或分享 Markdown 时，这些信息也会一起传递。

关闭路径导出后，Markdown 省略 `video_source_uri`，写入 `video_source_redacted: true`，不填虚假的占位路径。消费端可能需要手动关联作品和视频。**本地恢复草稿仍保存真实路径**，因为重试与一致性检查需要它；该选项不负责清除本地草稿。

## 草稿、重试与播放状态

每个播放器有独立的当前笔记实例；草稿按捕获 ID 保存在 `@data/drafts/`，原始截图在 `@data/captures/`。多个窗口不共用一个 `draft.json`。

- 输入时持续保护草稿。点击「保留草稿并关闭」或直接关窗后，可从「草稿」入口继续；若提示草稿写入失败，应保持窗口并先复制正文。
- 当前草稿未关闭时，重复快捷键重新聚焦它，不把文字绑定到新位置。保留并关闭后，才能开始下一条捕获。
- 保存失败保留原 `capture_id`。相同 ID、不同内容的现有目标会报冲突，不静默覆盖。
- 重新截图要求**同一播放器实例、同一次视频加载、暂停于原捕获位置附近（±50 ms）**。不自动 seek、重载或用后来的画面冒充原位置。重启后可保存已有截图和文字，不能为旧时间点生成新画面。
- 字幕模式使用 mpv 的 `subtitles` / `video`，不截整个桌面。改变模式后需要满足上述条件重新截图。
- 自动暂停只允许恢复本插件主动暂停的播放。原本已暂停，或期间发生手动播放、暂停、seek、切文件等操作时，不擅自恢复。原生关窗观察仅在笔记窗口活动期间运行，关闭后停止；没有后台服务。

时间与截图紧邻采样，但 API 没有提供原子绑定。整数毫秒是存储精度，不保证截图恰好对应那个解码帧。需要更严格对齐时先暂停；帧偏差、HDR 与字幕仍须真机验收。

## 输出格式与保存保证

每条记录遵循 **`media-video-capture/v1`**，包含扁平 YAML frontmatter 和标准 Markdown 图片引用。完整字段、隐私模式和消费规则见 [协议文档](docs/PROTOCOL.md)。

先校验截图，通过 IINA 官方 `utils.exec` 调用 macOS 自带 `/bin/cp -n`，以系统原生二进制方式复制到目标卷的 `.iina-staging/`，检查退出码；随后用 `file.handle` 以 64 KiB 分块读取、完整比对源文件和目标文件，并验证 PNG 结构。这里不使用文本复制，也不需要 Node/fs 或额外运行库。

采用原生复制可以避开已核对的 IINA 1.5 `FileHandle.write` 原生写入异常路径，并降低大图逐字节跨 JavaScript/Swift 写入的开销；真实磁盘满和权限故障仍需 Mac 验收。校验后以不覆盖目标的同卷硬链接发布完整图片，最后发布 Markdown。消费端只扫描最终 `*.md`，不扫描 `.pending`。

这是有限步骤协议，**不是整个文件组的数据库事务**：图片成功、Markdown 失败时可能暂留未引用图片，草稿保留用于重试。用户已改过的同名 Markdown 或图片不会被覆盖。

原视频始终只读，不修改 MKV/MP4 内嵌元数据，不复制视频到 Vault。源视频移动或删除后，已导出的 Markdown 与 PNG 仍独立存在。

单张 PNG 上限为 128 MiB，正文上限为 10 万个 JavaScript 字符单位。必要时用 macOS 自带 `sips` 生成最长边 960 像素的预览副本；原始 PNG 不缩小。预览不可用不等于原图保存失败。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 没有可捕获的视频 | 等待加载完成，确认本地视频轨与播放位置有效 |
| 截图超时或失败 | 保留文字；同次加载的原位置暂停后重试，或明确选择仅文字保存 |
| 改变字幕模式后不能保存 | 在原位置暂停后重新截图，或恢复原模式 |
| 权限不足、空间不足 | 修复后从草稿重试；已建立计划的草稿仍使用原目录 |
| 文件系统不支持发布 | 选择支持同卷硬链接的本地目录，再回到草稿点击「改存当前目录」；需确认旧目录可读且尚未发布 Markdown |
| 改存当前目录被拒绝 | 先恢复旧目录访问或检查已有 Markdown；插件不能在无法排除重复发布时改目标 |
| 同名文件内容不同 | 检查并备份现有文件；插件不会替你覆盖或删除 |
| Obsidian 不显示图片 | 确认 Markdown 与 `assets/` 一起复制/同步，图片确实存在 |
| 关闭后没有自动播放 | 可能原先已暂停或检测到用户操作；自行继续播放 |
| 快捷键没有反应 | 先用菜单验证，再检查系统/IINA/其他插件的键位冲突 |
| 没有 Obsidian | 默认独立保存，可用任意 Markdown 阅读器和图片查看器 |

禁用插件不影响导出文件。已核对的 IINA v1.5.0 卸载代码保留数据目录，但真实卸载仍须验收；长期记录宜放在自己管理的目录并常规备份，不依赖未来版本的卸载策略。

## 工程与验证

| 路径 | 职责 |
| --- | --- |
| `Info.json` | 声明、默认设置和权限 |
| `src/` | 捕获、草稿、发布、PNG 校验与原生适配 |
| `ui/` | 独立窗口编辑器、设置和草稿入口 |
| `test/` | 核心逻辑与模拟 API 测试 |
| `scripts/` | 无第三方依赖的构建、检查和打包 |
| `dist/main.js` | 可由 IINA 直接加载的构建产物 |
| `docs/API_AUDIT.md` | 官方文档与源码核对 |
| `docs/PROTOCOL.md` | 独立交接协议 |
| `docs/MAC_ACCEPTANCE.md` | 真实 Mac 验收清单 |
| `docs/VALIDATION.md` | 本轮实际执行结果、覆盖范围与未验收项 |

本项目**不运行 GitHub Actions CI**，验证均在本地执行。自动化覆盖核心逻辑、模拟失败和 UI 消息；真实播放器、WebKit、原生磁盘故障与色彩不能据此宣称通过。

IINA 负责「当前视频 → 画面、位置、文字 → Markdown」。MediaCore 将来扫描收件箱并决定作品、视频版本和长期笔记关联。本插件不填写 Work UID 或版本 ID，不做影片搜索、资源库、云盘、媒体服务器或其他播放器集成。
