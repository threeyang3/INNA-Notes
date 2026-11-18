# IINA 1.5.0 API 核查记录

核查日期：2026-11-18。范围：IINA 官方插件文档、`iina/iina` 的 `v1.5.0` 源码、官方插件模板，以及 mpv 官方手册。本文记录静态核查结果；**没有在 macOS / IINA 内执行，不代表真机兼容性验收通过**。支持目标为 IINA 1.5.x；更早版本没有经过本项目验证。

## 1. 执行环境与实例隔离

插件主脚本运行于 JavaScriptCore，不是 Node.js 或浏览器。可用 `Date`、`Promise`、`Uint8Array` 等 JavaScript 基础对象；不要假设存在 `fs`、`process`、`Buffer`、`window`、`fetch`、`URL` 或 `crypto.randomUUID`。IINA 自己提供 `require()`、定时器和 `iina.*`。

Main Entry 每个播放器各有一份，绑定自己的 mpv、菜单和独立窗口；Global Entry 只有一份，不能直接控制播放器。本插件不需要 Global Entry。虽然 JavaScript 状态隔离，`@data/` 与偏好设置按插件 identifier 共享，因此草稿不能使用所有实例共用的固定文件名。

官方 `require()` 是简单 CommonJS 风格包装，模块以 `module.exports = ...` 导出；不要依赖 Node 的模块解析、内置库或 `exports` 别名。使用带 `.js` 后缀的相对路径，避免依赖其不完善的缓存行为。

来源：[Getting Started](https://docs.iina.io/pages/getting-started.html)、[Development Guide](https://docs.iina.io/pages/dev-guide.html)、[JavascriptPluginInstance.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptPluginInstance.swift)、[JavascriptPolyfill.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptPolyfill.swift)。

### 播放器窗口关闭与实例复用

**`iina.window-will-close` 不能当作插件实例被卸载。** v1.5.0 的 `MainWindowController.windowWillClose` 调用 `player.stop()`，随后发出 `windowWillClose` 事件；该路径没有卸载插件。`PlayerCore` 把实例保留在静态 `playerCores` 池中，`newPlayerCore` 优先使用 `findIdlePlayerCore()` 返回的空闲实例；`createPlayerCore()` 创建新实例时才调用 `loadPlugins()`。因此关闭播放窗口后再打开视频，可能继续使用原来的 JavaScriptCore 插件实例。

本插件据此把窗口关闭处理为会话休眠：保护现有草稿、递增媒体会话序号、使尚未确认的截图失效、撤销暂停恢复权、关闭笔记窗口，并停止窗口可见性观察。保留文件加载事件监听器与可再次使用的定时器包装器，使播放器被复用后仍能创建笔记。若草稿写盘失败，保留原始内存草稿，让下一次打开面板可以继续处理，不把其正文绑定到新视频。

已经开始的文件导出允许执行完有限步骤并关闭二进制句柄；不在播放窗口关闭时直接清空所有计时器。需要永久停止本插件的计时器包装器时，会同时拒绝尚未完成的 `delay()` Promise，让分块二进制比较进入 `finally` 关闭两只只读文件句柄，避免只清原生回调却遗留永远等待的任务。旧导出完成时，暂停恢复必须核对其捕获 ID，不能释放后续新笔记获得的暂停恢复权。真正的插件实例析构由 IINA 清理原生定时器。窗口关闭后再打开视频仍列入真实 Mac 手工验收，模拟测试不替代该验收。

来源：[PlayerCore.swift：`newPlayerCore`、`findIdlePlayerCore`、`createPlayerCore`、`loadPlugins`、`stop`](https://github.com/iina/iina/blob/v1.5.0/iina/PlayerCore.swift)、[MainWindowController.swift：`windowWillClose`](https://github.com/iina/iina/blob/v1.5.0/iina/MainWindowController.swift)、[JavascriptPluginInstance.swift：实例清理](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptPluginInstance.swift)。

## 2. 播放状态与截图

| API | 已核对行为 | 实现要求 |
| --- | --- | --- |
| `core.status.position` / `duration` | 秒；调用 IINA 的 `syncPositionIfNeeded()` 后读取播放器信息 | 捕获时固定，校验有限数字后转换整数毫秒；不能把缺失值转换成 0 |
| `core.status.url` | Swift 返回 `absoluteString.removingPercentEncoding` | 已经解码，不能再次 `decodeURIComponent`；含字面 `%20` 的文件名尤其要测试 |
| `core.status.title` | IINA 媒体标题（不带扩展名） | 保留真实值，并在 YAML 正确转义 |
| `core.status.paused` / `idle` | 基于 IINA 播放器状态 | 与 mpv 属性、文件生命周期共同检查，不能仅凭 `idle === false` 判断加载完成 |
| `core.status.isNetworkResource` | 当前资源的网络标记 | 本轮拒绝网络资源，也校验来源 scheme / 实际路径 |
| `mpv.getNative(name)` | 读取 `MPV_FORMAT_NODE`，不可用时返回空值 | 使用类型检查；`value == null` 时拒绝必填状态，不伪造默认值 |
| `mpv.getNumber(name)` | 底层 Double 初始化为 0，忽略 `mpv_get_property` 失败码 | **不能单独用于证明有效的 0 秒时间戳** |
| `mpv.getString("path")` | mpv 原始文件路径 | 用于实际路径和文件一致性检查，避免反复 URL 解码 |
| `mpv.command(name, args)` | `void`；使用 C `mpv_command(argv)`；`checkError: false` | 不把返回当作截图完成或成功；必须校验输出文件 |

调用 `screenshot-to-file` 时，`subtitles` 表示包含字幕，`video` 表示视频画面、不包含字幕；不使用 `window` 模式。文件扩展名决定输出格式，`.png` 不需要修改用户的 `screenshot-format`。该命令会覆盖同名目标，因此必须使用独立生成、确认未占用的图片路径。

### 命令参数的转义与异步语义

IINA 将命令名和各参数作为独立 C 字符串传入 `mpv_command`，并非 shell，也并非 `mpv_command_string`。mpv 官方“Commands specified as arrays”说明这种 API **默认关闭属性展开**。文件名中的空格、引号、反引号和 `${...}` 不需要 shell 转义；不得加一层引号改变路径本身。

基本命令为：

```js
iina.mpv.command("screenshot-to-file", [absolutePngPath, "subtitles"]);
```

mpv 的数组 API 同时允许把命令前缀逐项置于真正命令前。需要显式异步编码/写盘时可以使用：

```js
iina.mpv.command("async", [
  "raw", "no-osd", "screenshot-to-file", absolutePngPath, "subtitles"
]);
```

这里 `async` 是传给 libmpv 的命令前缀，`raw` 再次明确禁止属性展开，`no-osd` 避免命令 OSD。其可用性由 IINA 的 argv 转发代码与 mpv 命令规范共同支持，仍列入实际 IINA 截图验收。IINA 没有给插件暴露对应 `mpv_command_async` 的完成回调。普通同步 client command 可能等待；添加 `async` 后也不能据此宣称所有图像获取环节绝不阻塞。输出应采用有限次数异步检查，校验 PNG 签名、结构/尺寸与完整结尾，确认后才允许发布引用该图片的 Markdown。

截图必须在触发操作时紧邻时间戳采样提交。继续播放时，API 不保证“读时间”与“截图渲染帧”是原子操作；自动化可验证时间戳固定，实际帧和毫秒位置的偏差、HDR、字幕与色彩只能在真机测量。重试也不能把后来一帧悄悄挂到旧时间戳。

来源：[JavascriptAPICore.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPICore.swift)、[JavascriptAPIMpv.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPIMpv.swift)、[MPVController.swift](https://github.com/iina/iina/blob/v1.5.0/iina/MPVController.swift)、[MPVNode.swift](https://github.com/iina/iina/blob/v1.5.0/iina/MPVNode.swift)、[mpv 数组命令](https://mpv.io/manual/master/#commands-specified-as-arrays)、[截图命令](https://mpv.io/manual/master/#screenshot-commands)、[同步/异步语义](https://mpv.io/manual/master/#synchronous-vs-asynchronous)。

## 3. 定时器、事件与暂停所有权

- `setTimeout(callback, delay)` 与 `setInterval` 的单位均为**毫秒**。Swift 内部除以 1000 后构造 `Timer`，返回的 timer ID 是字符串。
- 定时器在主队列运行，不是后台工作线程。长循环仍会阻塞 UI；分块操作需要让出执行权。
- v1.5.0 的一次性 timer 执行后不会主动从内部字典移除；包装器应在 callback 中清理自身 ID，避免长期累积。插件实例析构会调用 `removeAllTimers()`。
- `event.on("mpv.pause.changed", callback)` 收到第一个参数通常为布尔值。监听的是实际属性变化，不是用户动作来源；同一状态的重复命令不一定产生事件。
- mpv 事件先在 controller 队列处理，再经 `DispatchQueue.main.async` 派发给插件，**不是 `pause()` 调用栈内同步回调**。不应仅用 `isPausing = true; pause(); isPausing = false` 来识别自己的变化。
- 初次观察可能带来当前值，事件送达时可能已经发生后续变化。校验 payload 类型，并重新读取实际 pause 状态；对外部播放操作、跳转、文件切换或无法确定的情况撤销恢复权。
- 没有可靠的通用 API 证明某次变化由哪位用户/插件造成。恢复策略必须保守：只有确定由本插件暂停、文件仍一致、期间没有外部意图证据时才恢复。

来源：[setTimeout 文档](https://docs.iina.io/functions/setTimeout.html)、[JavascriptPolyfill.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptPolyfill.swift)、[JavascriptAPIEvent.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPIEvent.swift)、[MPVController.swift](https://github.com/iina/iina/blob/v1.5.0/iina/MPVController.swift)。

## 4. 文件 API、路径与持久保存

| 能力 | v1.5.0 行为 |
| --- | --- |
| `file.write(path, text)` | UTF-8 文本，Swift `atomically: true`；插件私有目录外禁止覆盖已存在路径 |
| `file.read(path, {})` | 文本读取；提供空 options 对象符合原生导出签名 |
| `file.handle(path, "read")` | 二进制读取，`read(n)` / `readToEnd()` 返回 `Uint8Array` |
| `file.handle(path, "write")` | **只打开已经存在的文件**；不创建、不自动截断；新文件先用 `file.write(path, "")` 建立 |
| `FileHandle.write(bytes)` | 允许 `Uint8Array` / 数字数组；本插件不使用该旧写入桥复制 PNG，原因见下文 |
| `seekToEnd()` + `offset()` | 可用于获取字节长度；读取时重置 offset |
| `file.delete(path)` | 只允许插件 `@data/` / `@tmp/` 的文件 |
| `file.trash(path)` | 允许移至回收站；导出流程无需删除用户已有文件 |
| `file.showInFinder(path)` | Finder 展示路径 |
| mkdir / rename / move | **没有公开 API**；Swift `move` 未列入 JSExport，不能调用 |

`file.write` 的 Swift 错误处理会设置 `JSContext.exception`，这是提供给 JS `try/catch` 的错误通道；同时返回值为空，仍应读回核验。此审查没有真机测试所有错误传播。尤其旧 `FileHandle.write` 调用没有 Swift `do/catch`，不能把“模拟磁盘满测试”描述成已验证原生磁盘故障均可恢复。

`FileHandle.write(Uint8Array)` 在原生实现中逐字节跨 JS/Swift bridge 构造数组，随后调用旧 Foundation `FileHandle.write`，没有把写入错误转换为可可靠捕获的 JS 异常。磁盘满等故障存在原生异常风险，大尺寸 PNG 的逐字节桥接也可能占用播放器主线程。因此本插件的图片搬运使用正式 `utils.exec("/bin/cp", ["-n", source, target])`：macOS 自带的 `cp` 做二进制复制，固定可执行路径与独立参数数组不经过 shell，不经文本 API，也不需要额外依赖包。检查子进程退出状态；非零状态使保存失败并保留原始截图与草稿。

`-n` 不替换已有文件，但返回成功不代表一定执行了复制。插件既在调用前拒绝已存在的目标，也在命令完成后复核目标 PNG 结构、文件大小及全部字节。全量比较通过官方 `file.handle(..., "read")` 每次读取最多 64 KiB，每块之间使用定时器让出执行权，并在成功、失败或取消时关闭两只只读句柄。图片复制流程不打开写入句柄，不用 `file.write` 建立或复制 PNG，也不修改原始截图。模拟测试覆盖命令非零退出、复制损坏、目标并发出现且 `cp -n` 跳过复制、比较取消后的句柄关闭；这些测试不替代真实 Mac 的磁盘空间不足与大尺寸截图验收。

### 路径解析

`utils.resolvePath` 展开 `@data/`、`@tmp/` 和 `~/`，并不是业务授权或符号链接边界验证。API 的部分私有目录检测只做字符串前缀匹配。插件仍应生成自己的安全子路径、拒绝路径穿越，并复核授权 root 与子目录没有越界的符号链接。

如需规范实际目录，可在已校验的目录内执行固定 `/bin/pwd` 的 `-P`；如需目录创建、类型/身份校验和不覆盖发布，可限于 `/bin/mkdir`、`/usr/bin/stat`、`/bin/ln` 等明确参数的系统程序。只去掉 `pwd` 输出的最后一个换行，不用 `trim()` 改变合法路径末尾的空格。跨文件系统硬链接会失败，暂存与最终发布文件应位于同一目标文件系统；已有目标必须拒绝覆盖。此策略优先面向**本地 APFS / HFS+**，用户实际 Vault 所在卷仍需验收。不支持硬链接的卷安全失败并保留草稿，不静默降级为覆盖写入。

已对照 Apple 公开的 [ln 源码](https://github.com/apple-oss-distributions/file_cmds/blob/main/ln/ln.c)、[ln 手册](https://github.com/apple-oss-distributions/file_cmds/blob/main/ln/ln.1) 与 [stat 源码](https://github.com/apple-oss-distributions/file_cmds/blob/main/stat/stat.c)：`ln -h` 不跟随目标符号链接，未指定 `-f` 时不会删除既有文件；`stat -f %HT` 返回 `Directory`、`Regular File`、`Symbolic Link` 等类型。必须复核最终目标类型，不能假设任意返回 0 的文件命令都满足业务条件。对本插件精确生成的暂存文件可用固定 `/bin/rm -f` 清理，不允许递归删除或删除用户既有记录。

若 `@data` 的祖先是用户设置的符号链接，物理目录的 canonical 路径可能不同于 IINA 内部记录的 dataURL 路径。直接把 canonical 路径传给 file API，可能被它误判为外部路径而拒绝草稿覆盖/删除。主机适配层应对物理数据根内的 file API 路径映射为 `@data/<relative>`，系统命令则仍使用经过验证的物理绝对路径；或者明确拒绝这种目录布局。

### 数据目录与卸载

`@data/` 位于：

```text
~/Library/Application Support/com.colliderli.iina/plugins/.data/<identifier>/
```

它与插件安装包分开；`@tmp/` 不保证退出后保留。v1.5.0 的插件 `remove()` 只删除包目录，没有删除 `.data/<identifier>`。因此默认数据保存不应写到安装包内；同时保留“查看输出目录”和外部目录导出说明，不对用户主动清理数据或未来 IINA 卸载策略作保证。

来源：[File](https://docs.iina.io/interfaces/IINA.API.File.html)、[FileHandle](https://docs.iina.io/interfaces/IINA.API.FileHandle.html)、[JavascriptAPIFile.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPIFile.swift)、[JavascriptAPI.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPI.swift)、[JavascriptPlugin.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptPlugin.swift)。

## 5. Utils 与偏好设置

`utils.exec(file, args, cwd?, stdoutHook?, stderrHook?)` 返回 Promise，完成值包含 `{status, stdout, stderr}`。进程启动失败通过 reject，进程非零退出通常仍 resolve，需要检查 `status`。指定绝对可执行文件路径；不要依赖 PATH 查找。没有暴露进程终止句柄，因此使用它只运行短小、有限、受控的系统操作，不启动服务或长期任务。

`utils.chooseFile(title, {chooseDir:true})` 的文档返回类型写成 `string`，但 **v1.5.0 实现是 Promise**。取消选择的回调没有可靠的完成保证，因此不能把这次 Promise 当成必须完成后才能继续保存笔记的全局锁。

`preferences.get` / `set` 访问按插件共享的偏好；程序调用 `set` 后调用 `sync()` 持久化。设置界面 HTML 可使用官方 `data-pref-key` 绑定。目录选择、路径验证和实际写入仍由主脚本处理。

来源：[Utils](https://docs.iina.io/interfaces/IINA.API.Utils.html)、[Preferences](https://docs.iina.io/interfaces/IINA.API.Preferences.html)、[Plugin Preferences](https://docs.iina.io/pages/plugin-preferences.html)、[JavascriptAPIUtils.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPIUtils.swift)。

## 6. 独立窗口与消息桥

使用 `standaloneWindow.loadFile("ui/editor.html")` 加载插件相对路径，使用 `open()` 显示；部分文档旧例中的 `.show()` 不适用。`setProperty` 应在窗口已创建后调用。`hudWindow` 虽在类型文档中出现，v1.5.0 的属性处理没有实现它，不能依赖它获取毛玻璃效果。

**`loadFile()` 会清空主脚本侧消息监听器。** 初始化时先 loadFile 后 onMessage；WebView ready 后再发送状态。相同名称的 onMessage 会替换之前的 listener。WebView reload 通过握手恢复，而不是重复创建一组主脚本监听器。

WebView 与主脚本是独立 JS 上下文，通过 `iina.postMessage` / `onMessage` 交换 JSON 可序列化数据。主脚本不得访问 DOM；前端不得直接调用 `iina.file`。

### v1.5.0 消息转义缺陷

`JavascriptMessageHub.postMessage` 将数据的 JSON 文本插入 JavaScript 模板字符串。用户文字/文件名中的反引号与 `${...}` 可能破坏执行甚至触发 WebView 代码。主脚本向 UI 发送内容时采用安全的固定 envelope，例如：

```js
// 主脚本：payload 包括标题、正文、路径等业务数据。
standaloneWindow.postMessage("video-notes", {
  encoded: encodeURIComponent(JSON.stringify(payload))
});
// WebView 收到固定 envelope 后：
const payload = JSON.parse(decodeURIComponent(message.encoded));
```

固定事件名，验证 envelope 大小与结构。不要直接在 `setContent()`、HTML 或脚本片段里拼用户文字；DOM 显示使用 `textContent` / 表单 value。

### 图片预览与关闭

`loadFile` 的 WebView 只获得插件根目录的文件读取权限，不能直接用 `@data` 截图的 file URL。可通过二进制读取生成受限 data URL，或受控缩略图；不要无限复制超大 PNG。使用 macOS 自带 `/usr/bin/sips` 为大图生成 960 像素预览时，始终明确新的 `--out` 目标，复核目标位于私有预览目录且无符号链接，不覆盖原始截图。预览失败只影响界面预览，不能否定已经验证有效的原始 PNG 或阻止文字/图片导出。

v1.5.0 `JavascriptAPIStandaloneWindowExportable` 实际有 `isOpen(): Bool`，官方类型文档未列出；它判断窗口已创建并且 `isVisible`。没有公开的原生关闭事件。窗口关闭时不会释放 WebView，不能依赖 `beforeunload` 保存正文。应在编辑期间保护草稿；若需要观察原生关闭，只在活动笔记会话有暂停所有权等实际需要时检查 `isOpen`，关闭后停掉计时器。

来源：[StandaloneWindow](https://docs.iina.io/interfaces/IINA.API.StandaloneWindow.html)、[Web Views](https://docs.iina.io/pages/webviews.html)、[JavascriptAPIStandaloneWindow.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptAPIStandaloneWindow.swift)、[PluginStandaloneWindow.swift](https://github.com/iina/iina/blob/v1.5.0/iina/PluginStandaloneWindow.swift)、[JavascriptMessageHub.swift](https://github.com/iina/iina/blob/v1.5.0/iina/JavascriptMessageHub.swift)。

## 7. 声明、安装与参考项目

`Info.json` 必填 `name`、`version`、`identifier`、`author: {name}` 和 `entry`。只声明实际调用需要的 `file-system`、`show-alert`、`show-osd`；不申请网络权限。菜单快捷键使用 mpv 风格 `keyBinding`，真实 macOS 快捷键冲突仍需验收。

官方打包命令：

```sh
/Applications/IINA.app/Contents/MacOS/iina-plugin pack /path/to/plugin
```

`.iinaplgz` 是 ZIP；顶层直接包含 Info.json 和运行资源，不额外套一层目录。开发链接使用 `iina-plugin link /path/to/plugin`。从 GitHub 安装会读取 main 或最新 release 的安装包，不会构建源码，因此提交的 entry 与 UI 必须已可运行。

参考过 [官方插件模板](https://github.com/iina/iina-plugin-template)，沿用其原生入口和独立窗口方式，不引入 React/Parcel。也查看了社区 [HDR Screenshot](https://github.com/bbeny123/iina-hdr-screenshot) 的 README；其外部 FFmpeg 方案存在最近关键帧与当前帧不一致的明确限制，不作为本项目主截图路径，只作为 HDR 真机验收的参考。

来源：[Creating Plugins](https://docs.iina.io/pages/creating-plugins.html)、[Menu](https://docs.iina.io/interfaces/IINA.API.Menu.html)、[Development Guide](https://docs.iina.io/pages/dev-guide.html)、[iina-plugin/main.swift](https://github.com/iina/iina/blob/v1.5.0/iina-plugin/main.swift)。
