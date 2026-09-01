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
const CACHE_DIR = join(homedir(), ".cache", "cc-worklog");
const CACHE_VERSION = 5;
const MIN_EPOCH_MS = 1700000000000; // 2023-11 頃
const MAX_EPOCH_SLACK_MS = 2 * 86400 * 1000;
const ALL_SOURCES = ["claude", "codex", "antigravity"] as const;

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

// --------------------------------------------------------------------------- //
// パース
// --------------------------------------------------------------------------- //
function isoToEpoch(t: string): number | null {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

async function parseFile(path: string): Promise<FileData> {
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
      if (!d.isSidechain) {
        const c = d.message?.content;
        if (typeof c === "string") isPrompt = c.trim().length > 0;
        else if (Array.isArray(c))
          isPrompt = !c.some((x: any) => x && typeof x === "object" && x.type === "tool_result");
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
async function parseCodexFile(path: string): Promise<FileData> {
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
        isPrompt = true;
        nPrompt++;
      }
    }
    events.push([ep, isPrompt]);
  }
  events.sort((a, b) => a[0] - b[0]);
  return { project, events, nAssistant, nUser, nPrompt, sessions: [...sessions], originator };
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

function loadIgnore(cli: string[] | undefined): Set<string> {
  const names = new Set<string>();
  const cfg = join(process.cwd(), "ctlignore.txt");
  if (existsSync(cfg)) {
    try {
      for (let line of readFileSync(cfg, "utf8").split("\n")) {
        line = line.split("#")[0].trim();
        if (line) names.add(line);
      }
    } catch {}
  }
  for (const item of cli ?? [])
    for (const n of item.split(",")) {
      const t = n.trim();
      if (t) names.add(t);
    }
  return names;
}

// --------------------------------------------------------------------------- //
// 集計
// --------------------------------------------------------------------------- //
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function analyze(
  results: Map<string, FileData>,
  gapMin: number,
  floorMin: number,
  ignore: Set<string>,
  month?: string,
) {
  const gap = gapMin * 60_000;
  const floor = floorMin * 60_000;
  const inMonth = month
    ? (ep: number) => {
        const d = new Date(ep);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` === month;
      }
    : () => true;

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
      for (const [ep] of data.events)
        if (ep >= MIN_EPOCH_MS && ep <= maxEpoch && inMonth(ep)) allEvents.push([ep, false, -1]);
      continue;
    }
    const pid = pidOf(name);
    totals.assistant += data.nAssistant;
    totals.user += data.nUser;
    totals.prompt += data.nPrompt;
    for (const s of data.sessions) allSessions.add(s);
    for (const [ep, isPrompt] of data.events)
      if (ep >= MIN_EPOCH_MS && ep <= maxEpoch && inMonth(ep)) allEvents.push([ep, isPrompt, pid]);
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
export function renderTimeline(m: any): string {
  const meta = { generatedAt: m.generatedAt, tz: m.tz, gapMin: m.gapMin };
  let s = injectAll(timelineTpl, "/*__DATA__*/", JSON.stringify(m.timeline));
  s = injectAll(s, "/*__META__*/", JSON.stringify(meta));
  return s;
}

function printSummary(m: any) {
  const s = m.summary;
  const fix = (v: number) => v.toFixed(1).padStart(7);
  console.log();
  console.log(`  期間            : ${s.firstDate} 〜 ${s.lastDate}  (tz=${m.tz})`);
  console.log(
    `  総アクティブ時間: ${s.activeHours} h  (gap=${m.gapMin}分 / floor=${m.floorMin}分)`,
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
      out: { type: "string", default: "dashboard.html" },
      open: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      ignore: { type: "string", multiple: true },
      json: { type: "string" },
      month: { type: "string" },
      source: { type: "string" },
      "codex-mode": { type: "string" }, // interactive(既定) | all
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(
      `cc-worklog — Claude Code / Codex / Antigravity 稼働時間・タイムライン分析\n\n` +
        `使い方: cc-worklog [--open] [--gap 15] [--floor 2] [--out dashboard.html]\n` +
        `        [--source claude,codex,antigravity] [--codex-mode interactive|all]\n` +
        `        [--ignore name1,name2] [--month YYYY-MM] [--json metrics.json] [--rebuild] [--no-cache]\n`,
    );
    return;
  }

  const gap = Number(values.gap);
  const floor = Number(values.floor);
  const month = values.month as string | undefined;
  const ignore = loadIgnore(values.ignore as string[] | undefined);
  if (ignore.size) console.error(`[ccw] 除外プロジェクト: ${[...ignore].sort().join(", ")}`);

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
  const codexInteractiveOnly = (values["codex-mode"] as string | undefined) !== "all";
  if (sources.has("codex"))
    console.error(
      `[ccw] codex: ${codexInteractiveOnly ? "対話のみ(codex_exec等の自動実行を除外)" : "全て"}`,
    );
  if (month) console.error(`[ccw] 対象月: ${month}`);
  const results = await loadAll(sources, !values["no-cache"], values.rebuild, codexInteractiveOnly);
  const metrics = analyze(results, gap, floor, ignore, month);

  const outPath = values.out!;
  await Bun.write(outPath, renderHtml(metrics));
  console.error(`[ccw] HTML 出力: ${resolve(outPath)}`);

  const tlPath = join(dirname(resolve(outPath)), "timeline.html");
  await Bun.write(tlPath, renderTimeline(metrics));
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
