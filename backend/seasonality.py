"""曜日・月ごとの、過去の平均リターン統計（暦の「クセ」）。

⚠️ これは「過去はこうだった」という実データの集計にすぎない。
   未来を保証するものではないし、売買の助言でもない。
   月曜のリターンは「前の取引日→月曜」で計算するので、週末効果も含む。
"""
from __future__ import annotations

import pandas as pd

from indicators import _load_closes

_WD = ["月", "火", "水", "木", "金", "土", "日"]


def _agg(group: pd.DataFrame) -> tuple[int, float, float]:
    n = int(len(group))
    mean = float(group["ret"].mean())
    win = float((group["ret"] > 0).mean() * 100.0)
    return n, mean, win


def compute(ticker: str) -> dict:
    s = _load_closes(ticker)
    if s is None or len(s) < 60:
        return {"ok": False, "reason": "データが少なく、統計になりません（『更新』で履歴を増やすと出ます）。"}
    ret = s.pct_change().dropna() * 100.0
    if len(ret) < 40:
        return {"ok": False, "reason": "データが少なく、統計になりません（『更新』で履歴を増やすと出ます）。"}
    idx = ret.index
    df = pd.DataFrame({"ret": ret.values, "wd": idx.weekday, "mon": idx.month})

    weekday = []
    for wd in range(5):  # 月〜金
        g = df[df["wd"] == wd]
        if len(g) == 0:
            continue
        n, mean, win = _agg(g)
        weekday.append({"wd": wd, "name": _WD[wd], "n": n,
                        "mean": round(mean, 3), "win": round(win, 1)})

    month = []
    for m in range(1, 13):
        g = df[df["mon"] == m]
        if len(g) < 5:  # サンプルが少ない月は出さない
            continue
        n, mean, win = _agg(g)
        month.append({"m": m, "name": f"{m}月", "n": n,
                      "mean": round(mean, 3), "win": round(win, 1)})

    best = max(weekday, key=lambda x: x["mean"]) if weekday else None
    worst = min(weekday, key=lambda x: x["mean"]) if weekday else None

    return {
        "ok": True,
        "ticker": ticker,
        "n_days": int(len(ret)),
        "from": str(idx.min().date()),
        "to": str(idx.max().date()),
        "years": round((idx.max() - idx.min()).days / 365.25, 1),
        "weekday": weekday,
        "best_wd": best["name"] if best else None,
        "worst_wd": worst["name"] if worst else None,
        "month": month,
    }
