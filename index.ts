/**
 * pi-convlog: 把与 pi 的每轮对话按天追加到 markdown 文件，方便构建个人知识库。
 *
 * 设计思路与 ai-explain.el 的对话日志一致：
 *   - 每个自然日一个文件 <目录>/YYYY-MM-DD.md，跨零点自动切换；
 *   - 每轮对话（用户提问 + 助手最终回答）在 turn_end 时落盘一次；
 *   - 文件内容即 markdown 正文，可直接作为知识库素材；
 *   - 回答正文只取文本块：工具调用、思考过程等中间噪声不进日志。
 *
 * 配置（环境变量）：
 *   PI_CONVLOG_DIR=<目录>   记录保存目录，默认 ~/.pi/conversations
 *   PI_CONVLOG_DIR=off      （或 0 / false / no）整体关闭
 *
 * 安装（二选一）：
 *   pi install ./           把本目录注册为本地 pi 包（写入 ~/.pi/agent/settings.json）
 *   或把本目录链接/复制到 ~/.pi/agent/extensions/pi-convlog
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 分支条目与内容块的最小结构（与 summarize.ts 示例相同的做法，
// 只用 import type 引入宿主类型，运行时零依赖）
type TextBlock = { type?: unknown; text?: unknown };
type EntryMessage = { role?: unknown; content?: unknown };
type SessionEntry = { type?: unknown; message?: EntryMessage };

function logDir(): string | null {
  const raw = process.env.PI_CONVLOG_DIR ?? "";
  const value = raw.trim();
  if (/^(off|0|false|no)$/i.test(value)) return null;
  if (value === "") return path.join(homedir(), ".pi", "conversations");
  if (value.startsWith("~")) return path.join(homedir(), value.slice(1));
  return path.resolve(value);
}

function dayStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function clock(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content as TextBlock[]) {
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

/** 当前分支里最后一条用户消息的正文（即本轮提问） */
function lastUserPrompt(branch: SessionEntry[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry &&
      typeof entry === "object" &&
      entry.type === "message" &&
      entry.message?.role === "user"
    ) {
      return messageText(entry.message.content);
    }
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const dir = logDir();
  if (!dir) return;

  // 写盘串行队列：追加之间保持先后顺序，避免并发回合交错
  let writeChain: Promise<void> = Promise.resolve();
  // 已落盘的回合 id，防边界重入导致重复记录
  const loggedTurnIds = new Set<string>();
  // 今天是否已写过会话头（每个自然日、每个会话各写一次）
  let headerDay = "";

  const append = (text: string): Promise<void> => {
    const file = path.join(dir, `${dayStamp()}.md`);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, text, "utf8");
      })
      .catch((error) => {
        console.error(`[pi-convlog] 保存对话记录失败: ${error}`);
      });
    return writeChain;
  };

  const ensureHeader = (cwd: string): Promise<void> => {
    const day = dayStamp();
    if (headerDay === day) return Promise.resolve();
    headerDay = day;
    const now = new Date();
    const name = pi.getSessionName() ?? "未命名会话";
    return append(`\n# 会话 ${name} · ${cwd} · ${dayStamp(now)} ${clock(now)}\n`);
  };

  pi.on("session_start", () => {
    // 新会话重置会话头标记；真正的写盘延迟到第一个回合，避免空会话也建文件
    headerDay = "";
  });

  pi.on("turn_end", async (event, ctx) => {
    // 只记录带用户消息的回合；自定义消息触发的回合没有提问正文，跳过
    const prompt = lastUserPrompt(ctx.sessionManager.getBranch());
    if (!prompt) return;

    if (loggedTurnIds.has(event.messageEntryId)) return;
    loggedTurnIds.add(event.messageEntryId);

    const answer = messageText(event.message.content);
    const status =
      event.outcome === "completed"
        ? ""
        : `\n> [本轮${event.outcome === "aborted" ? "已中断" : "出错"}]\n`;

    await ensureHeader(ctx.cwd);
    await append(
      `\n## [${clock()}] 提问\n\n${prompt}\n\n${answer || "（无文本回答）"}${status}\n---\n`,
    );
  });

  pi.registerCommand("convlog-status", {
    description: "显示对话记录目录与今日文件",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `对话记录目录: ${dir}（今日文件: ${dayStamp()}.md）`,
          "info",
        );
      }
    },
  });
}
