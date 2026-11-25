"""Phase 6: 分析スナップショット・ランキング・セクター・スクリーナーの素。

全株式銘柄について「現在値・騰落率・RSI・出来高比・サイン・ML確率」を1つにまとめ、
そこからランキングやセクター集計、スクリーニングを作る。
"""
from __future__ import annotations

import indicators
import ml
from db import DATA_DIR, get_conn
from fetch import quote


def _stock_rows():
    conn = get_conn()
    rows = conn.execute(
        "SELECT ticker, name, sector, market, currency FROM symbols WHERE kind='stock'"
    ).fetchall()
    conn.close()
    return rows


def _vol_ratio(ticker: str):
    conn = get_conn()
    rows = conn.execute(
        "SELECT volume FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 20", (ticker,)
    ).fetchall()
    conn.close()
    vols = [r["volume"] for r in rows if r["volume"]]
    if len(vols) < 5:
        return None
    last, rest = vols[0], vols[1:] or vols
    avg = sum(rest) / len(rest)
    return (last / avg) if avg else None


def snapshots(ml_horizon: int = 5) -> list[dict]:
    model_exists = (DATA_DIR / f"model_h{ml_horizon}.joblib").exists()
    out = []
    for s in _stock_rows():
        t = s["ticker"]
        q = quote(t)
        if not q:
            continue
        ind = indicators.compute(t)
        ml_prob = None
        if model_exists:
            try:
                ml_prob = ml.predict_prob(t, ml_horizon)["prob_up"]
            except Exception:  # noqa: BLE001
                ml_prob = None
        out.append({
            "ticker": t, "name": s["name"], "sector": s["sector"],
            "market": s["market"], "currency": s["currency"],
            "close": q["close"], "change_pct": q["change_pct"],
            "rsi": ind["rsi"] if ind else None,
            "signal_dir": ind["direction"] if ind else None,
            "signal_prob": ind["probability"] if ind else None,
            "vol_ratio": _vol_ratio(t),
            "ml_prob": ml_prob,
        })
    return out


def _top(items, key, reverse=True, n=5, cond=None):
    xs = [x for x in items if x.get(key) is not None and (cond is None or cond(x))]
    xs.sort(key=lambda x: x[key], reverse=reverse)
    return xs[:n]


def rankings(ml_horizon: int = 5) -> dict:
    snaps = snapshots(ml_horizon)
    return {
        "gainers": _top(snaps, "change_pct", True),
        "losers": _top(snaps, "change_pct", False),
        "volume": _top(snaps, "vol_ratio", True),
        "ai_up": _top(snaps, "signal_prob", True, cond=lambda x: x["signal_dir"] == "up"),
        "ai_down": _top(snaps, "signal_prob", True, cond=lambda x: x["signal_dir"] == "down"),
        "ml_up": _top(snaps, "ml_prob", True),
    }


def sectors(ml_horizon: int = 5) -> list[dict]:
    snaps = snapshots(ml_horizon)
    by: dict[str, list] = {}
    for s in snaps:
        if s["change_pct"] is None:
            continue
        by.setdefault(s["sector"] or "その他", []).append(s["change_pct"])
    out = []
    for sec, vals in by.items():
        up = sum(1 for v in vals if v > 0)
        out.append({"sector": sec, "count": len(vals), "up": up,
                    "avg_change": sum(vals) / len(vals)})
    out.sort(key=lambda x: x["avg_change"], reverse=True)
    return out


def analysis(ml_horizon: int = 5) -> dict:
    """ランキングタブ用に、スナップショット・ランキング・セクターを一度に返す。"""
    snaps = snapshots(ml_horizon)
    return {
        "snapshots": snaps,
        "rankings": {
            "gainers": _top(snaps, "change_pct", True),
            "losers": _top(snaps, "change_pct", False),
            "volume": _top(snaps, "vol_ratio", True),
            "ai_up": _top(snaps, "signal_prob", True, cond=lambda x: x["signal_dir"] == "up"),
            "ai_down": _top(snaps, "signal_prob", True, cond=lambda x: x["signal_dir"] == "down"),
            "ml_up": _top(snaps, "ml_prob", True),
        },
        "sectors": _sectors_from(snaps),
    }


def _sectors_from(snaps) -> list[dict]:
    by: dict[str, list] = {}
    for s in snaps:
        if s["change_pct"] is None:
            continue
        by.setdefault(s["sector"] or "その他", []).append(s["change_pct"])
    out = [{"sector": sec, "count": len(v), "up": sum(1 for x in v if x > 0),
            "avg_change": sum(v) / len(v)} for sec, v in by.items()]
    out.sort(key=lambda x: x["avg_change"], reverse=True)
    return out
