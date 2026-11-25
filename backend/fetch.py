"""yfinance から実データを取得して SQLite に保存する。

- 手動更新のみ（常時通信はしない）。
- 日足を基本にする（無料枠で安定）。
- 取得失敗した銘柄は件数として返す。
"""
from __future__ import annotations

import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Iterable

import yfinance as yf

from db import get_conn

warnings.simplefilter("ignore")


def fetch_prices(ticker: str, period: str = "1y") -> int:
    """1銘柄の日足を取得して prices に保存。保存した行数を返す。"""
    df = yf.Ticker(ticker).history(period=period, auto_adjust=True)
    if df is None or df.empty:
        return 0
    df = df.dropna(subset=["Close"])
    if df.empty:
        return 0

    conn = get_conn()
    c = conn.cursor()
    n = 0
    for idx, row in df.iterrows():
        date = idx.strftime("%Y-%m-%d")
        c.execute(
            "INSERT OR REPLACE INTO prices(ticker,date,open,high,low,close,volume) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                ticker,
                date,
                _f(row.get("Open")),
                _f(row.get("High")),
                _f(row.get("Low")),
                _f(row.get("Close")),
                _f(row.get("Volume")),
            ),
        )
        n += 1
    conn.commit()
    conn.close()
    return n


def update_many(tickers: Iterable[str], period: str = "1y") -> dict:
    """複数銘柄をまとめて更新。成功/失敗の件数と明細を返す。"""
    success, fail, details = 0, 0, []
    for t in tickers:
        try:
            rows = fetch_prices(t, period=period)
            if rows > 0:
                success += 1
                details.append({"ticker": t, "ok": True, "rows": rows})
            else:
                fail += 1
                details.append({"ticker": t, "ok": False, "error": "データなし"})
        except Exception as e:  # noqa: BLE001
            fail += 1
            details.append({"ticker": t, "ok": False, "error": str(e)[:120]})
    return {"success": success, "fail": fail, "details": details}


def quote(ticker: str) -> dict | None:
    """DB に保存済みの直近2日から、現在値・前日比・騰落率を作る。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT date, close FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 2",
        (ticker,),
    ).fetchall()
    conn.close()
    if not rows:
        return None
    last = rows[0]
    prev_close = rows[1]["close"] if len(rows) > 1 else last["close"]
    change = last["close"] - prev_close
    change_pct = (change / prev_close * 100) if prev_close else 0.0
    return {
        "ticker": ticker,
        "date": last["date"],
        "close": last["close"],
        "prev_close": prev_close,
        "change": change,
        "change_pct": change_pct,
    }


def volatility_movers(limit: int = 40, win: int = 15, min_points: int = 6,
                      min_vol: float = 1.5) -> list[dict]:
    """「値動きが大きい銘柄」を動的に集める。

    保存済みの終値から、直近 win 営業日の**日次変動率の標準偏差(%)**＝vol を出し、
    大きい順に返す。更新が入るたびに値が入れ替わるので、動きが収まった銘柄は
    自然に下位へ落ちて消え、動き出した銘柄が上がってくる。

    - min_points: これより終値が少ない銘柄は（新規銘柄など）対象外。
    - min_vol: この変動率(%)未満は「収まっている」とみなし除外。市場が穏やかだと
               リストは短くなる。
    - today: 直近1日の騰落率。range: 期間の高安レンジ(%)。
    """
    import datetime as _dt
    import statistics as _st

    # 期間を絞って全銘柄ぶんの終値を1回で読む（win営業日 ≒ win*1.6 暦日）
    cutoff = (_dt.date.today() - _dt.timedelta(days=int(win * 1.8) + 7)).isoformat()
    conn = get_conn()
    meta = {
        r["ticker"]: dict(r)
        for r in conn.execute(
            "SELECT ticker,name,market,sector,currency FROM symbols WHERE kind='stock'"
        ).fetchall()
    }
    rows = conn.execute(
        "SELECT ticker, date, close FROM prices WHERE date >= ? ORDER BY ticker, date",
        (cutoff,),
    ).fetchall()
    conn.close()

    series: dict[str, list[float]] = {}
    for r in rows:
        if r["ticker"] in meta and r["close"] is not None:
            series.setdefault(r["ticker"], []).append(r["close"])

    out = []
    for t, closes in series.items():
        closes = closes[-(win + 1):]
        if len(closes) < min_points:
            continue
        rets = [(closes[i] - closes[i - 1]) / closes[i - 1] * 100
                for i in range(1, len(closes)) if closes[i - 1]]
        if len(rets) < 2:
            continue
        vol = _st.pstdev(rets)
        if vol < min_vol:
            continue
        lo, hi = min(closes), max(closes)
        rng = (hi - lo) / lo * 100 if lo else 0.0
        # 値動きの「向き」：一方向に飛んでいるか、上下に振れているか。
        #   dirn = |合計リターン| / |リターン|の総和（0=両方向に振れる 〜 1=一方向）
        gross = sum(abs(r) for r in rets)
        drift = sum(rets)
        dirn = abs(drift) / gross if gross else 0.0
        trend = dirn >= 0.6                      # 一方向寄り（順張り地合い／異常寄り）
        # 急変：直近1日だけが飛び抜けて大きい（ニュース・決算などの可能性）
        shock = abs(rets[-1]) >= max(min_vol * 1.5, vol * 2.5)
        if trend or shock:
            kind = "異常"   # 普通の平均回帰の前提から外れやすい
        else:
            kind = "両方向"  # 上下に振れている＝平均回帰の練習向き
        m = meta[t]
        out.append({
            "ticker": t, "name": m["name"], "market": m["market"],
            "sector": m["sector"], "currency": m["currency"],
            "close": closes[-1], "today": rets[-1],
            "vol": round(vol, 2), "range": round(rng, 1), "days": len(closes),
            "dir": round(dirn, 2), "trend": trend, "shock": shock, "kind": kind,
        })

    out.sort(key=lambda x: x["vol"], reverse=True)
    return out[:limit]


def history(ticker: str, days: int = 120) -> list[dict]:
    """チャート用に直近 days 日の終値を古い順で返す。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT date, close FROM prices WHERE ticker=? ORDER BY date DESC LIMIT ?",
        (ticker, days),
    ).fetchall()
    conn.close()
    return [{"date": r["date"], "close": r["close"]} for r in reversed(rows)]


# チャートの期間 → yfinance の (period, interval)
# 短期は分足（時刻が見える）、長期は週足/月足で点数を抑える。
RANGE_MAP = {
    "1d":  ("1d", "5m"),
    "5d":  ("5d", "15m"),
    "1mo": ("1mo", "1d"),
    "3mo": ("3mo", "1d"),
    "6mo": ("6mo", "1d"),
    "1y":  ("1y", "1d"),
    "5y":  ("5y", "1wk"),
    "max": ("max", "1mo"),
}


def chart_series(ticker: str, rng: str = "6mo") -> list[dict]:
    """チャート表示用に、指定期間の終値を取得する（DBには保存しない）。

    返り値の t は "YYYY-MM-DD"（日足以上）または "YYYY-MM-DD HH:MM"（分足）。
    """
    period, interval = RANGE_MAP.get(rng, RANGE_MAP["6mo"])
    intraday = interval.endswith("m") or interval.endswith("h")
    fmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"

    df = None
    try:
        df = yf.Ticker(ticker).history(period=period, interval=interval, auto_adjust=True)
    except Exception:  # noqa: BLE001  レート制限(429)や一時的な失敗
        df = None

    if df is not None and not df.empty:
        df = df.dropna(subset=["Close"])
        out = []
        for idx, row in df.iterrows():
            c = _f(row.get("Close"))
            if c is not None:
                out.append({"t": idx.strftime(fmt), "close": c})
        if out:
            return out

    # ライブ取得できないとき（レート制限など）は保存済みの日足にフォールバック。
    # 分足(1日/5日)はDBに無いので、代わりに直近の日足を返す。
    approx = {"1mo": 23, "3mo": 66, "6mo": 132, "1y": 260, "5y": 1300, "max": 6000}
    days = approx.get(rng, 60 if intraday else 132)
    return [{"t": r["date"], "close": r["close"]} for r in history(ticker, days)]


def refresh_latest(tickers: Iterable[str]) -> dict:
    """自動更新用。『今日の終値』だけを最新値で上書きする軽量更新。

    銘柄数が多くても実用的な速さになるよう、価格取得（ネットワーク）はスレッドで
    並列化し、DB書き込みは本体スレッドでまとめて行う（SQLite接続はスレッド間で
    共有しない）。

    ⚠️ 無料データは遅延あり。市場が閉じている間は値が動かないのが正常。
    """
    tickers = list(tickers)
    results: list[tuple[str, float | None]] = []
    if tickers:
        # 取得だけ並列化。yfinance 相手なので同時数は控えめに。
        workers = min(16, max(1, len(tickers)))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(_fast_price, t): t for t in tickers}
            for fut in as_completed(futs):
                t = futs[fut]
                try:
                    results.append((t, fut.result()))
                except Exception:  # noqa: BLE001
                    results.append((t, None))

    success, fail = 0, 0
    conn = get_conn()
    c = conn.cursor()
    today = date.today().isoformat()
    for t, p in results:
        if p is None:
            fail += 1
            continue
        c.execute(
            "INSERT INTO prices(ticker,date,close) VALUES(?,?,?) "
            "ON CONFLICT(ticker,date) DO UPDATE SET close=excluded.close",
            (t, today, p),
        )
        success += 1
    conn.commit()
    conn.close()
    return {"success": success, "fail": fail}


def _fast_price(ticker: str):
    """最新価格を素早く1つだけ取る。fast_info → 1分足の順でフォールバック。"""
    tk = yf.Ticker(ticker)
    try:
        p = float(tk.fast_info["last_price"])
        if p == p:  # NaN でない
            return p
    except Exception:  # noqa: BLE001
        pass
    try:
        df = tk.history(period="1d", interval="1m").dropna(subset=["Close"])
        if not df.empty:
            return float(df["Close"].iloc[-1])
    except Exception:  # noqa: BLE001
        pass
    return None


def _f(v):
    try:
        if v is None:
            return None
        f = float(v)
        return f if f == f else None  # NaN を除く
    except (TypeError, ValueError):
        return None
