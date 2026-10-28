import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyze,
  type FileData,
  isSyntheticPrompt,
  monthPeriod,
  parseCodexFile,
  parseFile,
} from "../src/index.ts";

const minute = 60_000;
const base = new Date(2026, 7, 10, 12, 0, 0).getTime();

function file(project: string, offsets: number[]): FileData {
  return {
    project,
    events: offsets.map((offset) => [base + offset * minute, true]),
    nAssistant: 0,
    nUser: offsets.length,
    nPrompt: offsets.length,
    sessions: [project],
  };
}

describe("project time apportionment", () => {
  test("splits a global block in proportion to overlapping project-local time", () => {
    const metrics = analyze(
      new Map([
        ["/tmp/a.jsonl", file("/tmp/project-a", [0, 10])],
        ["/tmp/b.jsonl", file("/tmp/project-b", [5, 15])],
      ]),
      15,
      2,
      new Set(),
      monthPeriod("2026-08"),
    );

    const projects = Object.fromEntries(
      metrics.projects.map((project: any) => [project.name, project]),
    );
    expect(projects["project-a"].active).toBe(0.142);
    expect(projects["project-b"].active).toBe(0.142);
    expect(projects["project-a"].localActive).toBe(0.2);
    expect(projects["project-b"].localActive).toBe(0.2);

    const apportioned = metrics.projects.reduce(
      (sum: number, project: any) => sum + project.active,
      0,
    );
    const total = metrics.daily.reduce((sum: number, day: any) => sum + day.active, 0);
    expect(Math.abs(apportioned - total)).toBeLessThan(0.002);
  });

  test("keeps ignored project events as anchors without assigning their time", () => {
    const metrics = analyze(
      new Map([
        ["/tmp/a.jsonl", file("/tmp/project-a", [0, 10])],
        ["/tmp/b.jsonl", file("/tmp/project-b", [5, 15])],
      ]),
      15,
      2,
      new Set(["project-b"]),
      monthPeriod("2026-08"),
    );

    expect(metrics.projects).toHaveLength(1);
    expect(metrics.projects[0].name).toBe("project-a");
    expect(metrics.projects[0].active).toBe(0.2);
    expect(metrics.projects[0].localActive).toBe(0.2);
  });
});

describe("activity basis", () => {
  // 人間の発言が 0 分と 30 分、間の 10・20 分は AI の応答(発言ではない)
  const withAiEventsBetween = (): Map<string, FileData> =>
    new Map([
      [
        "/tmp/a.jsonl",
        {
          project: "/tmp/project-a",
          events: [
            [base, true],
            [base + 10 * minute, false],
            [base + 20 * minute, false],
            [base + 30 * minute, true],
          ],
          nAssistant: 2,
          nUser: 2,
          nPrompt: 2,
          sessions: ["a"],
        },
      ],
    ]);
  const activeOf = (metrics: any) =>
    metrics.daily.reduce((sum: number, d: any) => sum + d.active, 0);

  test("event basis bridges the gap with AI events", () => {
    const metrics = analyze(
      withAiEventsBetween(),
      15,
      2,
      new Set(),
      monthPeriod("2026-08"),
      "event",
    );
    // 2 分の下駄 + 10 + 10 + 10 分
    expect(activeOf(metrics)).toBeCloseTo(32 / 60, 3);
    expect(metrics.basis).toBe("event");
  });

  test("prompt basis does not count time only bridged by AI events", () => {
    const metrics = analyze(
      withAiEventsBetween(),
      15,
      2,
      new Set(),
      monthPeriod("2026-08"),
      "prompt",
    );
    // 発言の間隔が 30 分で 15 分を超えるので、別々のブロックが 2 分ずつ
    expect(activeOf(metrics)).toBeCloseTo(4 / 60, 3);
    expect(metrics.basis).toBe("prompt");
  });

  test("prompt basis is the default", () => {
    const metrics = analyze(withAiEventsBetween(), 15, 2, new Set(), monthPeriod("2026-08"));
    expect(metrics.basis).toBe("prompt");
  });

  test("a longer gap threshold joins human prompts", () => {
    const metrics = analyze(
      withAiEventsBetween(),
      30,
      2,
      new Set(),
      monthPeriod("2026-08"),
      "prompt",
    );
    // 発言の間隔 30 分がちょうど閾値なので繋がる: 2 分の下駄 + 30 分
    expect(activeOf(metrics)).toBeCloseTo(32 / 60, 3);
  });
});

describe("human prompt detection", () => {
  test("isSyntheticPrompt flags injected messages but not typed ones", () => {
    expect(isSyntheticPrompt("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isSyntheticPrompt("  <local-command-caveat>Caveat: ...")).toBe(true);
    expect(isSyntheticPrompt("# AGENTS.md instructions for /repo\n...")).toBe(true);
    expect(isSyntheticPrompt("<environment_context>\n<cwd>/repo</cwd>")).toBe(true);
    expect(isSyntheticPrompt("続けて")).toBe(false);
    expect(isSyntheticPrompt("[Request interrupted by user]")).toBe(false);
    expect(isSyntheticPrompt("<command-name>/model</command-name>")).toBe(false);
  });

  const withTempFile = async (lines: object[], run: (path: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "ccw-test-"));
    try {
      const path = join(dir, "session.jsonl");
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
      await run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const at = (n: number) => new Date(base + n * minute).toISOString();

  test("Claude: only messages a human typed count as prompts", async () => {
    const user = (n: number, content: unknown, extra: object = {}) => ({
      type: "user",
      timestamp: at(n),
      cwd: "/repo",
      sessionId: "s",
      message: { role: "user", content },
      ...extra,
    });
    await withTempFile(
      [
        user(0, "こんにちは"), // 人間
        user(1, "<task-notification>done</task-notification>"), // バックグラウンド完了通知
        user(2, [{ type: "tool_result", tool_use_id: "t", content: "ok" }]), // ツール結果
        user(3, "メタ", { isMeta: true }), // システム生成
        user(4, [{ type: "text", text: "<system-reminder>x</system-reminder>" }]), // 注入
        user(5, [
          { type: "text", text: "画像つき" },
          { type: "image", source: {} },
        ]), // 人間
        { type: "assistant", timestamp: at(6), cwd: "/repo", sessionId: "s", message: {} },
        user(7, "サブエージェントの発言", { isSidechain: true }), // sidechain
        user(8, "This session is being continued...", { isCompactSummary: true }), // 圧縮要約
      ],
      async (path) => {
        const data = await parseFile(path);
        expect(data.events.map(([, isPrompt]) => isPrompt)).toEqual([
          true,
          false,
          false,
          false,
          false,
          true,
          false,
          false,
          false,
        ]);
        expect(data.nPrompt).toBe(2);
        expect(data.project).toBe("/repo");
      },
    );
  });

  test("Codex: injected AGENTS.md and environment context are not prompts", async () => {
    const message = (n: number, role: string, text: string) => ({
      timestamp: at(n),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });
    await withTempFile(
      [
        {
          timestamp: at(0),
          type: "session_meta",
          payload: { id: "c1", cwd: "/repo", originator: "codex-tui" },
        },
        message(1, "user", "# AGENTS.md instructions for /repo\n..."),
        message(2, "user", "<environment_context>\n<cwd>/repo</cwd>"),
        message(3, "user", "このバグを直して"), // 人間
        message(4, "assistant", "はい"),
        message(5, "user", "<task-notification>x</task-notification>"),
      ],
      async (path) => {
        const data = await parseCodexFile(path);
        expect(data.originator).toBe("codex-tui");
        expect(data.events.map(([, isPrompt]) => isPrompt)).toEqual([
          false,
          false,
          true,
          false,
          false,
        ]);
        expect(data.nPrompt).toBe(1);
      },
    );
  });
});
