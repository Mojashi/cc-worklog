#!/usr/bin/env bun
/**
 * デモ用の合成データを生成し、dashboard/timeline の HTML を書き出す。
 * 実データ(~/.claude)は一切使わない。README のスクショ用。
 * 使い方: bun run scripts/gen-demo.ts <outDir>
 */
import { analyze, renderHtml, renderTimeline, timelinesByGap, type FileData } from "../src/index.ts";
import { join } from "node:path";

// 決定論的な擬似乱数(seed)
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

const PROJECTS = [
  "web-app", "api-server", "data-pipeline", "mobile-app", "infra",
  "ml-trainer", "docs-site", "cli-tools", "auth-service", "billing",
  "search-index", "notif-worker", "playground", "scripts",
];

// 直近 ~140 日(終端は固定の基準日にして決定論的に)
const END = new Date(2026, 5, 22, 18, 0, 0).getTime(); // 2026-06-22
const DAYS = 140;
const MIN = 60_000;

const byProject = new Map<string, [number, boolean][]>();
const ensure = (name: string) => {
  let a = byProject.get(name);
  if (!a) byProject.set(name, (a = []));
  return a;
};

for (let day = DAYS; day >= 0; day--) {
  const base = END - day * 86400_000;
  const d = new Date(base);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  // その日に触るプロジェクト数(平日多め)
  const nProj = weekend ? Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < nProj; k++) {
    const name = pick(PROJECTS);
    const ev = ensure(name);
    // 作業ブロック: 9-23時のどこかで開始、20-180分
    const startHour = 9 + Math.floor(rnd() * 13);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour, Math.floor(rnd() * 60)).getTime();
    const durMin = 20 + Math.floor(rnd() * 160);
    const end = t + durMin * MIN;
    let i = 0;
    while (t < end) {
      ev.push([t, i % 3 === 0]); // 3イベントに1回ユーザープロンプト
      t += (1 + Math.floor(rnd() * 6)) * MIN; // 1-6分間隔
      i++;
    }
  }
}

const results = new Map<string, FileData>();
for (const [name, events] of byProject) {
  events.sort((a, b) => a[0] - b[0]);
  const nPrompt = events.filter((e) => e[1]).length;
  results.set(`/demo/${name}`, {
    project: `/home/demo/repos/${name}`,
    events,
    nAssistant: events.length - nPrompt,
    nUser: nPrompt,
    nPrompt,
    sessions: events.map((_, i) => `${name}-${i}`),
  });
}

const metrics = analyze(results, 15, 2, new Set());
const outDir = Bun.argv[2] || ".";
await Bun.write(join(outDir, "demo-dashboard.html"), renderHtml(metrics));
await Bun.write(
  join(outDir, "demo-timeline.html"),
  renderTimeline(metrics, timelinesByGap(results, 15, 2, new Set())),
);
console.log(`wrote demo HTML to ${outDir} (active ${metrics.summary.activeHours}h, ${metrics.projects.length} projects)`);
