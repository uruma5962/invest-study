"""銘柄どうしの関係性（相対強弱・相関）を、保存済みの価格データだけから出す。

- 推測で「これはこれに効く」とは決めない。過去の値動き（実データ）から
  「一緒に動く/逆に動く」「指数・同業種に対して強い/弱い」を計算する。
- 無料データ前提なので、履歴が少ない銘柄は対象外（更新で履歴を取ると増える）。
"""
from __future__ import annotations

import datetime as dt

from db import get_conn


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sx = sum((x - mx) ** 2 for x in xs)
    sy = sum((y - my) ** 2 for y in ys)
    if sx <= 0 or sy <= 0:
        return None
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    return cov / (sx ** 0.5 * sy ** 0.5)


def _load(win: int):
    """直近 win 営業日ぶんの終値と日次リターンを、全銘柄まとめて読む。"""
    cutoff = (dt.date.today() - dt.timedelta(days=int(win * 1.9) + 10)).isoformat()
    conn = get_conn()
    meta = {
        r["ticker"]: dict(r)
        for r in conn.execute(
            "SELECT ticker,name,market,sector FROM symbols WHERE kind='stock'"
        ).fetchall()
    }
    idxmeta = {
        r["ticker"]: dict(r)
        for r in conn.execute(
            "SELECT ticker,name FROM symbols WHERE kind='index'"
        ).fetchall()
    }
    rows = conn.execute(
        "SELECT ticker, date, close FROM prices WHERE date >= ? ORDER BY ticker, date",
        (cutoff,),
    ).fetchall()
    conn.close()

    series: dict[str, list[tuple[str, float]]] = {}
    for r in rows:
        if r["close"] is not None:
            series.setdefault(r["ticker"], []).append((r["date"], r["close"]))

    rets: dict[str, dict[str, float]] = {}
    for t, arr in series.items():
        arr = arr[-(win + 1):]
        rr = {}
        for i in range(1, len(arr)):
            p0 = arr[i - 1][1]
            if p0:
                rr[arr[i][0]] = (arr[i][1] - p0) / p0 * 100
        rets[t] = rr
    return meta, idxmeta, series, rets


def _total_ret(series, t: str, win: int) -> float | None:
    arr = series.get(t, [])[-(win + 1):]
    if len(arr) < 2 or not arr[0][1]:
        return None
    return (arr[-1][1] - arr[0][1]) / arr[0][1] * 100


def relations(ticker: str, win: int = 60) -> dict:
    meta, idxmeta, series, rets = _load(win)
    if ticker not in meta:
        return {"ok": False, "reason": "銘柄がマスタにありません。"}
    if ticker not in series or len(series[ticker]) < 6:
        return {"ok": False, "reason": "データ不足です。右上の「更新」で履歴を取得してください。"}

    m = meta[ticker]
    mk, sec = m.get("market"), m.get("sector")
    tgt = _total_ret(series, ticker, win)

    # 相対強弱：指数比・同業種平均比
    idx_ticker = "^N225" if mk == "JP" else "^GSPC"
    idx_ret = _total_ret(series, idx_ticker, win)
    peers = [t for t, mm in meta.items()
             if mm.get("market") == mk and mm.get("sector") == sec and t != ticker]
    pr = [_total_ret(series, t, win) for t in peers]
    pr = [x for x in pr if x is not None]
    sec_ret = sum(pr) / len(pr) if pr else None

    def rnd(x):
        return round(x, 1) if x is not None else None

    def diff(a, b):
        return rnd(a - b) if (a is not None and b is not None) else None

    relative = {
        "win": win,
        "days": len(series[ticker]),
        "ticker_ret": rnd(tgt),
        "index": {
            "ticker": idx_ticker,
            "name": (idxmeta.get(idx_ticker) or {}).get("name", idx_ticker),
            "ret": rnd(idx_ret), "diff": diff(tgt, idx_ret),
        },
        "sector": {
            "name": sec, "ret": rnd(sec_ret), "n": len(pr), "diff": diff(tgt, sec_ret),
        },
    }

    # 相関：日次リターンのピアソン相関（共通の日付が十分ある銘柄のみ）
    base = rets.get(ticker, {})
    need = max(10, win // 3)
    cors = []
    for t, rr in rets.items():
        if t == ticker:
            continue
        common = [d for d in base if d in rr]
        if len(common) < need:
            continue
        c = _pearson([base[d] for d in common], [rr[d] for d in common])
        if c is None:
            continue
        if t in meta:
            mm = meta[t]
            name, mk2, sec2 = mm.get("name"), mm.get("market"), mm.get("sector")
        elif t in idxmeta:  # 指数（NASDAQ・SOX・VIX 等）も連動の手掛かりとして含める
            name, mk2, sec2 = idxmeta[t].get("name", t), "IDX", "指数"
        else:
            continue
        cors.append({
            "ticker": t, "name": name, "market": mk2,
            "sector": sec2, "corr": round(c, 2), "n": len(common),
        })
    pos = sorted(cors, key=lambda x: x["corr"], reverse=True)[:6]
    neg = sorted(cors, key=lambda x: x["corr"])[:6]
    return {"ok": True, "relative": relative, "pos": pos, "neg": neg}
