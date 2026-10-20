# pi-convlog

pi 扩展：把与 AI 的每轮对话按天自动追加到 markdown 文件，方便日后构建个人知识库。

与 [ai-explain.el](https://github.com/LiuYinCarl/ai-explain)（Emacs 插件）的对话日志是同一套思路和格式：
用户提问块 + 回答正文 + `---` 分隔符。两个插件可以指向同一个目录，各自产生的日志混在同一天的
文件里也完全兼容。

## 特性

- **按天落盘**：每个自然日一个文件 `YYYY-MM-DD.md`，跨零点自动切换，当天所有会话追加其中
- **每轮一问一答**：在 `turn_end` 边界记录「提问 + 助手最终回答」，一次用户提问只产生一条记录
- **只记正文**：回答只提取文本块；工具调用、思考过程等中间噪声不进日志
- **会话上下文**：每天每个会话开头写一行 `# 会话 <名称> · <工作目录> · <时间>`，回看时知道
  这段对话发生在哪个项目、哪个会话
- **中断也不丢**：中断/出错的回合同样落盘，并标注 `> [本轮已中断]`
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
# 会话 未命名会话 · /home/kenshin/github/foo · 2026-10-21 15:02

## [15:02] 提问

帮我解释一下这段代码

这段代码……

---

## [15:09] 提问

为什么这里要用宏？

因为……

---
```

## 说明与限制

- 同一时刻多个 pi 进程写同一个文件时，追加内容可能交错；日常单会话使用无影响
- 只记录「用户提问 + 最终回答」，中间的工具调用与思考过程刻意不记，保证日志是干净的
  知识库素材；如需完整过程，pi 自带的 `/export` 可导出 HTML / JSONL 全量会话
- pi 本身已把完整会话存为 JSONL（`~/.pi/agent/sessions/`），本插件是对外的一份
  人类可读、可检索的 markdown 副本

## 发布（可选）

推到 GitHub 或发布到 npm 后，可用 `pi install git:github.com/<you>/pi-convlog` /
`pi install npm:pi-convlog` 安装。`package.json` 已带 `pi-package` 关键词，npm 发布后
有机会出现在 [Pi package gallery](https://pi.dev/packages)。
