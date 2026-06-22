#!/usr/bin/env bun
/** 各OS/アーキ向けに単一バイナリをクロスコンパイルして dist/ に出力する。 */
import { mkdirSync } from "node:fs";

const TARGETS: [target: string, outfile: string][] = [
  ["bun-linux-x64", "cc-worklog-linux-x64"],
  ["bun-linux-arm64", "cc-worklog-linux-arm64"],
  ["bun-darwin-x64", "cc-worklog-darwin-x64"],
  ["bun-darwin-arm64", "cc-worklog-darwin-arm64"],
  ["bun-windows-x64", "cc-worklog-windows-x64.exe"],
];

mkdirSync("dist", { recursive: true });

for (const [target, outfile] of TARGETS) {
  console.log(`\n=== building ${outfile} (${target}) ===`);
  const p = Bun.spawnSync(
    [
      "bun",
      "build",
      "src/index.ts",
      "--compile",
      "--minify",
      `--target=${target}`,
      `--outfile=dist/${outfile}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0) {
    console.error(`build failed for ${target}`);
    process.exit(p.exitCode ?? 1);
  }
}
console.log("\nall builds done -> dist/");
