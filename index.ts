/**
 * pi-convlog: 把与 pi 的每轮对话按天追加到 markdown 文件，方便构建个人知识库。
 *
 * 设计思路与 ai-explain.el 的对话日志一致：
 *   - 每个自然日一个文件 <目录>/YYYY-MM-DD.md，跨零点自动切换；
 *   - 按会话收集：一条用户消息开启一条记录，回答取本轮最后一个有正文的助手消息；
 *     整轮在 agent_settled（重试 / 续跑 / 压缩都已收敛）时一次性落盘，
 *     一条记录不会被拆成多次写入，也就不会和多会话的记录交错插入；
 *   - 时间戳来自会话本身（用户 / 助手消息的 timestamp），不用写盘时刻，
 *     排队、延迟落盘、跨零点都不会让时间线错位；
 *   - 会话头每个会话每天一次；恢复会话 / 重载扩展后按日志文件内容去重，不会重复写；
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
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// 内容块的最小结构（与 summarize.ts 示例相同的做法，
// 只用 import type 引入宿主类型，运行时零依赖）
type TextBlock = { type?: unknown; text?: unknown };
type TurnOutcome = "completed" | "aborted" | "error";

function logDir(): string | null {
  const raw = process.env.PI_CONVLOG_DIR ?? "";
  const value = raw.trim();
  if (/^(off|0|false|no)$/i.test(value)) return null;
  if (value === "") return path.join(homedir(), ".pi", "conversations");
  if (value.startsWith("~")) return path.join(homedir(), value.slice(1));
  return path.resolve(value);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 毫秒时间戳 → 本地自然日 YYYY-MM-DD */
export function dayStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 毫秒时间戳 → 本地时:分 */
export function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 消息正文：只提取文本块 */
export function messageText(content: unknown): string {
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

/** 一条「提问 + 回答」记录；时间取自会话内消息，而不是落盘时刻 */
export interface QaRecord {
  prompt: string;
  /** 提问时间：用户消息的 timestamp（毫秒） */
  askedAt: number;
  /** 回答：本轮最后一个有正文的助手消息 */
  answer: string;
  outcome: TurnOutcome;
  /** 回答是否因输出上限被截断 */
  truncated: boolean;
}

/** 单条记录的 markdown 文本：提问 + 回答 + 异常标记 + 分隔符 */
export function formatRecord(record: QaRecord): string {
  const marks: string[] = [];
  if (record.outcome === "aborted") marks.push("> [本轮已中断]");
  else if (record.outcome === "error") marks.push("> [本轮出错]");
  if (record.truncated) marks.push("> [回答触达输出上限，可能不完整]");
  const marksText = marks.length > 0 ? `\n${marks.join("\n")}\n` : "";
  const prompt = record.prompt || "（无文本提问）";
  const answer = record.answer || "（无文本回答）";
  return `\n## [${clock(record.askedAt)}] 提问\n\n${prompt}\n\n${answer}\n${marksText}\n---\n`;
}

/** 文件里是否已经有该会话当天的会话头（恢复 / 重载后避免重复写） */
export function hasSessionHeader(
  fileContent: string,
  sessionId: string,
  day: string,
): boolean {
  const id = `(${sessionId})`;
  for (const line of fileContent.split("\n")) {
    if (
      line.startsWith("# 会话 ") &&
      line.includes(id) &&
      line.includes(` · ${day} `)
    ) {
      return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const dir = logDir();
  if (!dir) return;

  // 写盘串行队列：同一进程内保持先后顺序
  let writeChain: Promise<void> = Promise.resolve();
  // 按会话收集：当前问答、本轮已结束待落盘的问答
  let current: QaRecord | null = null;
  let finished: QaRecord[] = [];
  // 本会话已经写过会话头的自然日（每个会话、每天一次）
  const headeredDays = new Set<string>();

  const append = (file: string, text: string): Promise<void> => {
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        // 空文件从第一行开始写，不留开头空行
        const size = await stat(file).then((s) => s.size, () => 0);
        await appendFile(file, size > 0 ? text : text.replace(/^\n/, ""), "utf8");
      })
      .catch((error) => {
        console.error(`[pi-convlog] 保存对话记录失败: ${error}`);
      });
    return writeChain;
  };

  /** 会话头：每个会话、每个自然日一次，时间取该文件里第一条提问的时间 */
  const header = (
    ctx: ExtensionContext,
    id: string,
    day: string,
    at: number,
  ): string => {
    const name = pi.getSessionName()?.trim() || "未命名会话";
    return `\n# 会话 ${name} (${id}) · ${ctx.cwd} · ${day} ${clock(at)}\n`;
  };

  /**
   * 该会话当天是否已经写过会话头：内存标记优先，其次看日志文件。
   * 恢复会话 / 重载扩展后内存标记是空的，靠文件内容避免重复写。
   */
  const alreadyHeadered = async (
    ctx: ExtensionContext,
    id: string,
    day: string,
  ): Promise<boolean> => {
    if (headeredDays.has(day)) return true;
    try {
      const content = await readFile(path.join(dir, `${day}.md`), "utf8");
      if (hasSessionHeader(content, id, day)) {
        headeredDays.add(day);
        return true;
      }
    } catch {
      // 文件还不存在或暂时读不了：照常写会话头
    }
    return false;
  };

  /**
   * 落盘：把本轮收集到的记录按「提问所在自然日」分组，
   * 每组拼成一段一次性追加 —— 单次写入，记录之间不会再被别的会话切开。
   */
  const flush = async (ctx: ExtensionContext): Promise<void> => {
    const batch = finished;
    finished = [];
    if (batch.length === 0) return;

    const byDay = new Map<string, { firstAskedAt: number; parts: string[] }>();
    for (const record of batch) {
      const day = dayStamp(record.askedAt);
      let group = byDay.get(day);
      if (!group) {
        group = { firstAskedAt: record.askedAt, parts: [] };
        byDay.set(day, group);
      }
      group.parts.push(formatRecord(record));
    }

    const id = ctx.sessionManager.getSessionId().slice(0, 8);
    for (const [day, group] of byDay) {
      let text = "";
      if (!(await alreadyHeadered(ctx, id, day))) {
        headeredDays.add(day);
        text += header(ctx, id, day, group.firstAskedAt);
      }
      text += group.parts.join("");
      await append(path.join(dir, `${day}.md`), text);
    }
  };

  pi.on("session_start", () => {
    // 新会话 / 恢复 / 切换：清空按会话收集的缓冲
    current = null;
    finished = [];
    headeredDays.clear();
  });

  pi.on("message_end", (event) => {
    const message = event.message;

    if (message.role === "user") {
      // 新的用户消息开启一条新记录；排队消息逐条成为独立记录
      if (current) finished.push(current);
      current = {
        prompt: messageText(message.content),
        askedAt: message.timestamp,
        answer: "",
        outcome: "completed",
        truncated: false,
      };
      return;
    }

    if (message.role !== "assistant" || !current) return;

    // 一轮里可能有多个助手回合（调用工具前后各说一段），
    // 只保留最后一个有正文的回答，避免把中间过程当成答案记下来
    const text = messageText(message.content);
    if (text) current.answer = text;
    if (message.stopReason === "length") current.truncated = true;
    if (message.stopReason === "error") current.outcome = "error";
    else if (message.stopReason === "aborted") current.outcome = "aborted";
  });

  pi.on("turn_end", (event) => {
    // 本轮状态以最后一次 turn_end 为准（自动重试成功后会回到 completed）
    if (current) current.outcome = event.outcome;
  });

  pi.on("agent_settled", async (event, ctx) => {
    // 整轮真正结束：重试、续跑、压缩都已收敛，此刻整批一次性落盘
    if (current) {
      if (event.aborted && current.outcome === "completed") {
        current.outcome = "aborted";
      }
      finished.push(current);
      current = null;
    }
    await flush(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // 退出 / 切换会话时兜底落盘；已落盘则缓冲为空，天然幂等
    if (current) {
      finished.push(current);
      current = null;
    }
    await flush(ctx);
  });

  pi.registerCommand("convlog-status", {
    description: "显示对话记录目录与今日文件",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        const day = dayStamp(Date.now());
        const pending = finished.length + (current ? 1 : 0);
        ctx.ui.notify(
          `对话记录目录: ${dir}（今日文件: ${day}.md，待落盘: ${pending} 条）`,
          "info",
        );
      }
    },
  });
}
