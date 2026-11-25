"""仮想売買のロジック。実データの直近終値で約定する。

- 日本株は日本株口座(JPY)、米国株は米国株口座(USD)に自動で振り分ける。
- 手数料は 0（練習用。必要になれば後で入れる）。
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime

from db import get_conn, get_setting
from fetch import quote


def _fee_rate() -> float:
    try:
        return float(get_setting("fee_rate", "0") or 0)
    except (TypeError, ValueError):
        return 0.0


class TradeError(Exception):
    pass


def _symbol_portfolio(conn, ticker: str) -> int:
    row = conn.execute("SELECT market FROM symbols WHERE ticker=?", (ticker,)).fetchone()
    if not row:
        raise TradeError(f"未登録の銘柄: {ticker}")
    return 1 if row["market"] == "JP" else 2  # 1=日本株口座, 2=米国株口座


def portfolio_summary(portfolio_id: int) -> dict:
    conn = get_conn()
    p = conn.execute("SELECT * FROM portfolios WHERE id=?", (portfolio_id,)).fetchone()
    if not p:
        conn.close()
        raise TradeError("口座が見つかりません")

    positions = []
    holdings_value = 0.0
    for pos in conn.execute(
        "SELECT * FROM positions WHERE portfolio_id=? AND quantity>0", (portfolio_id,)
    ).fetchall():
        q = quote(pos["ticker"])
        last = q["close"] if q else pos["avg_cost"]
        name_row = conn.execute(
            "SELECT name FROM symbols WHERE ticker=?", (pos["ticker"],)
        ).fetchone()
        mv = last * pos["quantity"]
        cost = pos["avg_cost"] * pos["quantity"]
        pnl = mv - cost
        holdings_value += mv
        positions.append({
            "ticker": pos["ticker"],
            "name": name_row["name"] if name_row else pos["ticker"],
            "quantity": pos["quantity"],
            "avg_cost": pos["avg_cost"],
            "last": last,
            "market_value": mv,
            "pnl": pnl,
            "pnl_pct": (pnl / cost * 100) if cost else 0.0,
        })

    realized = conn.execute(
        "SELECT COALESCE(SUM(realized_pnl),0) FROM trades WHERE portfolio_id=?",
        (portfolio_id,),
    ).fetchone()[0]
    conn.close()

    total = p["cash"] + holdings_value
    return {
        "id": p["id"],
        "name": p["name"],
        "currency": p["currency"],
        "cash": p["cash"],
        "holdings_value": holdings_value,
        "total": total,
        "unrealized_pnl": sum(x["pnl"] for x in positions),
        "realized_pnl": realized,
        "positions": positions,
    }


def trade(ticker: str, side: str, quantity: float) -> dict:
    """約定する。同時書き込みでロックされたら少し待って自動リトライする。"""
    last_err: Exception | None = None
    for attempt in range(6):
        try:
            return _trade_once(ticker, side, quantity)
        except sqlite3.OperationalError as e:  # database is locked など
            if "locked" in str(e).lower() and attempt < 5:
                last_err = e
                time.sleep(0.15 * (attempt + 1))
                continue
            raise
    raise TradeError(f"データベースが混雑しています。少し待って再試行してください（{last_err}）")


def _trade_once(ticker: str, side: str, quantity: float) -> dict:
    if quantity <= 0:
        raise TradeError("数量は1以上にしてください")
    side = side.lower()
    if side not in ("buy", "sell"):
        raise TradeError("side は buy か sell")

    q = quote(ticker)
    if not q:
        raise TradeError("先に『更新』で株価データを取得してください")
    price = q["close"]

    conn = get_conn()
    try:
        # 取引全体を1つの書き込みトランザクションにまとめ、競合（二重INSERT等）を防ぐ
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        pid = _symbol_portfolio(conn, ticker)
        pos = conn.execute(
            "SELECT * FROM positions WHERE portfolio_id=? AND ticker=?", (pid, ticker)
        ).fetchone()

        fee_rate = _fee_rate()
        gross = price * quantity
        fee = gross * fee_rate / 100.0
        realized = 0.0

        if side == "buy":
            cost = gross + fee
            # 現金を条件つきで引く（残高不足・競合は rowcount=0 で検出）
            cur = conn.execute(
                "UPDATE portfolios SET cash = cash - ? WHERE id=? AND cash >= ?",
                (cost, pid, cost),
            )
            if cur.rowcount == 0:
                bal = conn.execute("SELECT cash FROM portfolios WHERE id=?", (pid,)).fetchone()
                conn.rollback()
                raise TradeError(
                    f"資金不足（必要 {cost:,.0f} / 残高 {bal['cash'] if bal else 0:,.0f}）"
                )
            # UPSERT：行が無ければ新規、あれば加重平均で数量・平均取得を原子的に更新
            conn.execute(
                "INSERT INTO positions(portfolio_id,ticker,quantity,avg_cost) VALUES(?,?,?,?) "
                "ON CONFLICT(portfolio_id,ticker) DO UPDATE SET "
                "avg_cost = (positions.avg_cost*positions.quantity + excluded.avg_cost*excluded.quantity)"
                " / (positions.quantity + excluded.quantity), "
                "quantity = positions.quantity + excluded.quantity",
                (pid, ticker, quantity, price),
            )
        else:  # sell
            pos = conn.execute(
                "SELECT * FROM positions WHERE portfolio_id=? AND ticker=?", (pid, ticker)
            ).fetchone()
            if not pos or pos["quantity"] < quantity - 1e-9:
                held = pos["quantity"] if pos else 0
                conn.rollback()
                raise TradeError(f"保有数量が足りません（保有 {held}）")
            proceeds = gross - fee
            realized = (price - pos["avg_cost"]) * quantity - fee
            new_qty = pos["quantity"] - quantity
            if new_qty <= 1e-9:  # 全部売ったら行ごと消す（ゼロ残を残さない）
                conn.execute(
                    "DELETE FROM positions WHERE portfolio_id=? AND ticker=?", (pid, ticker)
                )
            else:
                conn.execute(
                    "UPDATE positions SET quantity=? WHERE portfolio_id=? AND ticker=?",
                    (new_qty, pid, ticker),
                )
            conn.execute("UPDATE portfolios SET cash=cash+? WHERE id=?", (proceeds, pid))

        conn.execute(
            "INSERT INTO trades(portfolio_id,ticker,side,quantity,price,fee,realized_pnl,traded_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (pid, ticker, side, quantity, price, fee, realized,
             datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()

    snapshot_equity()  # 取引のたびに資産推移を記録
    return {"ticker": ticker, "side": side, "quantity": quantity, "price": price,
            "realized_pnl": realized, "portfolio_id": pid}


def snapshot_equity() -> None:
    """両口座の総資産を1点ずつ記録する（資産推移グラフ用）。"""
    conn = get_conn()
    ts = datetime.now().isoformat(timespec="seconds")
    for pid in (1, 2):
        try:
            total = portfolio_summary(pid)["total"]
        except TradeError:
            continue
        conn.execute("INSERT INTO equity(portfolio_id,ts,total) VALUES(?,?,?)", (pid, ts, total))
    conn.commit()
    conn.close()


def equity_series() -> dict:
    conn = get_conn()
    out: dict[str, list] = {"1": [], "2": []}
    for r in conn.execute("SELECT portfolio_id, ts, total FROM equity ORDER BY id").fetchall():
        out[str(r["portfolio_id"])].append({"ts": r["ts"], "total": r["total"]})
    conn.close()
    return out


def reset_practice() -> dict:
    """練習をやり直す。取引・保有・予測を消し、口座の現金を初期額に戻す。"""
    import db
    conn = get_conn()
    conn.executescript("DELETE FROM trades; DELETE FROM positions; DELETE FROM predictions; DELETE FROM equity;")
    for pid, _name, _cur, cash in db.SEED_PORTFOLIOS:
        conn.execute("UPDATE portfolios SET cash=? WHERE id=?", (cash, pid))
    conn.commit()
    conn.close()
    return {"reset": True}


def trade_history(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT t.*, s.name AS name, p.currency AS currency "
        "FROM trades t "
        "LEFT JOIN symbols s ON s.ticker=t.ticker "
        "LEFT JOIN portfolios p ON p.id=t.portfolio_id "
        "ORDER BY t.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
