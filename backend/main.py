"""FastAPI 本体。API を提供し、frontend/ の画面を配信する。

起動:  (invest-study/backend で)
    python -m uvicorn main:app --reload --port 8000
または プロジェクト直下の run.py / run.bat を使う。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import analysis
import db
import fetch
import indicators
import ml
import news
import predict
import trading

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

db.init_db()
app = FastAPI(title="投資研究ソフト")


# ------------------------------------------------------------------
# リクエストの型
# ------------------------------------------------------------------
class UpdateReq(BaseModel):
    scope: str = "watchlist"      # 'watchlist' / 'indices' / 'all'
    period: str = "1y"


class SymbolReq(BaseModel):
    ticker: str
    name: str = ""
    market: str = "US"            # 'JP' / 'US'
    sector: str | None = None


class TradeReq(BaseModel):
    ticker: str
    side: str                     # 'buy' / 'sell'
    quantity: float


class MLTrainReq(BaseModel):
    horizon: int = 5


class PredictReq(BaseModel):
    ticker: str
    direction: str                # 'up' / 'down'
    horizon_days: int = 5
    probability: float | None = None
    source: str = "自分"
    note: str | None = None


# ------------------------------------------------------------------
# ヘルパ
# ------------------------------------------------------------------
def _tickers(scope: str) -> list[str]:
    conn = db.get_conn()
    if scope == "indices":
        rows = conn.execute("SELECT ticker FROM symbols WHERE kind='index'").fetchall()
    elif scope == "all":
        rows = conn.execute("SELECT ticker FROM symbols").fetchall()
    else:  # watchlist = 株式のウォッチ + 指数
        rows = conn.execute(
            "SELECT ticker FROM symbols WHERE kind='index' "
            "UNION SELECT ticker FROM watchlist_items"
        ).fetchall()
    conn.close()
    return [r["ticker"] for r in rows]


# ------------------------------------------------------------------
# API
# ------------------------------------------------------------------
@app.post("/api/update")
def api_update(req: UpdateReq):
    tickers = _tickers(req.scope)
    result = fetch.update_many(tickers, period=req.period)
    predict.resolve_due()  # 更新のたびに答え合わせも進める
    trading.snapshot_equity()  # 資産推移を1点記録
    return result


@app.post("/api/refresh_live")
def api_refresh_live():
    """自動更新用。表示中の指数＋ウォッチ銘柄の最新値だけを軽く取り直す。"""
    r = fetch.refresh_latest(_tickers("watchlist"))
    predict.resolve_due()
    return r


@app.get("/api/symbols")
def api_symbols():
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT * FROM symbols WHERE kind='stock' ORDER BY market, ticker"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/symbols")
def api_add_symbol(req: SymbolReq):
    t = req.ticker.strip()
    if not t:
        raise HTTPException(400, "ティッカーを入れてください")
    market = req.market.upper()
    currency = "JPY" if market == "JP" else "USD"
    conn = db.get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO symbols(ticker,name,market,sector,currency,kind) "
        "VALUES(?,?,?,?,?, 'stock')",
        (t, req.name or t, market, req.sector, currency),
    )
    wid = conn.execute("SELECT id FROM watchlists ORDER BY id LIMIT 1").fetchone()
    if wid:
        conn.execute(
            "INSERT OR IGNORE INTO watchlist_items(watchlist_id,ticker) VALUES(?,?)",
            (wid["id"], t),
        )
    conn.commit()
    conn.close()
    try:
        rows = fetch.fetch_prices(t, period="1y")
    except Exception as e:  # noqa: BLE001
        return {"ticker": t, "added": True, "fetched": 0, "warn": str(e)[:120]}
    return {"ticker": t, "added": True, "fetched": rows}


def _add_symbol(ticker: str, name: str | None, market: str, sector: str | None) -> int:
    market = (market or "US").upper()
    currency = "JPY" if market == "JP" else "USD"
    conn = db.get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO symbols(ticker,name,market,sector,currency,kind) "
        "VALUES(?,?,?,?,?, 'stock')",
        (ticker, name or ticker, market, sector, currency),
    )
    wid = conn.execute("SELECT id FROM watchlists ORDER BY id LIMIT 1").fetchone()
    if wid:
        conn.execute(
            "INSERT OR IGNORE INTO watchlist_items(watchlist_id,ticker) VALUES(?,?)",
            (wid["id"], ticker),
        )
    conn.commit()
    conn.close()
    try:
        return fetch.fetch_prices(ticker, period="1y")
    except Exception:  # noqa: BLE001
        return 0


class BulkReq(BaseModel):
    group: str = ""
    tickers: list[str] = []


@app.get("/api/presets")
def api_presets():
    return {"groups": list(db.PRESET_GROUPS.keys())}


@app.post("/api/symbols/bulk")
def api_bulk(req: BulkReq):
    entries: list[tuple] = []
    if req.group and req.group in db.PRESET_GROUPS:
        entries.extend(db.PRESET_GROUPS[req.group])
    for raw in req.tickers:
        t = (raw or "").strip()
        if not t:
            continue
        is_jp = t.upper().endswith(".T")
        tk = t if is_jp else t.upper()
        entries.append((tk, tk, "JP" if is_jp else "US", None))

    added, ok, fails = 0, 0, []
    seen = set()
    for (t, n, m, s) in entries:
        if t in seen:
            continue
        seen.add(t)
        try:
            rows = _add_symbol(t, n, m, s)
            added += 1
            if rows > 0:
                ok += 1
            else:
                fails.append({"ticker": t, "error": "データ取得できず"})
        except Exception as e:  # noqa: BLE001
            fails.append({"ticker": t, "error": str(e)[:80]})
    return {"added": added, "fetched_ok": ok, "fail": len(fails), "fails": fails}


class TickerReq(BaseModel):
    ticker: str


@app.post("/api/watchlist/remove")
def api_watchlist_remove(req: TickerReq):
    conn = db.get_conn()
    conn.execute("DELETE FROM watchlist_items WHERE ticker=?", (req.ticker,))
    conn.commit()
    conn.close()
    return {"removed": req.ticker}


@app.get("/api/equity")
def api_equity():
    return trading.equity_series()


@app.post("/api/refresh_holdings")
def api_refresh_holdings():
    """保有している銘柄だけ、最新値を軽く取り直す（仮想投資タブ用）。"""
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT DISTINCT ticker FROM positions WHERE quantity>0"
    ).fetchall()
    conn.close()
    tickers = [r["ticker"] for r in rows]
    if not tickers:
        return {"success": 0, "fail": 0, "held": 0}
    r = fetch.refresh_latest(tickers)
    trading.snapshot_equity()
    return {**r, "held": len(tickers)}


class IdReq(BaseModel):
    id: int


@app.post("/api/predictions/delete")
def api_predictions_delete(req: IdReq):
    return predict.delete(req.id)


@app.get("/api/market")
def api_market():
    conn = db.get_conn()
    idx = conn.execute(
        "SELECT ticker,name,currency FROM symbols WHERE kind='index'"
    ).fetchall()
    wl = conn.execute(
        "SELECT s.ticker,s.name,s.market,s.sector,s.currency "
        "FROM watchlist_items w JOIN symbols s ON s.ticker=w.ticker "
        "ORDER BY w.sort_order"
    ).fetchall()
    conn.close()

    indices = [{**dict(r), **(fetch.quote(r["ticker"]) or {})} for r in idx]
    watch = [{**dict(r), **(fetch.quote(r["ticker"]) or {})} for r in wl]

    rated = [w for w in watch if w.get("change_pct") is not None]
    up = sum(1 for w in rated if w["change_pct"] > 0)
    gainers = sorted(rated, key=lambda x: x["change_pct"], reverse=True)[:5]
    losers = sorted(rated, key=lambda x: x["change_pct"])[:5]

    return {
        "indices": indices,
        "watch": watch,
        "breadth": {"up": up, "total": len(rated)},
        "gainers": gainers,
        "losers": losers,
    }


@app.get("/api/movers")
def api_movers(limit: int = 40, win: int = 15, min_vol: float = 1.5):
    """値動きが大きい銘柄の動的リスト（更新のたびに入れ替わる）。"""
    return {"movers": fetch.volatility_movers(limit=limit, win=win, min_vol=min_vol)}


@app.get("/api/relations/{ticker}")
def api_relations(ticker: str, win: int = 60):
    """銘柄の関係性（相対強弱＋よく連動/逆動きする銘柄）。保存済み価格から算出。"""
    import relations as rel
    return rel.relations(ticker, win=win)


@app.get("/api/price/{ticker}")
def api_price(ticker: str, days: int = 120):
    conn = db.get_conn()
    s = conn.execute("SELECT * FROM symbols WHERE ticker=?", (ticker,)).fetchone()
    conn.close()
    q = fetch.quote(ticker)
    if not q:
        raise HTTPException(404, "データ未取得です。『更新』を押してください")
    return {"symbol": dict(s) if s else {"ticker": ticker},
            "quote": q, "history": fetch.history(ticker, days)}


@app.get("/api/chart/{ticker}")
def api_chart(ticker: str, range: str = "6mo"):
    """チャート用の時系列（期間・間隔を切り替えられる）。"""
    return {"ticker": ticker, "range": range, "series": fetch.chart_series(ticker, range)}


@app.get("/api/indicators/{ticker}")
def api_indicators(ticker: str):
    r = indicators.compute(ticker)
    if not r:
        raise HTTPException(404, "指標を計算するだけのデータがありません（更新してください）")
    return r


@app.get("/api/seasonality/{ticker}")
def api_seasonality(ticker: str):
    """曜日・月ごとの過去の平均リターン統計（暦のクセ）。保存済み価格から算出。"""
    import seasonality
    return seasonality.compute(ticker)


@app.get("/api/portfolios")
def api_portfolios():
    return [trading.portfolio_summary(1), trading.portfolio_summary(2)]


@app.post("/api/trade")
def api_trade(req: TradeReq):
    try:
        return trading.trade(req.ticker, req.side, req.quantity)
    except trading.TradeError as e:
        raise HTTPException(400, str(e))


@app.get("/api/trades")
def api_trades(limit: int = 100):
    return trading.trade_history(limit)


@app.post("/api/predict")
def api_predict(req: PredictReq):
    try:
        return predict.record(req.ticker, req.direction, req.horizon_days,
                              req.probability, req.source, req.note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/predict/resolve")
def api_resolve():
    return predict.resolve_due()


@app.get("/api/predictions")
def api_predictions(limit: int = 100):
    return {"items": predict.listing(limit), "accuracy": predict.accuracy()}


@app.post("/api/ml/train")
def api_ml_train(req: MLTrainReq):
    try:
        return ml.train(req.horizon)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/ml/metrics")
def api_ml_metrics(horizon: int = 5):
    return ml.metrics(horizon) or {}


@app.get("/api/ml/predict/{ticker}")
def api_ml_predict(ticker: str, horizon: int = 5):
    try:
        return ml.predict_prob(ticker, horizon)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- Phase 6: ランキング・セクター・スクリーナー ----
@app.get("/api/analysis")
def api_analysis(horizon: int = 5):
    return analysis.analysis(horizon)


# ---- Phase 7: ニュース ----
@app.get("/api/news/{ticker}")
def api_news(ticker: str):
    return {"ticker": ticker, "items": news.fetch_news(ticker)}


# ---- Phase 8: 設定・リセット ----
class SettingsReq(BaseModel):
    fee_rate: float = 0.0


@app.get("/api/settings")
def api_get_settings():
    return {"fee_rate": float(db.get_setting("fee_rate", "0") or 0)}


@app.post("/api/settings")
def api_set_settings(req: SettingsReq):
    fee = max(0.0, min(5.0, req.fee_rate))
    db.set_setting("fee_rate", str(fee))
    return {"fee_rate": fee}


@app.post("/api/reset")
def api_reset():
    return trading.reset_practice()


@app.exception_handler(Exception)
async def _unhandled(_req, exc):  # noqa: ANN001
    return JSONResponse(status_code=500, content={"detail": str(exc)[:200]})


# frontend/ を配信（API ルートの後にマウントする）
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
