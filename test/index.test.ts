import assert from "node:assert/strict";
import test from "node:test";

// 固定时区，保证 dayStamp / clock 的断言在任何机器上都一致
process.env.TZ = "Asia/Shanghai";

import {
  clock,
  dayStamp,
  formatRecord,
  hasSessionHeader,
  messageText,
} from "../index.ts";

test("dayStamp / clock 按本地时间格式化毫秒时间戳", () => {
  assert.equal(dayStamp(0), "1970-01-01");
  assert.equal(clock(0), "08:00");

  const noon = Date.UTC(2026, 9, 21, 4, 5); // 2026-10-21 12:05 +08:00
  assert.equal(dayStamp(noon), "2026-10-21");
  assert.equal(clock(noon), "12:05");
});

test("messageText 只提取文本块", () => {
  assert.equal(messageText("  你好  "), "你好");
  assert.equal(
    messageText([
      { type: "text", text: "第一段" },
      { type: "toolCall", name: "bash", arguments: {} },
      { type: "thinking", thinking: "思考" },
      { type: "text", text: "第二段" },
    ]),
    "第一段第二段",
  );
  assert.equal(messageText([{ type: "image", data: "..." }]), "");
  assert.equal(messageText(undefined), "");
  assert.equal(messageText(42), "");
});

test("formatRecord 正常回合：提问 + 回答 + 空行 + 分隔符", () => {
  const text = formatRecord({
    prompt: "怎么编译？",
    askedAt: Date.UTC(2026, 9, 21, 4, 5),
    answer: "运行 make。",
    outcome: "completed",
    truncated: false,
  });
  assert.equal(
    text,
    "\n## [12:05] 提问\n\n怎么编译？\n\n运行 make。\n\n---\n",
  );
});

test("formatRecord 中断 / 截断 / 空正文都会留下标记", () => {
  const aborted = formatRecord({
    prompt: "问题",
    askedAt: 0,
    answer: "",
    outcome: "aborted",
    truncated: true,
  });
  assert.match(aborted, /（无文本回答）/);
  assert.match(aborted, /> \[本轮已中断\]/);
  assert.match(aborted, /> \[回答触达输出上限，可能不完整\]/);
  assert.match(aborted, /\n\n---\n$/);

  const empty = formatRecord({
    prompt: "",
    askedAt: 0,
    answer: "",
    outcome: "error",
    truncated: false,
  });
  assert.match(empty, /（无文本提问）/);
  assert.match(empty, /> \[本轮出错\]/);
  assert.doesNotMatch(empty, /本轮已中断/);
});

test("hasSessionHeader 按会话 id + 自然日识别已有会话头", () => {
  const content = [
    "",
    "# 会话 旧会话 (deadbeef) · /tmp/a · 2026-10-20 09:00",
    "",
    "## [09:00] 提问",
    "",
    "# 会话 今天的会话 (abcdef12) · /home/me/proj · 2026-10-21 08:00",
    "",
  ].join("\n");

  assert.equal(hasSessionHeader(content, "abcdef12", "2026-10-21"), true);
  assert.equal(hasSessionHeader(content, "deadbeef", "2026-10-20"), true);
  // 同一天但会话不同：不算已写过
  assert.equal(hasSessionHeader(content, "deadbeef", "2026-10-21"), false);
  // 同一会话但换了一天：新的一天要重新写会话头
  assert.equal(hasSessionHeader(content, "abcdef12", "2026-10-22"), false);
  assert.equal(hasSessionHeader("", "abcdef12", "2026-10-21"), false);
});
