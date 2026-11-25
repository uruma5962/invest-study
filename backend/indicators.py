"""テクニカル指標の計算と、ルールベースの「上がりそう／下がりそう」サイン。

⚠️ ここで出すサインは断定ではなく、あくまで参考。
   指標の素直な組み合わせ以上のことはしていない。
"""
from __future__ import annotations

import pandas as pd

from db import get_conn


def _load_closes(ticker: str) -> pd.Series:
    conn = get_conn()
    rows = conn.execute(
        "SELECT date, close FROM prices WHERE ticker=? ORDER BY date ASC",
        (ticker,),
    ).fetchall()
    conn.close()
    if not rows:
        return pd.Series(dtype=float)
    s = pd.Series(
        [r["close"] for r in rows],
        index=pd.to_datetime([r["date"] for r in rows]),
    )
    return s


def compute(ticker: str) -> dict | None:
    """移動平均・RSI・MACD と、総合サインを返す。"""
    s = _load_closes(ticker)
    if len(s) < 30:
        return None

    sma5 = s.rolling(5).mean()
    sma25 = s.rolling(25).mean()
    sma75 = s.rolling(75).mean()
    rsi = _rsi(s, 14)
    macd, signal_line = _macd(s)

    last = float(s.iloc[-1])
    out = {
        "ticker": ticker,
        "close": last,
        "sma5": _last(sma5),
        "sma25": _last(sma25),
        "sma75": _last(sma75),
        "rsi": _last(rsi),
        "macd": _last(macd),
        "macd_signal": _last(signal_line),
    }
    out.update(_signal(out))
    return out


def _signal(v: dict) -> dict:
    """指標からスコアを作り、方向と参考確率を決める。"""
    score = 0
    reasons = []
    close, sma5, sma25, sma75 = v["close"], v["sma5"], v["sma25"], v["sma75"]
    rsi, macd, macd_sig = v["rsi"], v["macd"], v["macd_signal"]

    if sma25 and close > sma25:
        score += 1; reasons.append("株価が25日線より上")
    elif sma25:
        score -= 1; reasons.append("株価が25日線より下")

    if sma5 and sma25 and sma5 > sma25:
        score += 1; reasons.append("5日線が25日線より上（短期上向き）")
    elif sma5 and sma25:
        score -= 1; reasons.append("5日線が25日線より下（短期下向き）")

    if sma25 and sma75 and sma25 > sma75:
        score += 1; reasons.append("25日線が75日線より上（中期上向き）")
    elif sma25 and sma75:
        score -= 1; reasons.append("25日線が75日線より下（中期下向き）")

    if macd is not None and macd_sig is not None:
        if macd > macd_sig:
            score += 1; reasons.append("MACDがシグナルより上")
        else:
            score -= 1; reasons.append("MACDがシグナルより下")

    if rsi is not None:
        if rsi >= 70:
            score -= 1; reasons.append(f"RSI {rsi:.0f}（買われすぎ）")
        elif rsi <= 30:
            score += 1; reasons.append(f"RSI {rsi:.0f}（売られすぎ）")

    # スコア(-5〜+5)を方向と参考確率に変換
    if score > 0:
        direction = "up"
    elif score < 0:
        direction = "down"
    else:
        direction = "neutral"
    # 50% を中心に、スコア1あたり約8%（最大±40%相当）
    probability = max(5.0, min(95.0, 50 + score * 8))
    return {"direction": direction, "score": score, "probability": probability, "reasons": reasons}


def _rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, pd.NA)
    return 100 - (100 / (1 + rs))


def _macd(s: pd.Series):
    ema12 = s.ewm(span=12, adjust=False).mean()
    ema26 = s.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal_line = macd.ewm(span=9, adjust=False).mean()
    return macd, signal_line


def _last(series: pd.Series):
    if series is None or len(series) == 0:
        return None
    v = series.iloc[-1]
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None
