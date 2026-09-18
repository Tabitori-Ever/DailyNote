# 日记 · 桑榆下

本地优先的日记系统。数据是纯 Markdown 文件，放在你自己的磁盘上，
用 Git 做版本管理并备份到 GitHub 私有仓库
[Tabitori-Ever/DailyNote](https://github.com/Tabitori-Ever/DailyNote)。

---

## 1. 启动

### 桌面快捷方式（推荐）

桌面上有一个图标（就是那个日记本）：

| 快捷方式 | 作用 |
| --- | --- |
| **日记 · 桑榆下** | 后台起服务并自动打开浏览器，全程无黑框窗口；已在运行则只打开页面，不会重复启动 |

拖到任务栏就能固定成任务栏按钮。想开机自启：
<kbd>Win</kbd>+<kbd>R</kbd> 输入 `shell:startup`，把快捷方式复制进去。

快捷方式丢了或换了电脑，重新生成一次即可：

```powershell
powershell -ExecutionPolicy Bypass -File _tools\setup-desktop.ps1
```

### 服务怎么关（不需要单独的操作）

服务跟着浏览器一起走，**不用记得去关它**：

| 情形 | 行为 |
| --- | --- |
| 点顶栏右上角的**退出按钮** | 立刻停止服务，页面切到「已退出」提示屏，然后可以关掉标签页 |
| 直接**关掉浏览器页面** | 页面会发一个关闭通知；服务在约 **3 分钟**宽限期后自动退出 |
| 刷新页面 / 切标签 / 手机息屏 | 心跳很短，**不会被误杀**；宽限期内重新打开会续上，不会重启服务 |

宽限期默认 3 分钟，用 `--idle=<分钟>` 调整；不加这个参数就是常驻模式（命令行调试时用）。
心跳是页面每 15 秒 ping 一次 `/api/heartbeat`，关闭时用 `sendBeacon` 通知 `/api/pagehide`。

### 命令行

```powershell
node _tools/server.mjs                    # 常驻模式，Ctrl+C 停止
node _tools/server.mjs --open --idle=3    # 启动后开浏览器，关页面 3 分钟后自动退出
node _tools/server.mjs --stop             # 手动停掉正在运行的服务
```

或者用启动器（带 Node 环境检查，等价于上面的 `--open --idle=3`）：

```powershell
_tools\launch.cmd            # 启动并打开浏览器
_tools\launch.cmd --status   # 查看运行状态
_tools\launch.cmd --stop     # 停止
```

**编辑、记账、Git 操作都需要这个后台服务**，所以不要用「双击 `index.html`」的方式
—— 那样只能阅读，不能写入。服务是**纯 Node 内置模块，零 npm 依赖**，
整个 `_tools/` 就是全部后端，拷走整个文件夹即可在别的机器上跑。

### 图标

图标是照着站点配色（纸 `#e8e5e1` / 墨 `#1c1a16` / 琥珀 `#a67d48`）画的日记本：
米色封面 + 琥珀书脊 + 三条笔迹 + 飘带书签，无渐变。

改了图标源重新生成全套尺寸：

```powershell
python _tools\make-icon.py     # 需要 Pillow
```

会输出 `assets/icons/` 下的 `diary.svg`、`diary-16…256.png` 与多尺寸 `diary.ico`。
`diary.ico` 供 Windows 快捷方式使用，`diary.svg` 是浏览器标签页图标。

### 自测

```powershell
node _tools/test-api.mjs          # 服务端接口回归（35 项）
node _tools/test-lifecycle.mjs    # 服务生命周期：心跳 / 超时退出 / 退出接口（15 项，约 2 分钟）
node _tools/uitest.mjs "http://127.0.0.1:8787/" "_tools/shots" "_tools/test-ui.mjs"   # 界面回归（57 项）
node _tools/uitest.mjs "http://127.0.0.1:8787/" "_tools/shots" "_tools/test-quit.mjs" # 心跳与退出按钮（17 项）
```

---

## 2. 视觉规范

风格参考 `RhineLabUI-main/`（莱茵生命主题 UI），并做了极简化。

| 项目 | 取值 |
| --- | --- |
| 纸底 | `#e8e5e1`（暗色 `#211f1a`） |
| 墨色 | `#1c1a16`（暗色 `#ece9e4`） |
| 强调色 | `#a67d48` 琥珀，全站唯一强调色 |
| 分隔 | 1px 细线，主标题下用 1px 实墨线 |
| 圆角 | 2–3px，接近直角 |
| 小标签 | 等宽字体 + `0.22em` 字距 + 全大写 |
| 阴影 | 不使用装饰性阴影（仅弹窗遮罩） |
| 渐变 | **全站零渐变**（有自动化测试守着这条） |

---

## 3. 功能

### 阅读

- 正文默认 **18px / 行距 1.9 / 栏宽 960px**，一屏约占阅读区 71%，每行约 53 字宽
- 可在设置里调字号（14–26）、行距（1.4–2.6）、栏宽（620–1400），并切换衬线正文
- 阅读区只显示日记本身：标题、日期、心情、字数、创建/修改时间、标签
- **不会自动加摘要、迁移说明或任何额外格式**；加粗等格式完全由你写的 Markdown 决定

### 日期切换（两套入口，互不干扰）

| 入口 | 行为 |
| --- | --- |
| **左侧栏日历** | **点一下直接切换正文，不弹任何窗**。有记录的日期深色可点，无记录的日期灰化，点了只在底部提示一行字 |
| **顶栏「日期检索」**（Ctrl+K） | 打开检索弹窗，用于跨年月跳转与键盘操作 |

侧栏与弹窗都可按 `↑↓←→`/`PageUp`/`PageDown`/`Enter`/`Esc` 操作。

### 写与编辑

顶栏「写日记」或 `Ctrl+N` 打开编辑器：

- 完整 Markdown 工具栏：标题、**加粗**、*斜体*、<u>下划线</u>、~~删除线~~、
  无序/有序列表、引用、分隔线、链接、**图片插入**、行内代码、表格
- 快捷键：`Ctrl+B` 加粗、`Ctrl+I` 斜体、`Ctrl+U` 下划线、`Ctrl+S` 保存
- 图片可直接选文件或粘贴，服务端存到 `assets/YYYY/MM/`，正文写入相对路径
- **创建时间与最后编辑时间自动记录**在 front matter 里，阅读页会显示
- 「预览」按钮可先看渲染效果
- 保存带乐观并发校验：文件被外部改过会拒绝覆盖并提示重新载入

### 心情 / 纪念日 / 模板

- **心情**：编辑时从表情面板点选，显示在日记标题栏、侧栏日历和时间线节点上。表情集合可在设置里改
- **纪念日**：设置里添加，支持每年 / 每月 / 仅一次。命中日期会在侧栏日历、检索弹窗、时间线上以**琥珀色描边**标出，日记页顶部也会显示一行
- **模板**：内置「事件 / 爱好 / 生活」，可新建任意栏目的模板，编辑时一键套用

### 时间线走廊

横向可拖动的年份走廊：

- 每个有记录的日期是一个节点，节点宽度随缩放变化，位置按真实天数间隔排布
- 缩放 1–4 档；放大后节点显示「月/日 + 关键词」，关键词自动取第一个小标题或首句
- 左键拖动平移（也可用滚轮），点击节点跳到该篇
- 左侧年份标签是**粘性定位**，拖到年中也能看清在看哪一年；顶部有月份刻度

### 记账

默认在顶栏隐藏，设置里打开后才出现。写日记时可以直接填当日收支，保存后自动同步进账本
（清零则自动移除该条）。记账页按月汇总收入/支出/结余，也可手动记一笔。

账本存在 `data/ledger.json`，与日记的 Markdown 分离，互不干扰。

### 版本与备份

设置页底部有 Git 面板：显示分支、待提交数、领先/落后、最近提交与改动文件列表，
可一键「提交」或「提交并推送」。

---

## 4. 目录结构

```
02-日记/
├─ index.html                 应用本体（单文件：结构 + 样式 + 逻辑）
├─ server.mjs → _tools/server.mjs
├─ entries/                   日记数据源，纯 Markdown
│  ├─ index.json              检索清单（服务端自动生成）
│  ├─ 2025/2025-09-09.md
│  └─ 2026/2026-09-18.md
├─ assets/
│  ├─ YYYY/MM/                插入的图片
│  └─ icons/                  应用图标（diary.ico / .svg / 各尺寸 png）
├─ data/
│  ├─ config.json             模板、纪念日、心情、阅读器设置
│  └─ ledger.json             记账数据
├─ _tools/
│  ├─ server.mjs              本地服务：文件读写 / 上传 / 账本 / 配置 / Git
│  ├─ launch.cmd              启动器（纯 ASCII + CRLF，cmd 的硬性要求）
│  ├─ setup-desktop.ps1       生成桌面快捷方式（带图标）
│  ├─ make-icon.py            生成日记图标（SVG / PNG / ICO）
│  ├─ test-lifecycle.mjs      服务生命周期回归
│  ├─ build-index.mjs         单独重建 entries/index.json
│  ├─ new-entry.mjs           命令行新建日记
│  ├─ test-api.mjs            接口回归测试（35 项）
│  ├─ uitest.mjs + test-ui.mjs  无头浏览器界面回归测试（54 项）
│  └─ test-final.mjs          布局与响应式验收
└─ .ssh/                      仓库专用 SSH 私钥（已被 .gitignore 排除）
```

## 5. 日记文件格式

```markdown
---
title: 标题
date: 2026-09-18
created: 2026-09-18T09:31:00.000Z     ← 自动
updated: 2026-09-18T09:31:00.000Z     ← 自动
tags: [宣讲会, 保研]
mood: 🙂                              ← 自动（来自表情面板）
anniversary: 某个纪念日                ← 可选
income: 0                             ← 可选，写入账本
expense: 0                            ← 可选，写入账本
---

## 事件

正文……
```

`created` / `updated` / `mood` / `income` / `expense` 由程序维护，其余可手改。
文件可以脱离本系统单独阅读与版本管理。

---

## 6. Git 与 GitHub 备份

- 远端：`git@github.com:Tabitori-Ever/DailyNote.git`（私有）
- 传输走 **SSH over 443**（`ssh.github.com:443`），因为这个网络封了 `github.com:443`
  的 git 传输。SSH 命令写在仓库的 `core.sshCommand` 里，密钥在 `.ssh/`（已被忽略）
- 提交身份：`Tabitori-Ever <yongluniao@gmail.com>`

手动备份：

```powershell
git add -A
git commit -m "日记更新"
git push
```

`.gitignore` 已排除：`RhineLabUI-main/`（风格参考资料）、原始 `.one` 文件、
`.ssh/` 私钥、以及测试产物。

## 7. 数据来源说明

`entries/2025/2025-09-09.md` 来自 OneNote 文件 `2025年.one`（页标题「桑榆下」）。
原文件没有日期字段，日期按文件内时间戳推定为 2025-09-09。
原文只做了分段与标点整理，正文未改，也没有添加任何说明性文字。
原始的 `.one` 与 `.onetoc2` 仍保留在本地目录中（已被 Git 忽略）。
