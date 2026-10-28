#!/usr/bin/env bun
/**
 * cc-worklog — Claude Code の稼働時間 / タイムライン分析 (Bun 単一バイナリ)
 *
 * ~/.claude/projects/*.jsonl のセッションログを読み、ギャップベースで
 * 「アクティブ時間」を推定して、依存ゼロ・完全ローカルの HTML を生成する。
 */
import { statSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { parseArgs } from "node:util";

// テンプレートはバイナリに埋め込む(text import)
import dashboardTpl from "./dashboard.html.txt" with { type: "text" };
import timelineTpl from "./timeline.html.txt" with { type: "text" };

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CODEX_DIR = join(homedir(), ".codex", "sessions");
const ANTIGRAVITY_HISTORY = join(homedir(), ".gemini", "antigravity-cli", "history.jsonl");
const KIMI_DIR = join(homedir(), ".kimi-code", "sessions");
const KIMI_WORKSPACES = join(homedir(), ".kimi-code", "workspaces.json");
const CACHE_DIR = join(homedir(), ".cache", "cc-worklog");
const CACHE_VERSION = 6;
const MIN_EPOCH_MS = 1700000000000; // 2023-11 頃
const MAX_EPOCH_SLACK_MS = 2 * 86400 * 1000;
const ALL_SOURCES = ["claude", "codex", "antigravity", "kimi"] as const;

export type FileData = {
  project: string | null;
  events: [number, boolean][]; // [epochMs, isHumanPrompt]
  nAssistant: number;
  nUser: number;
  nPrompt: number;
  sessions: string[];
  originator?: string; // codex のみ: session_meta.originator (codex_exec 等の自動実行判定用)
};

// codex の自動/非対話実行(手作業でない稼働)を判定する originator パターン。
const CODEX_AUTOMATED_RE = /exec|harness|swarm|agent|bot|batch|\bci\b/i;

/**
 * 稼働をどのイベントから判定するか。
 * - "prompt": 人間が打った発言だけで判定する。AIが走っている間の放置を稼働にしない。
 * - "event": AI応答・ツール実行を含む全イベントで判定する(従来方式)。
 */
export type Basis = "prompt" | "event";

// 人間が打っていない、システム/エージェントが注入した user ロールのメッセージの先頭。
const SYNTHETIC_PROMPT_PREFIXES = [
  "<task-notification", // バックグラウンドタスクの完了通知
  "<local-command-caveat", // ローカルコマンド出力の注釈
  "<local-command-stdout",
  "<local-command-stderr",
  "<system-reminder",
  "<environment_context", // Codex: 環境コンテキストの自動注入
  "<recommended_plugins",
  "<turn_aborted",
  "<codex_internal_context", // Codex: goal 継続などの内部注入
  "<user_shell_command",
  "<user_instructions",
  "<image ", // 画像添付のプレースホルダ(本文は別パートに入る)
  "# AGENTS.md instructions", // Codex: AGENTS.md の自動注入
];

export function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_PROMPT_PREFIXES.some((prefix) => t.startsWith(prefix));
}

/** テキストパート群のうち、人間が打った本文が1つでもあるか。 */
function hasHumanText(parts: string[]): boolean {
  return parts.some((t) => t.trim().length > 0 && !isSyntheticPrompt(t));
}

// --------------------------------------------------------------------------- //
// パース
// --------------------------------------------------------------------------- //
function isoToEpoch(t: string): number | null {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

export async function parseFile(path: string): Promise<FileData> {
  let project: string | null = null;
  const events: [number, boolean][] = [];
  let nAssistant = 0,
    nUser = 0,
    nPrompt = 0;
  const sessions = new Set<string>();
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { project, events, nAssistant, nUser, nPrompt, sessions: [] };
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const typ = d.type;
    if (typ !== "user" && typ !== "assistant") continue;
    const ep = isoToEpoch(d.timestamp ?? "");
    if (ep === null) continue;
    if (project === null && d.cwd) project = d.cwd;
    if (d.sessionId) sessions.add(d.sessionId);
    let isPrompt = false;
    if (typ === "assistant") {
      nAssistant++;
    } else {
      nUser++;
      if (!d.isSidechain && !d.isMeta && !d.isCompactSummary) {
        const c = d.message?.content;
        if (typeof c === "string") isPrompt = hasHumanText([c]);
        else if (
          Array.isArray(c) &&
          !c.some((x: any) => x && typeof x === "object" && x.type === "tool_result")
        ) {
          const texts = c
            .filter((x: any) => x && x.type === "text" && typeof x.text === "string")
            .map((x: any) => x.text as string);
          // 本文が無い(画像だけの)発言も人間の入力として数える
          isPrompt = texts.length === 0 || hasHumanText(texts);
        }
      }
      if (isPrompt) nPrompt++;
    }
    events.push([ep, isPrompt]);
  }
  events.sort((a, b) => a[0] - b[0]);
  return { project, events, nAssistant, nUser, nPrompt, sessions: [...sessions] };
}

// Codex CLI のセッションログ (~/.codex/sessions/**/*.jsonl)。
// 各行に top-level timestamp、session_meta.payload.cwd に作業ディレクトリ。
export async function parseCodexFile(path: string): Promise<FileData> {
  let project: string | null = null;
  let originator: string | undefined;
  const events: [number, boolean][] = [];
  let nAssistant = 0,
    nUser = 0,
    nPrompt = 0;
  const sessions = new Set<string>();
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { project, events, nAssistant, nUser, nPrompt, sessions: [] };
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ep = isoToEpoch(d.timestamp ?? "");
    if (ep === null) continue;
    const typ = d.type;
    if (typ === "session_meta") {
      const p = d.payload ?? {};
      if (project === null && p.cwd) project = p.cwd;
      if (originator === undefined && p.originator) originator = String(p.originator);
      if (p.id) sessions.add(p.id);
      continue;
    }
    if (typ !== "event_msg" && typ !== "response_item") continue;
    let isPrompt = false;
    if (typ === "response_item" && d.payload?.type === "message") {
      const role = d.payload.role;
      if (role === "assistant") nAssistant++;
      else if (role === "user") {
        nUser++;
        const parts = (Array.isArray(d.payload.content) ? d.payload.content : [])
          .filter((x: any) => x && typeof x.text === "string")
          .map((x: any) => x.text as string);
        // AGENTS.md や環境コンテキストの自動注入は人間の発言ではない
        if (hasHumanText(parts)) {
          isPrompt = true;
          nPrompt++;
        }
      }
    }
    events.push([ep, isPrompt]);
  }
  events.sort((a, b) => a[0] - b[0]);
  return { project, events, nAssistant, nUser, nPrompt, sessions: [...sessions], originator };
}

// kimi-code は作業ディレクトリを workspaceId でしか持たないので、
// ~/.kimi-code/workspaces.json の workspaceId -> root を引いて実パスに戻す。
let kimiWorkspaceRoots: Map<string, string> | null = null;
function kimiRootOf(workspaceId: string): string | null {
  if (kimiWorkspaceRoots === null) {
    kimiWorkspaceRoots = new Map();
    if (existsSync(KIMI_WORKSPACES)) {
      // 置いてあるのに読めない/壊れているなら、案件が全部 workspaceId のまま
      // 出てしまうので黙って続行しない。
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(KIMI_WORKSPACES, "utf8"));
      } catch (error) {
        throw new Error(
          `kimi の workspaces.json を読めません: ${KIMI_WORKSPACES}: ${(error as Error).message}`,
        );
      }
      for (const [id, ws] of Object.entries<any>(parsed?.workspaces ?? {}))
        if (ws?.root) kimiWorkspaceRoots.set(id, String(ws.root));
    }
  }
  return kimiWorkspaceRoots.get(workspaceId) ?? null;
}

// sessions/<workspaceId>/session_<uuid>/agents/<agent>/wire.jsonl
function kimiWorkspaceIdFromPath(path: string): string | null {
  const rest = path.startsWith(KIMI_DIR) ? path.slice(KIMI_DIR.length).replace(/^\/+/, "") : "";
  const id = rest.split("/")[0];
  return id && id.startsWith("wd_") ? id : null;
}

export async function parseKimiFile(path: string): Promise<FileData> {
  const workspaceId = kimiWorkspaceIdFromPath(path);
  let project: string | null = workspaceId ? (kimiRootOf(workspaceId) ?? workspaceId) : null;
  const events: [number, boolean][] = [];
  let nAssistant = 0,
    nUser = 0,
    nPrompt = 0;
  const sessions = new Set<string>();
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { project, events, nAssistant, nUser, nPrompt, sessions: [] };
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    // metadata 行だけ created_at、他は time。どちらも epoch ms。
    const ep =
      typeof d.time === "number" ? d.time : typeof d.created_at === "number" ? d.created_at : null;
    if (ep === null) continue;
    const typ = d.type as string | undefined;
    if (typ === "runtime.set_binding" && d.workspaceId) {
      const root = kimiRootOf(String(d.workspaceId));
      if (root) project = root;
      continue;
    }
    if (typ === "metadata") continue;
    // turn.prompt = 人間がターンを開始した合図。
    const isPrompt = typ === "turn.prompt";
    if (isPrompt) {
      nPrompt++;
      nUser++;
    } else if (typ === "agent.message.appended") {
      nAssistant++;
    }
    events.push([ep, isPrompt]);
  }
  if (workspaceId) sessions.add(workspaceId);
  events.sort((a, b) => a[0] - b[0]);
  return { project, events, nAssistant, nUser, nPrompt, sessions: [...sessions] };
}

// --------------------------------------------------------------------------- //
// キャッシュ付きロード
// --------------------------------------------------------------------------- //
function cachePath(p: string): string {
  return join(CACHE_DIR, Bun.hash(p).toString(16) + ".json");
}

async function loadCached(p: string, mtimeMs: number, size: number): Promise<FileData | null> {
  try {
    const c: any = JSON.parse(await Bun.file(cachePath(p)).text());
    if (c.v === CACHE_VERSION && c.mtime === mtimeMs && c.size === size) return c.data;
  } catch {}
  return null;
}

async function storeCache(p: string, mtimeMs: number, size: number, data: FileData) {
  try {
    await Bun.write(cachePath(p), JSON.stringify({ v: CACHE_VERSION, mtime: mtimeMs, size, data }));
  } catch {}
}

// dir 配下の *.jsonl を parser でパースし results に入れる。件数を返す。
async function loadJsonlDir(
  dir: string,
  parser: (path: string) => Promise<FileData>,
  useCache: boolean,
  rebuild: boolean,
  results: Map<string, FileData>,
  keep?: (data: FileData) => boolean,
): Promise<{ files: number; stale: number; kept: number }> {
  const glob = new Bun.Glob("**/*.jsonl");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: dir, absolute: true })) files.push(f);

  let kept = 0;
  const stale: { path: string; mtime: number; size: number }[] = [];
  for (const p of files) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (useCache && !rebuild) {
      const cached = await loadCached(p, st.mtimeMs, st.size);
      if (cached) {
        if (!keep || keep(cached)) {
          results.set(p, cached);
          kept++;
        }
        continue;
      }
    }
    stale.push({ path: p, mtime: st.mtimeMs, size: st.size });
  }

  const CONC = 24;
  let i = 0;
  async function worker() {
    while (i < stale.length) {
      const item = stale[i++];
      const data = await parser(item.path);
      await storeCache(item.path, item.mtime, item.size, data); // フィルタ前にキャッシュ
      if (!keep || keep(data)) {
        results.set(item.path, data);
        kept++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, stale.length) }, worker));
  return { files: files.length, stale: stale.length, kept };
}

// Antigravity CLI の履歴 (~/.gemini/antigravity-cli/history.jsonl)。
// 各行 {timestamp(ms), workspace, conversationId} = ユーザープロンプト。workspace 単位に束ねる。
async function loadAntigravity(
  useCache: boolean,
  rebuild: boolean,
  results: Map<string, FileData>,
): Promise<number> {
  if (!existsSync(ANTIGRAVITY_HISTORY)) return 0;
  let st;
  try {
    st = statSync(ANTIGRAVITY_HISTORY);
  } catch {
    return 0;
  }
  const cp = cachePath(ANTIGRAVITY_HISTORY);
  let grouped: Record<string, FileData> | null = null;
  if (useCache && !rebuild) {
    try {
      const c: any = JSON.parse(await Bun.file(cp).text());
      if (c.v === CACHE_VERSION && c.mtime === st.mtimeMs && c.size === st.size) grouped = c.data;
    } catch {}
  }
  if (!grouped) {
    grouped = {};
    const text = await Bun.file(ANTIGRAVITY_HISTORY).text();
    for (const line of text.split("\n")) {
      if (!line.includes('"timestamp"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const ws = d.workspace;
      const ts = d.timestamp;
      if (!ws || typeof ts !== "number") continue;
      let fd = grouped[ws];
      if (!fd)
        fd = grouped[ws] = {
          project: ws,
          events: [],
          nAssistant: 0,
          nUser: 0,
          nPrompt: 0,
          sessions: [],
        };
      fd.events.push([ts, true]);
      fd.nUser++;
      fd.nPrompt++;
      if (d.conversationId && !fd.sessions.includes(d.conversationId))
        fd.sessions.push(d.conversationId);
    }
    for (const fd of Object.values(grouped)) fd.events.sort((a, b) => a[0] - b[0]);
    try {
      await Bun.write(
        cp,
        JSON.stringify({ v: CACHE_VERSION, mtime: st.mtimeMs, size: st.size, data: grouped }),
      );
    } catch {}
  }
  let n = 0;
  for (const [ws, fd] of Object.entries(grouped)) {
    results.set(`antigravity:${ws}`, fd);
    n++;
  }
  return n;
}

async function loadAll(
  sources: Set<string>,
  useCache: boolean,
  rebuild: boolean,
  codexInteractiveOnly: boolean,
): Promise<Map<string, FileData>> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const results = new Map<string, FileData>();
  const parts: string[] = [];

  if (sources.has("claude") && existsSync(PROJECTS_DIR)) {
    const r = await loadJsonlDir(PROJECTS_DIR, parseFile, useCache, rebuild, results);
    parts.push(`claude ${r.files}件`);
  }
  if (sources.has("codex") && existsSync(CODEX_DIR)) {
    const keep = codexInteractiveOnly
      ? (d: FileData) => !CODEX_AUTOMATED_RE.test(d.originator ?? "")
      : undefined;
    const r = await loadJsonlDir(CODEX_DIR, parseCodexFile, useCache, rebuild, results, keep);
    parts.push(
      codexInteractiveOnly ? `codex ${r.kept}/${r.files}件(対話のみ)` : `codex ${r.files}件`,
    );
  }
  if (sources.has("antigravity")) {
    const n = await loadAntigravity(useCache, rebuild, results);
    if (n) parts.push(`antigravity ${n}ワークスペース`);
  }
  if (sources.has("kimi") && existsSync(KIMI_DIR)) {
    const r = await loadJsonlDir(KIMI_DIR, parseKimiFile, useCache, rebuild, results);
    parts.push(`kimi ${r.files}件`);
  }

  if (!results.size) {
    console.error(`ログが見つかりません (sources: ${[...sources].join(",")})`);
    process.exit(1);
  }
  console.error(`[ccw] ${parts.join(" / ")}`);
  return results;
}

// --------------------------------------------------------------------------- //
// プロジェクト名(直近の git リポジトリに巻き取る)
// --------------------------------------------------------------------------- //
const repoCache = new Map<string, string | null>();
function repoRoot(cwd: string): string | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;
  let root: string | null = null;
  let d = cwd.replace(/\/+$/, "");
  const seen: string[] = [];
  while (d && d !== "/") {
    seen.push(d);
    const cached = repoCache.get(d);
    if (cached != null) {
      root = cached;
      break;
    }
    if (existsSync(join(d, ".git"))) {
      root = d;
      break;
    }
    d = dirname(d);
  }
  for (const s of seen) repoCache.set(s, root);
  return root;
}

function projectName(cwd: string | null, path: string): string {
  if (cwd) {
    const root = repoRoot(cwd);
    if (root) return basename(root) || root;
    return basename(cwd.replace(/\/+$/, "")) || cwd;
  }
  const d = basename(dirname(path));
  return d ? d.split("-").pop()! : "(unknown)";
}

/** 除外リストの取得元。どこ由来かを表示できるように残す。 */
type IgnoreOrigin = { label: string; names: string[] };

/** ユーザー単位の設定ファイル。どのディレクトリから実行しても効く。 */
export function userIgnoreFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "cc-worklog", "ctlignore.txt");
}

/** 1 行 1 プロジェクト名、`#` 以降はコメント。 */
function readIgnoreFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // 置いてあるのに読めないのは設定ミス。黙って無視すると
    // 除外したつもりの案件が集計に入り続ける。
    throw new Error(`除外リストを読めません: ${path}: ${(error as Error).message}`);
  }
  return text
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter(Boolean);
}

function loadIgnore(cli: string[] | undefined): { names: Set<string>; origins: IgnoreOrigin[] } {
  const origins: IgnoreOrigin[] = [];
  for (const path of [userIgnoreFile(), join(process.cwd(), "ctlignore.txt")]) {
    if (!existsSync(path)) continue;
    const names = readIgnoreFile(path);
    if (names.length) origins.push({ label: path, names });
  }
  const fromFlag = (cli ?? []).flatMap((item) =>
    item
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
  if (fromFlag.length) origins.push({ label: "--ignore", names: fromFlag });

  const names = new Set<string>();
  for (const origin of origins) for (const n of origin.names) names.add(n);
  return { names, origins };
}

// --------------------------------------------------------------------------- //
// 集計
// --------------------------------------------------------------------------- //
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 集計対象の期間。`covers` が true のイベントだけを数える。 */
export type Period = { label: string; covers: (ep: number) => boolean };

export const ALL_PERIOD: Period = { label: "全期間", covers: () => true };

/** `YYYY-MM` の暦月。ローカルタイムゾーンで判定する。 */
export function monthPeriod(month: string): Period {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month は YYYY-MM 形式で指定してください: ${month}`);
  }
  return {
    label: month,
    covers: (ep) => {
      const d = new Date(ep);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` === month;
    },
  };
}

/** `YYYY-MM-DD` の任意期間。両端を含む（from の 00:00 〜 to の 23:59:59.999、ローカル）。 */
export function rangePeriod(from?: string, to?: string): Period {
  const parseDay = (flag: string, value: string, endOfDay: boolean) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) throw new Error(`${flag} は YYYY-MM-DD 形式で指定してください: ${value}`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = endOfDay
      ? new Date(y, mo - 1, d, 23, 59, 59, 999)
      : new Date(y, mo - 1, d, 0, 0, 0, 0);
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) {
      throw new Error(`${flag} に存在しない日付が指定されました: ${value}`);
    }
    return at.getTime();
  };
  const start = from ? parseDay("--from", from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? parseDay("--to", to, true) : Number.POSITIVE_INFINITY;
  if (start > end) throw new Error(`--from が --to より後になっています: ${from} > ${to}`);
  return {
    label: `${from ?? "最初"} 〜 ${to ?? "最新"}`,
    covers: (ep) => ep >= start && ep <= end,
  };
}

export function analyze(
  results: Map<string, FileData>,
  gapMin: number,
  floorMin: number,
  ignore: Set<string>,
  period: Period = ALL_PERIOD,
  basis: Basis = "prompt",
) {
  const gap = gapMin * 60_000;
  const floor = floorMin * 60_000;
  const inPeriod = period.covers;
  // basis=prompt のときは人間の発言だけが稼働判定の材料になる(AI応答・ツール実行は無視)。
  const counts = (isPrompt: boolean) => basis === "event" || isPrompt;

  const projNames: string[] = [];
  const projIndex = new Map<string, number>();
  const pidOf = (name: string) => {
    let i = projIndex.get(name);
    if (i === undefined) {
      i = projNames.length;
      projIndex.set(name, i);
      projNames.push(name);
    }
    return i;
  };

  const maxEpoch = Date.now() + MAX_EPOCH_SLACK_MS;
  const allEvents: [number, boolean, number][] = []; // [epoch, isPrompt, pid]
  const totals = { assistant: 0, user: 0, prompt: 0 };
  const allSessions = new Set<string>();

  for (const [path, data] of results) {
    if (!data.events.length) continue;
    const name = projectName(data.project, path);
    if (ignore.has(name)) {
      for (const [ep, isPrompt] of data.events)
        if (counts(isPrompt) && ep >= MIN_EPOCH_MS && ep <= maxEpoch && inPeriod(ep))
          allEvents.push([ep, false, -1]);
      continue;
    }
    const pid = pidOf(name);
    totals.assistant += data.nAssistant;
    totals.user += data.nUser;
    totals.prompt += data.nPrompt;
    for (const s of data.sessions) allSessions.add(s);
    for (const [ep, isPrompt] of data.events)
      if (counts(isPrompt) && ep >= MIN_EPOCH_MS && ep <= maxEpoch && inPeriod(ep))
        allEvents.push([ep, isPrompt, pid]);
  }
  allEvents.sort((a, b) => a[0] - b[0]);

  const NP = projNames.length;
  type Day = {
    active: number;
    prompts: number;
    blocks: number;
    projects: Set<number>;
    first: number;
    last: number;
  };
  const daily = new Map<string, Day>();
  const rhythm: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const projActive = Array.from({ length: NP }, () => 0);
  const projPrompts = Array.from({ length: NP }, () => 0);
  const blocks: any[] = [];

  const getDay = (ep: number): Day => {
    const dk = dayKey(ep);
    let d = daily.get(dk);
    if (!d) {
      d = { active: 0, prompts: 0, blocks: 0, projects: new Set(), first: ep, last: ep };
      daily.set(dk, d);
    }
    return d;
  };
  const addActive = (ep: number, pid: number, secs: number) => {
    const d = getDay(ep);
    d.active += secs;
    d.projects.add(pid);
    const dt = new Date(ep);
    const wd = (dt.getDay() + 6) % 7; // Mon=0
    rhythm[wd][dt.getHours()] += secs;
    projActive[pid] += secs;
  };

  let prevEp: number | null = null;
  let prevPid = -1;
  let curBlock: any = null;
  let nBlocks = 0;
  const closeBlock = () => {
    if (curBlock && Object.keys(curBlock.pids).length) {
      blocks.push(curBlock);
      nBlocks++;
      getDay(curBlock.rstart).blocks++;
    }
    curBlock = null;
  };

  for (const [ep, isPrompt, pid] of allEvents) {
    const ignored = pid < 0;
    const newSession = prevEp === null || ep - prevEp > gap;
    if (newSession) {
      closeBlock();
      curBlock = { rstart: ep, rend: ep, prompts: 0, pids: {} as Record<number, number> };
    } else if (prevPid >= 0) {
      const delta = ep - prevEp!;
      addActive(prevEp!, prevPid, delta);
      curBlock.pids[prevPid] = (curBlock.pids[prevPid] || 0) + delta;
    }
    if (!ignored) {
      const d = getDay(ep);
      d.first = Math.min(d.first, ep);
      d.last = Math.max(d.last, ep);
      if (isPrompt) {
        d.prompts++;
        projPrompts[pid]++;
        curBlock.prompts++;
      }
      if (!Object.keys(curBlock.pids).length) {
        addActive(ep, pid, floor);
        curBlock.pids[pid] = floor;
        curBlock.rstart = ep;
      }
      curBlock.rend = ep;
    }
    prevEp = ep;
    prevPid = pid;
  }
  closeBlock();

  // プロジェクト別の案件内セグメントを作る。
  // これは案件ごとに独立して gap 判定するため、並行案件どうしでは重複する。
  const perPid = new Map<number, [number, boolean][]>();
  for (const [ep, isPrompt, pid] of allEvents) {
    if (pid < 0) continue;
    let a = perPid.get(pid);
    if (!a) perPid.set(pid, (a = []));
    a.push([ep, isPrompt]);
  }
  type RawSegment = { pid: number; s: number; e: number; n: number };
  const rawSegments: RawSegment[] = [];
  const segmentsByPid = new Map<number, RawSegment[]>();
  const projLocalActive = Array.from({ length: NP }, () => 0);
  const projLocalDays: Set<string>[] = Array.from({ length: NP }, () => new Set());
  const projLocalLast = Array.from({ length: NP }, () => 0);

  for (const [pid, evs] of perPid) {
    for (const [ep] of evs) projLocalDays[pid].add(dayKey(ep));
  }

  const addRawSegment = (segment: RawSegment) => {
    rawSegments.push(segment);
    let own = segmentsByPid.get(segment.pid);
    if (!own) segmentsByPid.set(segment.pid, (own = []));
    own.push(segment);
    projLocalActive[segment.pid] += segment.e - segment.s;
    projLocalLast[segment.pid] = Math.max(projLocalLast[segment.pid], segment.e);
  };

  for (const [pid, evs] of perPid) {
    let segStart = evs[0][0];
    let last = evs[0][0];
    let segPrompts = evs[0][1] ? 1 : 0;
    for (let k = 1; k < evs.length; k++) {
      const [ep, isp] = evs[k];
      if (ep - last > gap) {
        addRawSegment({ pid, s: segStart, e: last + floor, n: segPrompts });
        segStart = ep;
        segPrompts = 0;
      }
      last = ep;
      segPrompts += isp ? 1 : 0;
    }
    addRawSegment({ pid, s: segStart, e: last + floor, n: segPrompts });
  }

  // 排他的な総稼働時間は変えず、各グローバル作業ブロック内の案件内時間を
  // 重みとして比例按分する。これにより案件別合計は総稼働と必ず一致する。
  const projApportionedActive = Array.from({ length: NP }, () => 0);
  const segmentCursor = Array.from({ length: NP }, () => 0);
  for (const block of blocks) {
    const total = Object.values(block.pids).reduce((sum: number, value) => sum + Number(value), 0);
    if (total <= 0) continue;
    const blockStart = block.rstart as number;
    const blockEnd = (block.rend as number) + floor;
    const weights = new Map<number, number>();

    for (const [pid, own] of segmentsByPid) {
      let cursor = segmentCursor[pid];
      while (cursor < own.length && own[cursor].e <= blockStart) cursor++;
      segmentCursor[pid] = cursor;
      let overlap = 0;
      for (let i = cursor; i < own.length && own[i].s < blockEnd; i++) {
        overlap += Math.max(0, Math.min(own[i].e, blockEnd) - Math.max(own[i].s, blockStart));
      }
      if (overlap > 0) weights.set(pid, overlap);
    }

    const weightTotal = [...weights.values()].reduce((sum, value) => sum + value, 0);
    const apportionedPids: Record<number, number> = {};
    if (weightTotal > 0) {
      for (const [pid, weight] of weights) {
        const share = (total * weight) / weightTotal;
        projApportionedActive[pid] += share;
        apportionedPids[pid] = share;
      }
    } else {
      // 原理上は到達しないが、ログ形式変更時にも総時間を失わないフォールバック。
      for (const [pidText, value] of Object.entries(block.pids)) {
        const pid = Number(pidText);
        const share = Number(value);
        projApportionedActive[pid] += share;
        apportionedPids[pid] = share;
      }
    }
    block.apportionedPids = apportionedPids;
  }

  const laneOrder = Array.from({ length: NP }, (_, i) => i)
    .filter((i) => projApportionedActive[i] > 0)
    .sort((a, b) => projApportionedActive[b] - projApportionedActive[a]);
  const laneOf = new Map<number, number>();
  laneOrder.forEach((pid, idx) => laneOf.set(pid, idx));

  const segments: any[] = [];
  for (const segment of rawSegments) {
    const pid = segment.pid;
    const lane = laneOf.get(pid);
    if (lane === undefined) continue;
    segments.push({ p: lane, s: segment.s, e: segment.e, n: segment.n });
  }
  segments.sort((a, b) => a.s - b.s);
  const laneEnd: number[] = [];
  for (const s of segments) {
    let placed = false;
    for (let i = 0; i < laneEnd.length; i++) {
      if (laneEnd[i] <= s.s) {
        s.y = i;
        laneEnd[i] = s.e;
        placed = true;
        break;
      }
    }
    if (!placed) {
      s.y = laneEnd.length;
      laneEnd.push(s.e);
    }
  }

  const timeline = {
    start: allEvents.length ? allEvents[0][0] : 0,
    end: allEvents.length ? allEvents[allEvents.length - 1][0] + floor : 0,
    nLanes: laneEnd.length,
    lanes: laneOrder.map((pid) => ({
      name: projNames[pid],
      active: round(projApportionedActive[pid] / 3.6e6, 2),
      localActive: round(projLocalActive[pid] / 3.6e6, 2),
    })),
    segments,
    // 総稼働として実際にカウントされる作業ブロック(全案件まとめて gap 判定した区間)
    workBlocks: blocks.map((b) => ({
      s: b.rstart as number,
      e: (b.rend as number) + floor,
      d: Object.values(b.pids as Record<number, number>).reduce((sum, v) => sum + v, 0),
      n: b.prompts as number,
    })),
  };

  // daily 配列化
  const dailyList = [...daily.keys()].sort().map((dk) => {
    const d = daily.get(dk)!;
    return {
      date: dk,
      active: round(d.active / 3.6e6, 3),
      span: round((d.last - d.first) / 3.6e6, 3),
      prompts: d.prompts,
      blocks: d.blocks,
      projects: d.projects.size,
    };
  });

  // projects
  const projects = laneOrder
    .map((i) => ({
      name: projNames[i],
      active: round(projApportionedActive[i] / 3.6e6, 3),
      localActive: round(projLocalActive[i] / 3.6e6, 3),
      exclusiveActive: round(projActive[i] / 3.6e6, 3),
      sharedActive: round(Math.max(0, projLocalActive[i] - projApportionedActive[i]) / 3.6e6, 3),
      days: projLocalDays[i].size,
      prompts: projPrompts[i],
      last: projLocalLast[i] ? dayKey(projLocalLast[i]) : "",
    }))
    .filter((p) => p.active > 0 || p.prompts > 0)
    .sort((a, b) => b.active - a.active);

  // recent blocks
  blocks.sort((a, b) => b.rstart - a.rstart);
  const recent = blocks.slice(0, 50).map((b) => {
    const blockPids = b.apportionedPids ?? b.pids;
    const domPid = Number(
      Object.entries(blockPids).sort((x, y) => (y[1] as number) - (x[1] as number))[0][0],
    );
    const dur = Object.values(b.pids).reduce((s: number, v: any) => s + v, 0) as number;
    const sd = new Date(b.rstart),
      ed = new Date(b.rend);
    return {
      start: `${sd.getFullYear()}-${pad(sd.getMonth() + 1)}-${pad(sd.getDate())} ${pad(sd.getHours())}:${pad(sd.getMinutes())}`,
      end: `${pad(ed.getHours())}:${pad(ed.getMinutes())}`,
      dur: round(dur / 3.6e6, 3),
      project: projNames[domPid],
      prompts: b.prompts,
    };
  });

  // summary
  const totalActive = dailyList.reduce((s, d) => s + d.active, 0);
  const daysActive = dailyList.filter((d) => d.active > 0).length;
  const maxDay = dailyList.reduce((m, d) => (!m || d.active > m.active ? d : m), null as any);
  const hourTot = Array.from({ length: 24 }, () => 0);
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) hourTot[h] += rhythm[w][h];
  const anyHour = hourTot.some((x) => x > 0);
  const busiestHour = anyHour ? hourTot.indexOf(Math.max(...hourTot)) : null;

  const summary = {
    activeHours: round(totalActive, 1),
    daysActive,
    blocks: nBlocks,
    sessions: allSessions.size,
    prompts: totals.prompt,
    assistantMsgs: totals.assistant,
    avgPerDay: daysActive ? round(totalActive / daysActive, 2) : 0,
    maxDay: maxDay ? { date: maxDay.date, hours: maxDay.active } : null,
    firstDate: dailyList.length ? dailyList[0].date : null,
    lastDate: dailyList.length ? dailyList[dailyList.length - 1].date : null,
    busiestHour,
  };

  const now = new Date();
  return {
    generatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    gapMin,
    floorMin,
    basis,
    summary,
    daily: dailyList,
    rhythm: rhythm.map((row) => row.map((s) => round(s / 3.6e6, 3))),
    projects,
    recent,
    timeline,
  };
}

function round(x: number, n: number): number {
  const f = 10 ** n;
  return Math.round(x * f) / f;
}

// --------------------------------------------------------------------------- //
// 出力
// --------------------------------------------------------------------------- //
function injectAll(tpl: string, token: string, value: string): string {
  return tpl.split(token).join(value);
}
export function renderHtml(m: any): string {
  return injectAll(dashboardTpl, "/*__DATA__*/", JSON.stringify(m));
}
// タイムラインの gap つまみで選べる値(分)
export const GAP_CHOICES = [5, 10, 15, 20, 30, 45, 60];

// つまみで切り替えられるよう、各 gap で集計し直したタイムラインを用意する
export function timelinesByGap(
  results: Map<string, FileData>,
  gapMin: number,
  floorMin: number,
  ignore: Set<string>,
  period: Period = ALL_PERIOD,
  basis: Basis = "prompt",
) {
  const gaps = [...new Set([...GAP_CHOICES, gapMin])].sort((a, b) => a - b);
  return gaps.map((g) => {
    const m = g === gapMin ? null : analyze(results, g, floorMin, ignore, period, basis);
    return { gapMin: g, m };
  });
}

export function renderTimeline(m: any, byGap: { gapMin: number; m: any }[] = []): string {
  const meta = { generatedAt: m.generatedAt, tz: m.tz, gapMin: m.gapMin, basis: m.basis };
  const variants = (byGap.length ? byGap : [{ gapMin: m.gapMin, m: null }]).map((v) => {
    const src = v.m ?? m;
    return { gapMin: v.gapMin, activeHours: src.summary.activeHours, ...src.timeline };
  });
  let s = injectAll(timelineTpl, "/*__DATA__*/", JSON.stringify(variants));
  s = injectAll(s, "/*__META__*/", JSON.stringify(meta));
  return s;
}

function printSummary(m: any) {
  const s = m.summary;
  const basisLabel = m.basis === "event" ? "全イベント基準" : "ユーザー発言基準";
  const fix = (v: number) => v.toFixed(1).padStart(7);
  console.log();
  console.log(`  期間            : ${s.firstDate} 〜 ${s.lastDate}  (tz=${m.tz})`);
  console.log(
    `  総アクティブ時間: ${s.activeHours} h  (${basisLabel} gap=${m.gapMin}分 / floor=${m.floorMin}分)`,
  );
  console.log(`  稼働日数        : ${s.daysActive} 日  /  平均 ${s.avgPerDay} h/日`);
  if (s.maxDay) console.log(`  最長の日        : ${s.maxDay.date}  (${s.maxDay.hours} h)`);
  console.log(`  作業ブロック数  : ${s.blocks}  /  Claudeセッション ${s.sessions}`);
  console.log(`  プロンプト数    : ${s.prompts}  /  アシスタント応答 ${s.assistantMsgs}`);
  if (s.busiestHour !== null) console.log(`  最も活発な時間帯: ${pad(s.busiestHour)}:00 台`);
  console.log(`\n  トップ5プロジェクト(按分時間):`);
  for (const p of m.projects.slice(0, 5))
    console.log(`    ${fix(p.active)} h  ${p.name}  (${p.days}日, ${p.prompts}prompts)`);
  console.log();
}

// --------------------------------------------------------------------------- //
// main
// --------------------------------------------------------------------------- //
async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      gap: { type: "string", default: "15" },
      floor: { type: "string", default: "2" },
      basis: { type: "string" }, // prompt(既定) | event
      out: { type: "string", default: "dashboard.html" },
      open: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      ignore: { type: "string", multiple: true },
      json: { type: "string" },
      month: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      source: { type: "string" },
      "codex-mode": { type: "string" }, // interactive(既定) | all
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(
      `cc-worklog — Claude Code / Codex / Antigravity / kimi-code 稼働時間・タイムライン分析\n\n` +
        `使い方: cc-worklog [--open] [--gap 15] [--floor 2] [--out dashboard.html]\n` +
        `        [--basis prompt|event]\n` +
        `        [--source claude,codex,antigravity,kimi] [--codex-mode interactive|all]\n` +
        `        [--ignore name1,name2] [--month YYYY-MM | --from YYYY-MM-DD --to YYYY-MM-DD]\n` +
        `        [--json metrics.json] [--rebuild] [--no-cache]\n\n` +
        `稼働の基準: prompt(既定)=人間が打った発言の間隔だけで判定 / event=AI応答・ツール実行も含む全イベント\n\n` +
        `除外プロジェクトは --ignore と、次の 2 つのファイル(1行1名前, # でコメント)から読む:\n` +
        `  ${userIgnoreFile()}  (ユーザー設定。どこで実行しても効く)\n` +
        `  ./ctlignore.txt                        (実行したディレクトリ)\n`,
    );
    return;
  }

  const gap = Number(values.gap);
  const floor = Number(values.floor);
  const basisArg = (values.basis as string | undefined) ?? "prompt";
  if (basisArg !== "prompt" && basisArg !== "event") {
    throw new Error(`--basis は prompt か event を指定してください (指定値: ${basisArg})`);
  }
  const basis: Basis = basisArg;
  const month = values.month as string | undefined;
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  if (month && (from || to)) {
    throw new Error("--month と --from/--to は同時に指定できません");
  }
  const period = month ? monthPeriod(month) : from || to ? rangePeriod(from, to) : ALL_PERIOD;
  const { names: ignore, origins: ignoreOrigins } = loadIgnore(
    values.ignore as string[] | undefined,
  );
  if (ignore.size) {
    console.error(`[ccw] 除外プロジェクト: ${[...ignore].sort().join(", ")}`);
    for (const origin of ignoreOrigins)
      console.error(`[ccw]   ${origin.label}: ${origin.names.join(", ")}`);
  }

  const sourceArg = (values.source as string | undefined)?.trim();
  const sources = new Set(
    sourceArg && sourceArg !== "all"
      ? sourceArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ALL_SOURCES,
  );
  console.error(`[ccw] ソース: ${[...sources].join(", ")}`);
  console.error(
    `[ccw] 稼働の基準: ${basis === "prompt" ? "ユーザー発言(人間が打った発言の間隔)" : "全イベント(AI応答・ツール実行を含む)"}`,
  );
  const codexInteractiveOnly = (values["codex-mode"] as string | undefined) !== "all";
  if (sources.has("codex"))
    console.error(
      `[ccw] codex: ${codexInteractiveOnly ? "対話のみ(codex_exec等の自動実行を除外)" : "全て"}`,
    );
  if (period !== ALL_PERIOD) console.error(`[ccw] 対象期間: ${period.label}`);
  const results = await loadAll(sources, !values["no-cache"], values.rebuild, codexInteractiveOnly);
  const metrics = analyze(results, gap, floor, ignore, period, basis);

  const outPath = values.out!;
  await Bun.write(outPath, renderHtml(metrics));
  console.error(`[ccw] HTML 出力: ${resolve(outPath)}`);

  const tlPath = join(dirname(resolve(outPath)), "timeline.html");
  const byGap = timelinesByGap(results, gap, floor, ignore, period, basis);
  await Bun.write(tlPath, renderTimeline(metrics, byGap));
  console.error(`[ccw] タイムライン出力: ${tlPath}`);

  if (values.json) {
    await Bun.write(values.json, JSON.stringify(metrics, null, 2));
    console.error(`[ccw] JSON 出力: ${resolve(values.json)}`);
  }

  printSummary(metrics);

  if (values.open) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    Bun.spawn([opener, resolve(outPath)]);
  }
}

if (import.meta.main) main();
