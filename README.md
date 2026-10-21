# pi-convlog

pi 扩展：把与 AI 的每轮对话按天自动追加到 markdown 文件，方便日后构建个人知识库。

与 [ai-explain.el](https://github.com/LiuYinCarl/ai-explain)（Emacs 插件）的对话日志是同一套思路和格式：
用户提问块 + 回答正文 + `---` 分隔符。两个插件可以指向同一个目录，各自产生的日志混在同一天的
文件里也完全兼容。

## 特性

- **按天落盘**：每个自然日一个文件 `YYYY-MM-DD.md`，跨零点自动切换，当天所有会话追加其中
- **按会话收集，整轮一次落盘**：一轮提问（用户消息 → 助手最终回答）在 `agent_settled`
  （自动重试、续跑、压缩都收敛之后）整批写入，一条记录不会被拆成多次写入，
  也不会在多会话同时写同一个文件时被切开插队
- **时间戳取自会话**：用用户 / 助手消息自带的 `timestamp`，不是写盘时刻，
  排队、延迟落盘、跨零点都不会让时间线错位
- **一问一答**：一条用户消息对应一条记录，回答取该轮最后一个有正文的助手消息，
  工具调用前后的中间说明不会混进答案
- **只记正文**：回答只提取文本块；工具调用、思考过程等中间噪声不进日志
- **会话上下文**：每个会话每天开头写一行 `# 会话 <名称> (<会话 id>) · <工作目录> · <时间>`，
  回看时知道这段对话发生在哪个项目、哪个会话
- **异常也留痕**：中断 / 出错 / 回答触达输出上限的回合照样落盘，并标注
  `> [本轮已中断]`、`> [本轮出错]`、`> [回答触达输出上限，可能不完整]`
- **零依赖**：单文件 TypeScript 扩展，只用 Node 内置模块，运行时不需要安装任何 npm 包

## 安装

```bash
cd ~/github/pi-convlog
pi install ./
```

`pi install` 会把本目录注册为本地 pi 包（写入 `~/.pi/agent/settings.json`），之后每次启动
pi 自动加载。`pi list` 可以看到它，`pi remove <source>`（source 即 `pi list` 显示的那行）可移除。

或者直接把目录链接到扩展目录（同样会自动加载）：

```bash
ln -s ~/github/pi-convlog ~/.pi/agent/extensions/pi-convlog
```

## 配置

通过环境变量 `PI_CONVLOG_DIR` 配置：

| 取值 | 效果 |
|------|------|
| 未设置 | 默认保存到 `~/.pi/conversations/` |
| `<目录>` | 保存到指定目录（支持 `~/...` 与相对路径；相对路径以 pi 启动时的工作目录为基准） |
| `off`（或 `0` / `false` / `no`） | 整体关闭，不写任何文件 |

想和 Emacs 插件的日志合并成一个知识库，把两边指到同一目录即可，例如 shell 配置里：

```bash
export PI_CONVLOG_DIR=~/.emacs.d/ai-explain
```

## 日志格式

```markdown
# 会话 未命名会话 (01a15ce5) · /home/kenshin/github/foo · 2026-10-21 15:02

## [15:02] 提问

帮我解释一下这段代码

这段代码……

---

## [15:09] 提问

为什么这里要用宏？

因为……

---
```

`# 会话` 行每个会话每天写一次；恢复会话或重载扩展后会按会话 id 和日期检查日志文件，
不会重复写。`## [HH:MM] 提问` 的时间是该条用户消息的时间。

## 说明与限制

- 一条记录在整轮结束时才落盘（`agent_settled`，退出 / 切换会话时也会兜底写入），
  所以进程在回合中途被强杀时，这一轮可能来不及写进日志；回合结束后的记录不会丢
- 多个 pi 进程写同一天的文件时，每条记录是一次追加写入，记录之间不会互相切开；
  但不同会话的记录仍按各自结束的先后顺序排列
- 只记录「用户提问 + 最终回答」，中间的工具调用与思考过程刻意不记，保证日志是干净的
  知识库素材；如需完整过程，pi 自带的 `/export` 可导出 HTML / JSONL 全量会话
- pi 本身已把完整会话存为 JSONL（`~/.pi/agent/sessions/`），本插件是对外的一份
  人类可读、可检索的 markdown 副本

## 开发

```bash
npm install      # 类型检查 / 测试用的开发依赖（含 pi 的类型包），运行时不依赖任何 npm 包
npm run typecheck
npm test         # 纯函数（时间戳、正文提取、记录格式、会话头识别）的回归测试
```

`index.ts` 是唯一入口，由 `package.json` 的 `pi.extensions` 指向；改完直接重启 pi
（或在 TUI 里 reload）即可生效。

## 发布（可选）

推到 GitHub 或发布到 npm 后，可用 `pi install git:github.com/LiuYinCarl/pi-convlog` /
`pi install npm:pi-convlog` 安装。`package.json` 已带 `pi-package` 关键词，npm 发布后
有机会出现在 [Pi package gallery](https://pi.dev/packages)。
