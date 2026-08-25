import { describe, expect, test } from "bun:test";
import { analyze, type FileData } from "../src/index.ts";

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
      "2026-08",
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
      "2026-08",
    );

    expect(metrics.projects).toHaveLength(1);
    expect(metrics.projects[0].name).toBe("project-a");
    expect(metrics.projects[0].active).toBe(0.2);
    expect(metrics.projects[0].localActive).toBe(0.2);
  });
});
