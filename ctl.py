#!/usr/bin/env python3
"""
claude-tl (ctl) — Claude Code の稼働時間 / タイムライン分析

~/.claude/projects/*/*.jsonl のセッションログを読み、
「アクティブ時間（実際に手を動かしていた時間）」をギャップベースで推定し、
単一HTMLダッシュボード(依存ゼロ・完全ローカル)を生成する。

使い方:
    python3 ctl.py                # 全期間を解析して dashboard.html を生成
    python3 ctl.py --open         # 生成後にブラウザで開く
    python3 ctl.py --gap 20       # 無操作20分で作業ブロックを区切る(既定15分)
    python3 ctl.py --rebuild      # キャッシュを無視して全ファイル再パース
    python3 ctl.py --out foo.html # 出力先指定

アクティブ時間の定義:
    全プロジェクト横断で user/assistant イベントを時系列マージし、
    連続イベントの間隔が --gap(既定15分)以内なら稼働中とみなして合算する。
    作業ブロックの先頭には --floor(既定2分)分の下駄を履かせ、
    単発プロンプトや最後の思考時間を補正する。
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import sys
import webbrowser
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
CACHE_DIR = os.path.expanduser("~/.cache/claude-tl")
CACHE_VERSION = 3  # parse_file の出力フォーマットを変えたら上げる

# Claude Code が存在しなかった時刻のイベントは壊れたtimestampとして除外する
MIN_EPOCH = 1700000000.0  # 2023-11-14 頃
MAX_EPOCH_SLACK = 2 * 86400.0  # 現在時刻+2日まで許容


# --------------------------------------------------------------------------- #
# パース (worker)
# --------------------------------------------------------------------------- #
def _iso_to_epoch(t: str) -> float | None:
    # "2026-04-16T08:09:15.791Z"
    try:
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        return datetime.fromisoformat(t).timestamp()
    except Exception:
        return None


def parse_file(path: str) -> dict:
    """1つの jsonl を読み、コンパクトな要約を返す。chronological 前提だが念のためソートする。"""
    proj = None
    events: list[tuple[float, bool]] = []  # (epoch, is_human_prompt)
    n_assistant = n_user = n_prompt = 0
    sessions: set[str] = set()
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"timestamp"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                typ = d.get("type")
                if typ not in ("user", "assistant"):
                    continue
                ep = _iso_to_epoch(d.get("timestamp") or "")
                if ep is None:
                    continue
                if proj is None and d.get("cwd"):
                    proj = d["cwd"]
                sid = d.get("sessionId")
                if sid:
                    sessions.add(sid)
                is_prompt = False
                if typ == "assistant":
                    n_assistant += 1
                else:
                    n_user += 1
                    if not d.get("isSidechain"):
                        msg = d.get("message") or {}
                        c = msg.get("content")
                        if isinstance(c, str):
                            is_prompt = bool(c.strip())
                        elif isinstance(c, list):
                            is_prompt = not any(
                                isinstance(x, dict) and x.get("type") == "tool_result"
                                for x in c
                            )
                    if is_prompt:
                        n_prompt += 1
                events.append((ep, is_prompt))
    except Exception:
        pass
    events.sort(key=lambda e: e[0])
    return {
        "project": proj,
        "events": events,
        "n_assistant": n_assistant,
        "n_user": n_user,
        "n_prompt": n_prompt,
        "sessions": list(sessions),
    }


# --------------------------------------------------------------------------- #
# キャッシュ付きロード
# --------------------------------------------------------------------------- #
def _cache_path(jsonl_path: str) -> str:
    import hashlib

    h = hashlib.sha1(jsonl_path.encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{h}.pkl")


def _load_cached(jsonl_path: str, st: os.stat_result):
    cp = _cache_path(jsonl_path)
    try:
        with open(cp, "rb") as f:
            c = pickle.load(f)
        if (
            c.get("v") == CACHE_VERSION
            and c.get("mtime") == st.st_mtime
            and c.get("size") == st.st_size
        ):
            return c["data"]
    except Exception:
        pass
    return None


def _store_cache(jsonl_path: str, st: os.stat_result, data: dict):
    cp = _cache_path(jsonl_path)
    try:
        with open(cp, "wb") as f:
            pickle.dump(
                {"v": CACHE_VERSION, "mtime": st.st_mtime, "size": st.st_size, "data": data},
                f,
                protocol=pickle.HIGHEST_PROTOCOL,
            )
    except Exception:
        pass


def _parse_and_cache(jsonl_path: str) -> dict:
    data = parse_file(jsonl_path)
    try:
        _store_cache(jsonl_path, os.stat(jsonl_path), data)
    except Exception:
        pass
    return data


def load_all(use_cache: bool = True, rebuild: bool = False):
    if not os.path.isdir(PROJECTS_DIR):
        sys.exit(f"見つかりません: {PROJECTS_DIR}")
    os.makedirs(CACHE_DIR, exist_ok=True)

    files = []
    for root, _, names in os.walk(PROJECTS_DIR):
        for n in names:
            if n.endswith(".jsonl"):
                files.append(os.path.join(root, n))

    results: dict[str, dict] = {}
    stale: list[str] = []
    for p in files:
        try:
            st = os.stat(p)
        except OSError:
            continue
        if use_cache and not rebuild:
            cached = _load_cached(p, st)
            if cached is not None:
                results[p] = cached
                continue
        stale.append(p)

    print(
        f"[ctl] jsonl {len(files)} 件 / 要パース {len(stale)} 件 "
        f"(キャッシュ {len(files) - len(stale)} 件)",
        file=sys.stderr,
    )

    if stale:
        workers = min(os.cpu_count() or 4, 8)
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for p, data in zip(stale, ex.map(_parse_and_cache, stale, chunksize=16)):
                results[p] = data

    return results


# --------------------------------------------------------------------------- #
# 集計
# --------------------------------------------------------------------------- #
_repo_cache: dict[str, str | None] = {}


def repo_root(cwd: str) -> str | None:
    """cwd から親方向に辿り、最初に .git を含むディレクトリ(リポジトリルート)を返す。
    見つからない / ディレクトリが存在しない場合は None。結果はキャッシュする。"""
    if cwd in _repo_cache:
        return _repo_cache[cwd]
    root = None
    d = cwd.rstrip("/")
    seen = []
    while d and d != "/":
        seen.append(d)
        cached = _repo_cache.get(d)
        if cached is not None:
            root = cached
            break
        if os.path.isdir(os.path.join(d, ".git")):
            root = d
            break
        d = os.path.dirname(d)
    for s in seen:
        _repo_cache[s] = root  # 経路上のディレクトリも同じルートにマップ
    return root


def project_name(cwd: str | None, path: str) -> str:
    if cwd:
        root = repo_root(cwd)
        if root:  # 直近の git リポジトリに巻き取る
            return os.path.basename(root) or root
        base = os.path.basename(cwd.rstrip("/"))  # gitが見つからなければcwd自体
        return base or cwd
    # フォールバック: ディレクトリ名 "-Users-you-repos-foo" の末尾
    d = os.path.basename(os.path.dirname(path))
    return d.split("-")[-1] if d else "(unknown)"


def load_ignore(cli_ignore: list[str] | None) -> set[str]:
    """ctlignore.txt(スクリプトと同じディレクトリ) と --ignore から除外プロジェクト名を集める。"""
    names: set[str] = set()
    cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ctlignore.txt")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    names.add(line)
    except FileNotFoundError:
        pass
    for item in cli_ignore or []:
        for n in item.split(","):
            n = n.strip()
            if n:
                names.add(n)
    return names


def analyze(results: dict[str, dict], gap_min: float, floor_min: float,
            ignore: set[str] | None = None) -> dict:
    gap = gap_min * 60.0
    floor = floor_min * 60.0
    ignore = ignore or set()

    # ファイルごとに project id を確定
    proj_names: list[str] = []
    proj_index: dict[str, int] = {}

    def pid_of(name: str) -> int:
        i = proj_index.get(name)
        if i is None:
            i = len(proj_names)
            proj_index[name] = i
            proj_names.append(name)
        return i

    max_epoch = datetime.now().timestamp() + MAX_EPOCH_SLACK
    all_events: list[tuple[float, bool, int]] = []  # (epoch, is_prompt, pid)
    totals = {"assistant": 0, "user": 0, "prompt": 0}
    all_sessions: set[str] = set()

    for path, data in results.items():
        if not data["events"]:
            continue
        name = project_name(data.get("project"), path)
        # 除外プロジェクトは pid=-1 のアンカーとして残す(時間は計上しないが、
        # タイムライン上の区切りとして機能させ、隣接プロジェクトに時間が吸われるのを防ぐ)
        if name in ignore:
            for ep, _ in data["events"]:
                if MIN_EPOCH <= ep <= max_epoch:
                    all_events.append((ep, False, -1))
            continue
        pid = pid_of(name)
        totals["assistant"] += data["n_assistant"]
        totals["user"] += data["n_user"]
        totals["prompt"] += data["n_prompt"]
        all_sessions.update(data["sessions"])
        for ep, is_prompt in data["events"]:
            if ep < MIN_EPOCH or ep > max_epoch:
                continue  # 壊れたtimestampを除外
            all_events.append((ep, is_prompt, pid))

    all_events.sort(key=lambda t: t[0])

    # 集計バケツ
    daily: dict[str, dict] = {}      # "YYYY-MM-DD" -> {active, prompts, blocks, projects:set, first, last}
    rhythm = [[0.0] * 24 for _ in range(7)]   # [weekday(Mon=0)][hour] -> active seconds
    proj_active = [0.0] * len(proj_names)
    proj_days: list[set] = [set() for _ in proj_names]
    proj_last = [0.0] * len(proj_names)
    proj_prompts = [0] * len(proj_names)  # 後述: プロンプトは per-file 集計なので別途
    blocks: list[dict] = []  # 作業ブロック {start,end,pid,prompts}

    def day_key(ep: float) -> str:
        return datetime.fromtimestamp(ep).strftime("%Y-%m-%d")

    def add_active(ep: float, pid: int, secs: float):
        dk = day_key(ep)
        d = daily.get(dk)
        if d is None:
            d = daily[dk] = {"active": 0.0, "prompts": 0, "blocks": 0, "projects": set(),
                             "first": ep, "last": ep}
        d["active"] += secs
        d["projects"].add(pid)
        dt = datetime.fromtimestamp(ep)
        rhythm[dt.weekday()][dt.hour] += secs
        proj_active[pid] += secs
        proj_days[pid].add(dk)
        if ep > proj_last[pid]:
            proj_last[pid] = ep

    prev_ep: float | None = None
    prev_pid: int = -1
    cur_block: dict | None = None  # {rstart,rend,prompts,pids:{pid:secs}}
    n_blocks_total = 0

    def close_block():
        nonlocal cur_block, n_blocks_total
        if cur_block is not None and cur_block["pids"]:
            blocks.append(cur_block)
            n_blocks_total += 1
            daily[day_key(cur_block["rstart"])]["blocks"] += 1
        cur_block = None

    for ep, is_prompt, pid in all_events:
        ignored = pid < 0
        new_session = prev_ep is None or (ep - prev_ep) > gap

        if new_session:
            close_block()
            cur_block = {"rstart": ep, "rend": ep, "prompts": 0, "pids": {}}
        elif prev_pid >= 0:
            # セッション内の連続イベント: 間隔を直前イベントのプロジェクトに按分。
            # 直前が除外プロジェクト(pid<0)なら計上しない=その時間は誰にも帰属しない。
            assert prev_ep is not None and cur_block is not None
            delta = ep - prev_ep
            add_active(prev_ep, prev_pid, delta)
            cur_block["pids"][prev_pid] = cur_block["pids"].get(prev_pid, 0.0) + delta

        if not ignored:
            assert cur_block is not None
            dk = day_key(ep)
            d = daily.get(dk)
            if d is None:
                d = daily[dk] = {"active": 0.0, "prompts": 0, "blocks": 0,
                                 "projects": set(), "first": ep, "last": ep}
            d["first"] = min(d["first"], ep)
            d["last"] = max(d["last"], ep)
            if is_prompt:
                d["prompts"] += 1
                proj_prompts[pid] += 1
                cur_block["prompts"] += 1
            if not cur_block["pids"]:
                # ブロック内で最初に計上される実イベント -> 下駄を履かせる
                add_active(ep, pid, floor)
                cur_block["pids"][pid] = floor
                cur_block["rstart"] = ep
            cur_block["rend"] = ep

        prev_ep = ep
        prev_pid = pid

    close_block()

    # プロジェクト別の稼働セグメント(スイムレーン用)。
    # 各プロジェクトのイベントを gap で区切り、連続作業を1本のバーにする。
    perpid: dict[int, list[tuple[float, bool]]] = {}
    for ep, is_prompt, pid in all_events:
        if pid >= 0:
            perpid.setdefault(pid, []).append((ep, is_prompt))

    # レーン順 = アクティブ時間降順
    lane_order = sorted(
        (i for i in range(len(proj_names)) if proj_active[i] > 0),
        key=lambda i: proj_active[i], reverse=True,
    )
    lane_of = {pid: idx for idx, pid in enumerate(lane_order)}

    segments = []  # {p:lane, s:startMs, e:endMs, n:prompts}
    for pid, evs in perpid.items():
        lane = lane_of.get(pid)
        if lane is None:
            continue
        seg_start = evs[0][0]
        last = evs[0][0]
        seg_prompts = int(evs[0][1])
        for ep, isp in evs[1:]:
            if ep - last > gap:
                segments.append({"p": lane, "s": int(seg_start * 1000),
                                 "e": int((last + floor) * 1000), "n": seg_prompts})
                seg_start = ep
                seg_prompts = 0
            last = ep
            seg_prompts += int(isp)
        segments.append({"p": lane, "s": int(seg_start * 1000),
                         "e": int((last + floor) * 1000), "n": seg_prompts})

    # 貪欲レーン詰め: 各セッションを「空いている最も上の行」に置く(行を再利用)。
    # 行数 = その時々の最大並行数。
    segments.sort(key=lambda s: s["s"])
    lane_end: list[int] = []  # 各行の最終終了時刻(ms)
    for s in segments:
        placed = False
        for i, end in enumerate(lane_end):
            if end <= s["s"]:
                s["y"] = i
                lane_end[i] = s["e"]
                placed = True
                break
        if not placed:
            s["y"] = len(lane_end)
            lane_end.append(s["e"])

    timeline = {
        "start": int(all_events[0][0] * 1000) if all_events else 0,
        "end": int((all_events[-1][0] + floor) * 1000) if all_events else 0,
        "nLanes": len(lane_end),
        "lanes": [{"name": proj_names[pid], "active": round(proj_active[pid] / 3600.0, 2)}
                  for pid in lane_order],
        "segments": segments,
    }

    # daily を配列化
    daily_list = []
    for dk in sorted(daily.keys()):
        d = daily[dk]
        span = (d["last"] - d["first"])
        daily_list.append({
            "date": dk,
            "active": round(d["active"] / 3600.0, 3),
            "span": round(span / 3600.0, 3),
            "prompts": d["prompts"],
            "blocks": d["blocks"],
            "projects": len(d["projects"]),
        })

    # projects
    projects = []
    for i, name in enumerate(proj_names):
        if proj_active[i] <= 0 and proj_prompts[i] == 0:
            continue
        projects.append({
            "name": name,
            "active": round(proj_active[i] / 3600.0, 3),
            "days": len(proj_days[i]),
            "prompts": proj_prompts[i],
            "last": datetime.fromtimestamp(proj_last[i]).strftime("%Y-%m-%d") if proj_last[i] else "",
        })
    projects.sort(key=lambda p: p["active"], reverse=True)

    # recent blocks (作業ブロック) — 直近50件、ブロック主プロジェクト付き
    blocks.sort(key=lambda b: b["rstart"], reverse=True)
    recent = []
    for b in blocks[:50]:
        dom_pid = max(b["pids"].items(), key=lambda kv: kv[1])[0]
        dur = sum(b["pids"].values())  # 計上された稼働秒(下駄込み)
        recent.append({
            "start": datetime.fromtimestamp(b["rstart"]).strftime("%Y-%m-%d %H:%M"),
            "end": datetime.fromtimestamp(b["rend"]).strftime("%H:%M"),
            "dur": round(dur / 3600.0, 3),
            "project": proj_names[dom_pid],
            "prompts": b["prompts"],
        })

    # summary
    total_active = sum(d["active"] for d in daily_list)
    days_active = len([d for d in daily_list if d["active"] > 0])
    max_day = max(daily_list, key=lambda d: d["active"], default=None)
    # busiest hour
    hour_tot = [0.0] * 24
    for w in range(7):
        for h in range(24):
            hour_tot[h] += rhythm[w][h]
    busiest_hour = max(range(24), key=lambda h: hour_tot[h]) if any(hour_tot) else None

    summary = {
        "activeHours": round(total_active, 1),
        "daysActive": days_active,
        "blocks": n_blocks_total,
        "sessions": len(all_sessions),
        "prompts": totals["prompt"],
        "assistantMsgs": totals["assistant"],
        "avgPerDay": round(total_active / days_active, 2) if days_active else 0,
        "maxDay": {"date": max_day["date"], "hours": max_day["active"]} if max_day else None,
        "firstDate": daily_list[0]["date"] if daily_list else None,
        "lastDate": daily_list[-1]["date"] if daily_list else None,
        "busiestHour": busiest_hour,
    }

    return {
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "tz": datetime.now().astimezone().tzname() or "local",
        "gapMin": gap_min,
        "floorMin": floor_min,
        "summary": summary,
        "daily": daily_list,
        "rhythm": [[round(s / 3600.0, 3) for s in row] for row in rhythm],
        "projects": projects,
        "recent": recent,
        "timeline": timeline,
    }


# --------------------------------------------------------------------------- #
# HTML 出力
# --------------------------------------------------------------------------- #
def render_html(metrics: dict) -> str:
    data_json = json.dumps(metrics, ensure_ascii=False)
    return HTML_TEMPLATE.replace("/*__DATA__*/", data_json)


def render_timeline(metrics: dict) -> str:
    data_json = json.dumps(metrics["timeline"], ensure_ascii=False)
    meta = {"generatedAt": metrics["generatedAt"], "tz": metrics["tz"],
            "gapMin": metrics["gapMin"]}
    return (TIMELINE_HTML
            .replace("/*__DATA__*/", data_json)
            .replace("/*__META__*/", json.dumps(meta, ensure_ascii=False)))


def print_summary(m: dict):
    s = m["summary"]
    print()
    print(f"  期間            : {s['firstDate']} 〜 {s['lastDate']}  (tz={m['tz']})")
    print(f"  総アクティブ時間: {s['activeHours']} h  (gap={m['gapMin']}分 / floor={m['floorMin']}分)")
    print(f"  稼働日数        : {s['daysActive']} 日  /  平均 {s['avgPerDay']} h/日")
    if s["maxDay"]:
        print(f"  最長の日        : {s['maxDay']['date']}  ({s['maxDay']['hours']} h)")
    print(f"  作業ブロック数  : {s['blocks']}  /  Claudeセッション {s['sessions']}")
    print(f"  プロンプト数    : {s['prompts']}  /  アシスタント応答 {s['assistantMsgs']}")
    if s["busiestHour"] is not None:
        print(f"  最も活発な時間帯: {s['busiestHour']:02d}:00 台")
    print(f"\n  トップ5プロジェクト(アクティブ時間):")
    for p in m["projects"][:5]:
        print(f"    {p['active']:>7.1f} h  {p['name']}  ({p['days']}日, {p['prompts']}prompts)")
    print()


HTML_TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code 稼働時間ダッシュボード</title>
<style>
:root{
  --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e;
  --accent:#d97757; --accent2:#58a6ff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Segoe UI",sans-serif;}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.card .v{font-size:24px;font-weight:700}
.card .l{font-size:12px;color:var(--muted);margin-top:2px}
.card .s{font-size:11px;color:var(--muted);margin-top:6px}
section{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:22px}
section h2{font-size:14px;margin:0 0 14px;color:var(--fg)}
.legend{font-size:11px;color:var(--muted);display:flex;gap:6px;align-items:center;margin-top:8px}
.legend i{width:11px;height:11px;border-radius:2px;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:12px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:8px;background:var(--accent);border-radius:3px;display:inline-block;vertical-align:middle}
.scroll{max-height:420px;overflow:auto}
svg{display:block;max-width:100%}
.cell:hover{stroke:#fff;stroke-width:1px}
.tip{position:fixed;pointer-events:none;background:#000;border:1px solid var(--border);
  padding:6px 8px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .1s;z-index:10;white-space:nowrap}
.muted{color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Claude Code 稼働時間ダッシュボード</h1>
  <div class="sub" id="meta"></div>
  <a href="timeline.html" style="display:inline-block;margin:0 0 22px;padding:9px 16px;
    background:var(--accent);color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
    ▶ 並行作業タイムライン（スイムレーン）を開く</a>
  <div class="cards" id="cards"></div>

  <section>
    <h2>稼働カレンダー（日別アクティブ時間 / GitHub風）</h2>
    <div id="cal"></div>
    <div class="legend">少 <i style="background:#161b22;border:1px solid #30363d"></i>
      <i style="background:#0e4429"></i><i style="background:#006d32"></i>
      <i style="background:#26a641"></i><i style="background:#39d353"></i> 多</div>
  </section>

  <section>
    <h2>日別アクティブ時間（直近90日）</h2>
    <div id="bars"></div>
  </section>

  <section>
    <h2>生活リズム（曜日 × 時間帯のアクティブ時間）</h2>
    <div id="rhythm"></div>
  </section>

  <section>
    <h2>プロジェクト別アクティブ時間</h2>
    <div class="scroll"><table id="projects"></table></div>
  </section>

  <section>
    <h2>直近の作業ブロック</h2>
    <div class="scroll"><table id="recent"></table></div>
  </section>
</div>
<div class="tip" id="tip"></div>
<script>
const DATA = /*__DATA__*/;
const tip = document.getElementById('tip');
function showTip(e,html){tip.innerHTML=html;tip.style.opacity=1;
  tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';}
function hideTip(){tip.style.opacity=0;}
const fmtH = h => h>=1 ? h.toFixed(1)+'h' : Math.round(h*60)+'m';

// meta + cards
const s=DATA.summary;
document.getElementById('meta').textContent =
  `${s.firstDate} 〜 ${s.lastDate}  ・  生成 ${DATA.generatedAt}  ・  tz=${DATA.tz}  ・  gap=${DATA.gapMin}分 / floor=${DATA.floorMin}分`;
const cards=[
  ['総アクティブ時間', fmtH(s.activeHours), `${s.daysActive}日稼働`],
  ['平均 / 稼働日', fmtH(s.avgPerDay), s.maxDay?`最長 ${fmtH(s.maxDay.hours)} (${s.maxDay.date})`:''],
  ['プロンプト数', s.prompts.toLocaleString(), `応答 ${s.assistantMsgs.toLocaleString()}`],
  ['作業ブロック', s.blocks.toLocaleString(), `セッション ${s.sessions.toLocaleString()}`],
  ['最も活発な時間帯', s.busiestHour!=null?`${String(s.busiestHour).padStart(2,'0')}:00台`:'-', ''],
];
document.getElementById('cards').innerHTML = cards.map(c=>
  `<div class="card"><div class="v">${c[1]}</div><div class="l">${c[0]}</div>${c[2]?`<div class="s">${c[2]}</div>`:''}</div>`).join('');

// ---- calendar heatmap ----
(function(){
  const daily=DATA.daily; if(!daily.length)return;
  const map={}; daily.forEach(d=>map[d.date]=d);
  const last=new Date(daily[daily.length-1].date+'T00:00:00');
  const start=new Date(last); start.setDate(start.getDate()-371);
  // 週の頭(日曜)に合わせる
  start.setDate(start.getDate()-start.getDay());
  const cell=12, gap=3, top=16, left=28;
  const weeks=[]; let cur=new Date(start);
  while(cur<=last){weeks.push(new Date(cur));cur.setDate(cur.getDate()+7);}
  const W=left+weeks.length*(cell+gap)+10, H=top+7*(cell+gap)+6;
  const color=h=> h<=0?'#161b22':h<1?'#0e4429':h<2.5?'#006d32':h<4.5?'#26a641':'#39d353';
  let svg=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  const months=['1','2','3','4','5','6','7','8','9','10','11','12'];
  let lastMonth=-1;
  weeks.forEach((wd,wi)=>{
    const m=wd.getMonth();
    if(m!==lastMonth){lastMonth=m;
      svg+=`<text x="${left+wi*(cell+gap)}" y="11" fill="#8b949e" font-size="10">${months[m]}月</text>`;}
    for(let dow=0;dow<7;dow++){
      const dt=new Date(wd); dt.setDate(dt.getDate()+dow);
      if(dt>last)continue;
      const key=dt.toISOString().slice(0,10);
      const d=map[key]; const h=d?d.active:0;
      const x=left+wi*(cell+gap), y=top+dow*(cell+gap);
      const t=d?`${key}: アクティブ ${fmtH(h)} / スパン ${fmtH(d.span)} / ${d.prompts}prompts`:`${key}: なし`;
      svg+=`<rect class="cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${color(h)}"
        onmousemove="showTip(event,'${t}')" onmouseleave="hideTip()"></rect>`;
    }
  });
  ['月','水','金'].forEach((lab,i)=>{const dow=[1,3,5][i];
    svg+=`<text x="2" y="${top+dow*(cell+gap)+10}" fill="#8b949e" font-size="9">${lab}</text>`;});
  svg+='</svg>';
  document.getElementById('cal').innerHTML=svg;
})();

// ---- daily bars (last 90) ----
(function(){
  const d=DATA.daily.slice(-90); if(!d.length)return;
  const max=Math.max(...d.map(x=>x.active),1);
  const bw=Math.max(4,Math.floor(820/d.length)), gap=2, H=160, top=6, left=4;
  const W=left+d.length*(bw+gap)+30;
  let svg=`<svg width="${W}" height="${H+24}" viewBox="0 0 ${W} ${H+24}">`;
  // y軸目盛り
  [0,Math.ceil(max/2),Math.ceil(max)].forEach(v=>{const y=top+H-(v/max)*H;
    svg+=`<line x1="${left}" y1="${y}" x2="${W-26}" y2="${y}" stroke="#30363d"/>
    <text x="${W-22}" y="${y+3}" fill="#8b949e" font-size="9">${v}h</text>`;});
  d.forEach((x,i)=>{const bh=(x.active/max)*H, px=left+i*(bw+gap), py=top+H-bh;
    svg+=`<rect x="${px}" y="${py}" width="${bw}" height="${bh}" rx="1" fill="#d97757"
      onmousemove="showTip(event,'${x.date}: ${fmtH(x.active)} (${x.prompts}prompts, ${x.blocks}ブロック)')" onmouseleave="hideTip()"></rect>`;});
  svg+='</svg>';
  document.getElementById('bars').innerHTML=svg;
})();

// ---- rhythm 7x24 ----
(function(){
  const r=DATA.rhythm; const days=['月','火','水','木','金','土','日'];
  let max=0; r.forEach(row=>row.forEach(v=>{if(v>max)max=v;}));
  const cell=26, gap=3, top=18, left=28;
  const W=left+24*(cell+gap)+4, H=top+7*(cell+gap)+4;
  const color=v=>{if(v<=0||max<=0)return '#161b22'; const t=v/max;
    const c=Math.round(40+t*180); return `rgb(${217},${Math.round(119-t*40)},${Math.round(87-t*40)},${0.15+t*0.85})`;};
  let svg=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for(let h=0;h<24;h+=2){svg+=`<text x="${left+h*(cell+gap)}" y="12" fill="#8b949e" font-size="9">${h}</text>`;}
  for(let w=0;w<7;w++){
    svg+=`<text x="2" y="${top+w*(cell+gap)+17}" fill="#8b949e" font-size="10">${days[w]}</text>`;
    for(let h=0;h<24;h++){const v=r[w][h];const x=left+h*(cell+gap),y=top+w*(cell+gap);
      svg+=`<rect class="cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${color(v)}"
        onmousemove="showTip(event,'${days[w]} ${String(h).padStart(2,'0')}時台: ${fmtH(v)}')" onmouseleave="hideTip()"></rect>`;}
  }
  svg+='</svg>';
  document.getElementById('rhythm').innerHTML=svg;
})();

// ---- projects table ----
(function(){
  const p=DATA.projects; const max=Math.max(...p.map(x=>x.active),1);
  let h=`<tr><th>プロジェクト</th><th class="num">アクティブ</th><th></th><th class="num">日数</th><th class="num">prompts</th><th class="num">最終</th></tr>`;
  p.forEach(x=>{const w=Math.round((x.active/max)*160);
    h+=`<tr><td>${x.name}</td><td class="num">${fmtH(x.active)}</td>
    <td><span class="bar" style="width:${w}px"></span></td>
    <td class="num">${x.days}</td><td class="num">${x.prompts}</td><td class="num muted">${x.last}</td></tr>`;});
  document.getElementById('projects').innerHTML=h;
})();

// ---- recent blocks ----
(function(){
  let h=`<tr><th>開始</th><th>終了</th><th class="num">長さ</th><th>プロジェクト</th><th class="num">prompts</th></tr>`;
  DATA.recent.forEach(b=>{h+=`<tr><td>${b.start}</td><td class="muted">${b.end}</td>
    <td class="num">${fmtH(b.dur)}</td><td>${b.project}</td><td class="num">${b.prompts}</td></tr>`;});
  document.getElementById('recent').innerHTML=h;
})();
</script>
</body>
</html>
"""


TIMELINE_HTML = r"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>並行作業タイムライン — Claude Code</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--accent:#d97757}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Segoe UI",sans-serif}
.top{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;height:53px}
.top h1{font-size:15px;margin:0;font-weight:700}
.top a{color:var(--accent);font-size:12px;text-decoration:none}
.top .hint{font-size:12px;color:var(--muted)}
.ctrl{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
button{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:7px;
  padding:6px 12px;font-size:13px;cursor:pointer}
button:hover{border-color:var(--accent)}
#grid{position:absolute;left:0;right:0;top:53px;bottom:64px}
#minimap{position:absolute;left:0;right:0;bottom:0;height:64px;border-top:1px solid var(--border);
  background:var(--panel);padding:8px 12px 4px}
#mmtrack{position:relative;height:34px;background:#0d1117;border:1px solid var(--border);
  border-radius:5px;overflow:hidden;cursor:pointer}
#mmdens{position:absolute;inset:0}
#mmview{position:absolute;top:-1px;bottom:-1px;background:rgba(255,255,255,.10);
  border:2px solid #fff;border-radius:3px;pointer-events:none;min-width:3px;
  box-shadow:0 0 0 1px #000,0 0 8px rgba(255,255,255,.4)}
.mmlabel{position:absolute;top:38px;font-size:10px;color:var(--muted);transform:translateX(-50%)}
#side{position:absolute;left:0;top:0;bottom:0;width:var(--lw);background:var(--panel);
  border-right:1px solid var(--border);overflow:hidden;z-index:3}
#sidecover{position:absolute;left:0;top:0;right:0;height:var(--axis);background:var(--panel);
  border-bottom:1px solid var(--border);z-index:2;display:flex;align-items:center;padding:0 12px;
  font-size:11px;color:var(--muted);font-weight:600}
#sideinner{position:absolute;left:0;top:0;right:0}
.srow{position:absolute;left:0;right:0;height:var(--rh);display:flex;flex-direction:column;
  justify-content:center;padding:0 12px;border-bottom:1px solid #1b2129;
  transition:top .35s cubic-bezier(.22,1,.36,1),opacity .3s,transform .35s}
.srow b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srow span{font-size:10px;color:var(--muted)}
.srow .sw{width:6px;height:6px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:middle}
#tl{position:absolute;left:var(--lw);right:0;top:0;bottom:0;overflow:auto}
#canvas{position:relative}
.axis{position:sticky;top:0;height:var(--axis);z-index:5;background:#0d1117ee;backdrop-filter:blur(3px);
  border-bottom:1px solid var(--border)}
.alabel{position:absolute;top:7px;font-size:11px;color:#c9d4e0;white-space:nowrap;padding-left:5px;
  border-left:1px solid #3a424c;height:18px;line-height:18px}
.alabel.mon{color:#fff;font-weight:700;border-left-color:#5a6573}
.alabel.hour{color:#7f8b98;font-size:10px;border-left-color:#262c34}
.grid{position:absolute;top:var(--axis);bottom:0;border-left:1px solid #161c23}
.grid.mon{border-left:1px solid #2a323b}
.grid.hour{border-left-color:#10151b}
.lane{position:absolute;left:0;height:var(--rh);
  transition:top .35s cubic-bezier(.22,1,.36,1),opacity .3s,transform .35s}
.lane.hidden,.srow.hidden{opacity:0;transform:translateY(12px);pointer-events:none}
.bar{position:absolute;border-radius:4px;top:3px;height:calc(var(--rh) - 7px)}
.bar:hover{outline:1.5px solid #fff;z-index:4}
#tip{position:fixed;pointer-events:none;background:#000;border:1px solid var(--border);
  padding:6px 9px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .1s;z-index:30;white-space:nowrap}
.range{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--fg);
  background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:4px 10px;white-space:nowrap}
#cursor{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.45);
  z-index:6;pointer-events:none;display:none}
#curlabel{position:sticky;top:6px;transform:translateX(-50%);background:var(--accent);color:#fff;
  font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:4px;
  white-space:nowrap;z-index:8}
</style>
</head>
<body>
<div class="top">
  <h1>並行作業タイムライン</h1>
  <a href="dashboard.html">← ダッシュボードへ</a>
  <span class="range" id="range"></span>
  <span class="hint" id="sub"></span>
  <div class="ctrl">
    <span class="hint" id="vis"></span>
    <span class="hint">|</span>
    <span class="hint">ズーム</span>
    <button id="zout">－</button><button id="zin">＋</button>
    <button id="jstart">最初へ</button>
    <button id="jend">最新へ</button>
  </div>
</div>
<div id="grid">
  <div id="side"><div id="sidecover">案件 / プロジェクト</div><div id="sideinner"></div></div>
  <div id="tl"><div id="canvas"><div class="axis" id="axis"></div><div id="lanes"></div><div id="cursor"><div id="curlabel"></div></div></div></div>
</div>
<div id="minimap"><div id="mmtrack"><div id="mmdens"></div><div id="mmview"></div></div></div>
<div id="tip"></div>
<script>
const DATA=/*__DATA__*/, META=/*__META__*/;
const HOUR=3600000, DAY=86400000;
const T0=DATA.start, T1=DATA.end, SPAN=Math.max(T1-T0,HOUR);
const LW=190, AXIS=32, ROWH=30;
const r=document.documentElement.style;
r.setProperty('--lw',LW+'px'); r.setProperty('--axis',AXIS+'px'); r.setProperty('--rh',ROWH+'px');
const tl=document.getElementById('tl'), canvas=document.getElementById('canvas'),
      axis=document.getElementById('axis'), lanesEl=document.getElementById('lanes'),
      side=document.getElementById('side'), sideinner=document.getElementById('sideinner'),
      tip=document.getElementById('tip');
let pxh=10; // px / hour

document.getElementById('sub').textContent=
  `${DATA.lanes.length}プロジェクト / ${DATA.segments.length}セッション ・ tz=${META.tz} ・ gap=${META.gapMin}分`;

const color=p=>`hsl(${(p*53)%360} 60% 60%)`;
const pad=n=>String(n).padStart(2,'0');
const fmtDT=ms=>{const d=new Date(ms);
  return `${d.getMonth()+1}/${pad(d.getDate())}(${'日月火水木金土'[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;};
const fmtDate=ms=>{const d=new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}(${'日月火水木金土'[d.getDay()]})`;};
const fmtDur=ms=>{const m=Math.round(ms/60000);return m>=60?(m/60).toFixed(1)+'h':m+'m';};
const X=ms=>(ms-T0)/HOUR*pxh;

// プロジェクト別にセグメントをまとめる(開始順)
const NP=DATA.lanes.length;
const perPid=Array.from({length:NP},()=>[]);
DATA.segments.forEach(s=>perPid[s.p].push(s));
perPid.forEach(a=>a.sort((x,y)=>x.s-y.s));

// レーン(案件ごと) と サイドバー行を一度だけ生成
const laneEl=[], srowEl=[];
const lanesFrag=document.createDocumentFragment(), sideFrag=document.createDocumentFragment();
for(let p=0;p<NP;p++){
  const lane=document.createElement('div'); lane.className='lane hidden';
  for(const s of perPid[p]){
    const b=document.createElement('div'); b.className='bar';
    b.style.background=color(p); b._s=s; lane.appendChild(b);
    b.addEventListener('mousemove',e=>{
      tip.innerHTML=`<b>${DATA.lanes[p].name}</b><br>${fmtDT(s.s)} → ${fmtDT(s.e)}<br>稼働 ${fmtDur(s.e-s.s)} ・ ${s.n} prompts`;
      tip.style.opacity=1;tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';});
    b.addEventListener('mouseleave',()=>tip.style.opacity=0);
  }
  lanesFrag.appendChild(lane); laneEl.push(lane);
  const sr=document.createElement('div'); sr.className='srow hidden';
  sr.innerHTML=`<b><span class="sw" style="background:${color(p)}"></span>${DATA.lanes[p].name}</b><span>${DATA.lanes[p].active}h 累計</span>`;
  sideFrag.appendChild(sr); srowEl.push(sr);
}
lanesEl.appendChild(lanesFrag); sideinner.appendChild(sideFrag);

function placeBars(){       // ズーム時にバーの左/幅を再計算
  canvas.style.width=(X(T1)+40)+'px';
  axis.style.width=canvas.style.width;
  for(let p=0;p<NP;p++){
    const bars=laneEl[p].children;
    let i=0; for(const s of perPid[p]){ const b=bars[i++];
      b.style.left=X(s.s)+'px';
      b.style.width=Math.max(X(s.e)-X(s.s),2)+'px';
      b.style.opacity=0.5+Math.min(s.n,30)/30*0.5;
    }
  }
  buildAxis();
}
function buildAxis(){
  // 日付ラベルは(不透明な)軸バーの中に入れて常に見えるようにする。グリッド線は本体側。
  axis.querySelectorAll('.alabel').forEach(n=>n.remove());
  canvas.querySelectorAll('.grid').forEach(n=>n.remove());
  const pxDay=pxh*24;
  const dayEvery= pxDay>=80?1 : pxDay>=44?2 : pxDay>=20?7 : 14;
  let hourEvery=0;                       // ズーム時は時刻も表示
  if(pxh>=42) hourEvery=3; else if(pxh>=20) hourEvery=6; else if(pxh>=10) hourEvery=12;
  let d=new Date(T0); d.setHours(0,0,0,0);
  const aFrag=document.createDocumentFragment(), gFrag=document.createDocumentFragment();
  let dayIdx=0;
  for(let t=d.getTime(); t<=T1; t+=DAY, dayIdx++){
    const dt=new Date(t), px=X(t), first=dt.getDate()===1;
    if(first || dayIdx%dayEvery===0){
      const lab=document.createElement('div'); lab.className='alabel'+(first?' mon':'');
      lab.style.left=px+'px';
      lab.textContent= first ? `${dt.getFullYear()===new Date(T0).getFullYear()?'':dt.getFullYear()+'/'}${dt.getMonth()+1}月`
                             : `${dt.getMonth()+1}/${dt.getDate()}(${'日月火水木金土'[dt.getDay()]})`;
      aFrag.appendChild(lab);
    }
    const g=document.createElement('div'); g.className='grid'+(first?' mon':''); g.style.left=px+'px'; gFrag.appendChild(g);
    if(hourEvery){ for(let h=hourEvery; h<24; h+=hourEvery){
      const ht=t+h*HOUR; if(ht>T1) break; const hx=X(ht);
      const hl=document.createElement('div'); hl.className='alabel hour'; hl.style.left=hx+'px'; hl.textContent=pad(h); aFrag.appendChild(hl);
      const hg=document.createElement('div'); hg.className='grid hour'; hg.style.left=hx+'px'; gFrag.appendChild(hg);
    }}
  }
  axis.appendChild(aFrag); canvas.appendChild(gFrag);
  axis.style.width=canvas.style.width;
}

// 可視範囲にセッションがある案件だけ、上から詰めて行を出す
function hasInView(arr,vs,ve){ for(const s of arr){ if(s.s>ve) break; if(s.e>=vs) return true; } return false; }
let _tick=false;
function updateView(){
  _tick=false;
  const sl=tl.scrollLeft, vw=tl.clientWidth;
  const vs=T0+sl/pxh*HOUR, ve=T0+(sl+vw)/pxh*HOUR;
  let idx=0;
  for(let p=0;p<NP;p++){
    if(perPid[p].length && hasInView(perPid[p],vs,ve)){
      const top=AXIS+idx*ROWH;
      const lane=laneEl[p], sr=srowEl[p];
      lane.style.top=top+'px'; lane.classList.remove('hidden');
      sr.style.top=top+'px'; sr.classList.remove('hidden');
      idx++;
    }else{
      laneEl[p].classList.add('hidden'); srowEl[p].classList.add('hidden');
    }
  }
  const h=AXIS+idx*ROWH+8;
  canvas.style.height=Math.max(h, tl.clientHeight)+'px';
  sideinner.style.height=h+'px';
  document.getElementById('vis').textContent=`画面内 ${idx} 案件`;
  const vt0=T0+sl/pxh*HOUR, vt1=T0+(sl+vw)/pxh*HOUR;
  document.getElementById('range').textContent=`${fmtDate(vt0)} 〜 ${fmtDate(vt1)}`;
  mmUpdate();
}

// 縦スクロールはサイドバーを同期 / 横スクロールは表示行を更新
tl.addEventListener('scroll',()=>{
  sideinner.style.transform=`translateY(${-tl.scrollTop}px)`;
  if(!_tick){ _tick=true; requestAnimationFrame(updateView); }
});
function zoom(f){
  const mid=tl.scrollLeft+tl.clientWidth/2, tMid=T0+mid/pxh*HOUR;
  pxh=Math.min(160,Math.max(0.4,pxh*f));
  placeBars(); updateView();
  tl.scrollLeft=X(tMid)-tl.clientWidth/2;
}
document.getElementById('zin').onclick=()=>zoom(1.6);
document.getElementById('zout').onclick=()=>zoom(1/1.6);
document.getElementById('jstart').onclick=()=>tl.scrollLeft=0;
document.getElementById('jend').onclick=()=>tl.scrollLeft=canvas.scrollWidth;
// Ctrl/⌘+ホイールのみズーム。通常スクロールはブラウザ任せ(縦=縦/横=横、奪わない)
tl.addEventListener('wheel',e=>{
  if(e.ctrlKey||e.metaKey){ e.preventDefault(); zoom(e.deltaY<0?1.12:1/1.12); }
},{passive:false});

// マウス位置に縦カーソル線＋日時ラベルを表示(今どの時間か常に分かるように)
const cursor=document.getElementById('cursor'), curlabel=document.getElementById('curlabel');
tl.addEventListener('mousemove',e=>{
  const cx=tl.scrollLeft+(e.clientX-tl.getBoundingClientRect().left);
  cursor.style.left=cx+'px'; cursor.style.display='block';
  curlabel.textContent=fmtDT(T0+cx/pxh*HOUR);
});
tl.addEventListener('mouseleave',()=>{ cursor.style.display='none'; });

// ---- ミニマップ(全期間の密度＋現在位置。クリック/ドラッグで一気にジャンプ) ----
const mmtrack=document.getElementById('mmtrack'), mmdens=document.getElementById('mmdens'),
      mmview=document.getElementById('mmview'), minimap=document.getElementById('minimap');
function buildMinimap(){
  const W=Math.max(150,Math.floor(mmtrack.clientWidth||800));
  const N=Math.min(900,W);
  const counts=new Array(N).fill(0); let mx=1;
  for(const s of DATA.segments){
    let i0=Math.max(0,Math.floor((s.s-T0)/SPAN*N)), i1=Math.min(N-1,Math.floor((s.e-T0)/SPAN*N));
    for(let i=i0;i<=i1;i++){ if(++counts[i]>mx)mx=counts[i]; }
  }
  let h=''; for(let i=0;i<N;i++){ if(!counts[i])continue; const op=(0.2+0.8*counts[i]/mx).toFixed(2);
    h+=`<div style="position:absolute;left:${(i/N*100).toFixed(3)}%;width:${(100/N+0.3).toFixed(3)}%;top:0;bottom:0;background:rgba(217,119,87,${op})"></div>`; }
  mmdens.innerHTML=h;
  minimap.querySelectorAll('.mmlabel').forEach(n=>n.remove());
  let d=new Date(T0); d.setDate(1); d.setHours(0,0,0,0);
  for(let t=d.getTime();t<=T1;){ const dt=new Date(t), px=(t-T0)/SPAN*100;
    if(px>=0&&px<=100){ const lab=document.createElement('div'); lab.className='mmlabel';
      lab.style.left='calc(12px + '+px+'% - '+(px/100*24)+'px)'; lab.textContent=(dt.getMonth()+1)+'月';
      minimap.appendChild(lab); }
    dt.setMonth(dt.getMonth()+1); t=dt.getTime(); }
}
function mmUpdate(){
  const W=mmtrack.clientWidth;
  const viewT0=T0+tl.scrollLeft/pxh*HOUR, viewSpan=tl.clientWidth/pxh*HOUR;
  mmview.style.left=((viewT0-T0)/SPAN*W)+'px';
  mmview.style.width=Math.max(3,Math.min(W,viewSpan/SPAN*W))+'px';
}
function mmSeek(e){
  const r=mmtrack.getBoundingClientRect();
  const frac=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  tl.scrollLeft=X(T0+frac*SPAN)-tl.clientWidth/2;  // クリック位置を中央に
}
mmtrack.addEventListener('click',mmSeek);
let mmDrag=false;
mmtrack.addEventListener('mousedown',e=>{mmDrag=true;mmSeek(e);e.preventDefault();});
window.addEventListener('mousemove',e=>{ if(mmDrag)mmSeek(e); });
window.addEventListener('mouseup',()=>mmDrag=false);
window.addEventListener('resize',()=>{ buildMinimap(); placeBars(); updateView(); });

placeBars();
buildMinimap();
tl.scrollLeft=canvas.scrollWidth; // 最新側から表示
updateView();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Claude Code 稼働時間 / タイムライン分析")
    ap.add_argument("--gap", type=float, default=15, help="作業ブロックを区切る無操作分数 (既定15)")
    ap.add_argument("--floor", type=float, default=2, help="各ブロック先頭の下駄分数 (既定2)")
    ap.add_argument("--out", default="dashboard.html", help="出力HTMLパス")
    ap.add_argument("--open", action="store_true", help="生成後にブラウザで開く")
    ap.add_argument("--rebuild", action="store_true", help="キャッシュ無視で全再パース")
    ap.add_argument("--no-cache", action="store_true", help="キャッシュを使わない")
    ap.add_argument("--json", dest="json_out", default=None, help="集計JSONも書き出す")
    ap.add_argument("--ignore", action="append", default=None,
                    help="除外するプロジェクト名(カンマ区切り可・複数指定可)。ctlignore.txt にも書ける")
    args = ap.parse_args()

    ignore = load_ignore(args.ignore)
    if ignore:
        print(f"[ctl] 除外プロジェクト: {', '.join(sorted(ignore))}", file=sys.stderr)

    results = load_all(use_cache=not args.no_cache, rebuild=args.rebuild)
    metrics = analyze(results, gap_min=args.gap, floor_min=args.floor, ignore=ignore)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(render_html(metrics))
    print(f"[ctl] HTML 出力: {os.path.abspath(args.out)}", file=sys.stderr)

    # スイムレーン(並行作業タイムライン)を dashboard と同じディレクトリに出力
    tl_path = os.path.join(os.path.dirname(os.path.abspath(args.out)) or ".", "timeline.html")
    with open(tl_path, "w", encoding="utf-8") as f:
        f.write(render_timeline(metrics))
    print(f"[ctl] タイムライン出力: {tl_path}", file=sys.stderr)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(metrics, f, ensure_ascii=False, indent=2)
        print(f"[ctl] JSON 出力: {os.path.abspath(args.json_out)}", file=sys.stderr)

    print_summary(metrics)

    if args.open:
        webbrowser.open("file://" + os.path.abspath(args.out))


if __name__ == "__main__":
    main()
