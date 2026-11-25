"""予測の記録と答え合わせ（このソフトの学びの核）。

- 予測を登録するときは「基準日の終値」を一緒に保存する。
- 期限（target_date）を過ぎた予測は、実データと照合して正解/不正解を埋める。
- 的中率を自分の予測・AIサイン別に集計する。
"""
from __future__ import annotations

from datetime import date, timedelta

from db import get_conn
from fetch import quote


def record(ticker: str, direction: str, horizon_days: int = 5,
           probability: float | None = None, source: str = "自分",
           note: str | None = None) -> dict:
    direction = direction.lower()
    if direction not in ("up", "down"):
        raise ValueError("direction は up か down")
    q = quote(ticker)
    if not q:
        raise ValueError("先に『更新』で株価データを取得してください")

    made_on = q["date"]
    base_price = q["close"]
    # 営業日の概算（土日ぶんを少し足す）
    target = _parse(made_on) + timedelta(days=int(horizon_days * 1.5) + 1)

    conn = get_conn()
    conn.execute(
        "INSERT INTO predictions(ticker,made_on,base_price,horizon_days,target_date,"
        "direction,probability,source,note,resolved) VALUES(?,?,?,?,?,?,?,?,?,0)",
        (ticker, made_on, base_price, horizon_days, target.isoformat(),
         direction, probability, source, note),
    )
    conn.commit()
    conn.close()
    return {"ticker": ticker, "direction": direction, "made_on": made_on,
            "base_price": base_price, "target_date": target.isoformat()}


def resolve_due() -> dict:
    """期限が来た未判定の予測を、保存済み株価と照合して埋める。"""
    today = date.today().isoformat()
    conn = get_conn()
    due = conn.execute(
        "SELECT * FROM predictions WHERE resolved=0 AND target_date<=?", (today,)
    ).fetchall()

    resolved = 0
    for p in due:
        # target_date 当日以降で最初に存在する終値を使う
        row = conn.execute(
            "SELECT close FROM prices WHERE ticker=? AND date>=? ORDER BY date ASC LIMIT 1",
            (p["ticker"], p["target_date"]),
        ).fetchone()
        if not row:
            continue  # まだデータが無い → 次の更新で判定
        actual_price = row["close"]
        if actual_price > p["base_price"]:
            actual_dir = "up"
        elif actual_price < p["base_price"]:
            actual_dir = "down"
        else:
            actual_dir = "flat"
        correct = 1 if actual_dir == p["direction"] else 0
        conn.execute(
            "UPDATE predictions SET resolved=1, actual_price=?, actual_dir=?, correct=? WHERE id=?",
            (actual_price, actual_dir, correct, p["id"]),
        )
        resolved += 1

    conn.commit()
    conn.close()
    return {"resolved": resolved}


def delete(pred_id: int) -> dict:
    conn = get_conn()
    conn.execute("DELETE FROM predictions WHERE id=?", (pred_id,))
    conn.commit()
    conn.close()
    return {"deleted": True}


def listing(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT p.*, s.name AS name FROM predictions p "
        "LEFT JOIN symbols s ON s.ticker=p.ticker "
        "ORDER BY p.id DESC LIMIT ?",
        (limit,),
    ).fetchall()

    today = date.today()
    out = []
    for r in rows:
        d = dict(r)
        # まだ判定待ちの予測は「現時点で基準比±何%」の中間成績を付ける
        if not d.get("resolved") and d.get("base_price"):
            latest = conn.execute(
                "SELECT date, close FROM prices WHERE ticker=? AND date>=? "
                "AND close IS NOT NULL ORDER BY date DESC LIMIT 1",
                (d["ticker"], d["made_on"]),
            ).fetchone()
            if latest and latest["close"] is not None:
                cur = latest["close"]
                d["cur_price"] = cur
                d["cur_date"] = latest["date"]
                d["cur_pct"] = round((cur - d["base_price"]) / d["base_price"] * 100, 2)
                cdir = "up" if cur > d["base_price"] else "down" if cur < d["base_price"] else "flat"
                d["cur_dir"] = cdir
                d["on_track"] = bool(cdir == d["direction"])
            try:
                d["days_left"] = max((_parse(d["target_date"]) - today).days, 0)
            except Exception:
                d["days_left"] = None
        out.append(d)

    conn.close()
    return out


def accuracy() -> dict:
    conn = get_conn()
    out = {}
    for src in ("自分", "AI", "ML", "全体"):
        if src == "全体":
            where, args = "resolved=1", ()
        else:
            where, args = "resolved=1 AND source=?", (src,)
        row = conn.execute(
            f"SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS hit FROM predictions WHERE {where}",
            args,
        ).fetchone()
        n, hit = row["n"], row["hit"]
        out[src] = {"n": n, "hit": hit, "rate": (hit / n * 100) if n else None}
    conn.close()
    return out


def _parse(d: str) -> date:
    y, m, dd = (int(x) for x in d.split("-"))
    return date(y, m, dd)
