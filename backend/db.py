"""SQLite の接続・テーブル定義・初期データ投入。

このソフトの全データ（銘柄・株価・仮想口座・取引・予測）は
data/invest.db というファイル1個に入る。サーバー不要。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

# backend/ の1つ上がプロジェクトルート
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "invest.db"


def get_conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 8000")  # 同時書き込みのロックを少し待つ
    # WAL: 読み取りが書き込みをブロックしないので「database is locked」が起きにくい
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.OperationalError:
        pass  # WAL 不可の環境でも通常モードで動く
    return conn


# ------------------------------------------------------------------
# 初期データ（銘柄マスタ・指数・仮想口座）
# ------------------------------------------------------------------
SEED_STOCKS = [
    # ticker,     name,                 market, sector,       currency
    # --- 日本株 ---
    ("7203.T", "トヨタ自動車",         "JP", "自動車",     "JPY"),
    ("6758.T", "ソニーグループ",       "JP", "電機",       "JPY"),
    ("9984.T", "ソフトバンクグループ",  "JP", "通信",       "JPY"),
    ("8306.T", "三菱UFJ FG",          "JP", "銀行",       "JPY"),
    ("6861.T", "キーエンス",           "JP", "電機",       "JPY"),
    ("9983.T", "ファーストリテイリング", "JP", "小売",       "JPY"),
    ("8035.T", "東京エレクトロン",     "JP", "半導体",     "JPY"),
    ("6098.T", "リクルートHD",         "JP", "サービス",   "JPY"),
    ("9432.T", "日本電信電話",         "JP", "通信",       "JPY"),
    ("9433.T", "KDDI",               "JP", "通信",       "JPY"),
    ("4063.T", "信越化学工業",         "JP", "化学",       "JPY"),
    ("8058.T", "三菱商事",             "JP", "商社",       "JPY"),
    ("7974.T", "任天堂",               "JP", "ゲーム",     "JPY"),
    ("7267.T", "ホンダ",               "JP", "自動車",     "JPY"),
    ("6501.T", "日立製作所",           "JP", "電機",       "JPY"),
    ("6981.T", "村田製作所",           "JP", "電子部品",   "JPY"),
    ("4502.T", "武田薬品工業",         "JP", "医薬",       "JPY"),
    ("8766.T", "東京海上HD",           "JP", "保険",       "JPY"),
    ("6367.T", "ダイキン工業",         "JP", "機械",       "JPY"),
    ("9020.T", "JR東日本",            "JP", "鉄道",       "JPY"),
    # --- 米国株 ---
    ("AAPL",   "Apple",              "US", "テクノロジー", "USD"),
    ("NVDA",   "NVIDIA",             "US", "半導体",     "USD"),
    ("MSFT",   "Microsoft",          "US", "テクノロジー", "USD"),
    ("TSLA",   "Tesla",              "US", "自動車",     "USD"),
    ("AMZN",   "Amazon",             "US", "消費",       "USD"),
    ("GOOGL",  "Alphabet",           "US", "テクノロジー", "USD"),
    ("META",   "Meta Platforms",     "US", "テクノロジー", "USD"),
    ("AVGO",   "Broadcom",           "US", "半導体",     "USD"),
    ("AMD",    "AMD",                "US", "半導体",     "USD"),
    ("NFLX",   "Netflix",            "US", "メディア",   "USD"),
    ("JPM",    "JPMorgan",           "US", "銀行",       "USD"),
    ("V",      "Visa",               "US", "金融",       "USD"),
    ("MA",     "Mastercard",         "US", "金融",       "USD"),
    ("WMT",    "Walmart",            "US", "小売",       "USD"),
    ("COST",   "Costco",             "US", "小売",       "USD"),
    ("KO",     "Coca-Cola",          "US", "消費",       "USD"),
    ("DIS",    "Walt Disney",        "US", "メディア",   "USD"),
    ("INTC",   "Intel",              "US", "半導体",     "USD"),
    ("ORCL",   "Oracle",             "US", "テクノロジー", "USD"),
    ("BA",     "Boeing",             "US", "航空",       "USD"),
]

# 追加ユニバース（日経225中心＋S&P主要）を結合。ティッカー重複はコア優先で除く。
try:
    from seed_universe import EXTRA_STOCKS
    _seen = {t for t, *_ in SEED_STOCKS}
    SEED_STOCKS = SEED_STOCKS + [row for row in EXTRA_STOCKS if row[0] not in _seen]
except Exception:  # noqa: BLE001  追加リストが読めなくてもコア40銘柄で動く
    pass

# テーマ別の「まとめて追加」用プリセット（ticker, name, market, sector）
PRESET_GROUPS: dict[str, list[tuple]] = {
    "米ハイテク(半導体・ソフト)": [
        ("QCOM", "Qualcomm", "US", "半導体"),
        ("TXN", "Texas Instruments", "US", "半導体"),
        ("MU", "Micron", "US", "半導体"),
        ("CRM", "Salesforce", "US", "テクノロジー"),
        ("ADBE", "Adobe", "US", "テクノロジー"),
        ("CSCO", "Cisco", "US", "テクノロジー"),
        ("PLTR", "Palantir", "US", "テクノロジー"),
    ],
    "米ディフェンシブ(生活・医薬)": [
        ("PEP", "PepsiCo", "US", "消費"),
        ("MCD", "McDonald's", "US", "外食"),
        ("PG", "P&G", "US", "日用品"),
        ("JNJ", "Johnson & Johnson", "US", "医薬"),
        ("PFE", "Pfizer", "US", "医薬"),
        ("T", "AT&T", "US", "通信"),
    ],
    "日本の半導体・電機": [
        ("6857.T", "アドバンテスト", "JP", "半導体"),
        ("6762.T", "TDK", "JP", "電子部品"),
        ("6702.T", "富士通", "JP", "IT"),
        ("6503.T", "三菱電機", "JP", "電機"),
        ("6752.T", "パナソニック", "JP", "電機"),
        ("6954.T", "ファナック", "JP", "機械"),
    ],
    "日本の商社・金融": [
        ("8031.T", "三井物産", "JP", "商社"),
        ("8053.T", "住友商事", "JP", "商社"),
        ("8316.T", "三井住友FG", "JP", "銀行"),
        ("8411.T", "みずほFG", "JP", "銀行"),
        ("8591.T", "オリックス", "JP", "金融"),
    ],
}

SEED_INDICES = [
    # ticker,   name,          currency(表示単位の目安)
    ("^N225",   "日経平均",      "JPY"),
    ("^GSPC",   "S&P 500",      "USD"),
    ("^IXIC",   "NASDAQ",       "USD"),
    ("^DJI",    "NYダウ",        "USD"),
    ("^SOX",    "SOX 半導体",    "USD"),
    ("^VIX",    "VIX",          "USD"),
    ("JPY=X",   "USD/JPY",      "JPY"),
    ("^TNX",    "米10年債利回り", "USD"),
    ("GC=F",    "金",           "USD"),
    ("CL=F",    "原油",         "USD"),
    ("BTC-USD", "Bitcoin",      "USD"),
]

SEED_PORTFOLIOS = [
    # id, name,        currency, cash（練習用の「勉強代」想定。小さめに）
    (1, "日本株口座", "JPY", 100_000),
    (2, "米国株口座", "USD", 700),
]


def get_setting(key: str, default: str | None = None) -> str | None:
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
    conn.commit()
    conn.close()


def init_db() -> None:
    conn = get_conn()
    c = conn.cursor()

    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS symbols (
            ticker   TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            market   TEXT NOT NULL,        -- 'JP' / 'US' / 'IDX'
            sector   TEXT,
            currency TEXT NOT NULL,
            kind     TEXT NOT NULL DEFAULT 'stock'  -- 'stock' / 'index'
        );

        CREATE TABLE IF NOT EXISTS prices (
            ticker TEXT NOT NULL,
            date   TEXT NOT NULL,          -- 'YYYY-MM-DD'
            open   REAL, high REAL, low REAL, close REAL, volume REAL,
            PRIMARY KEY (ticker, date)
        );

        CREATE TABLE IF NOT EXISTS watchlists (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS watchlist_items (
            watchlist_id INTEGER NOT NULL,
            ticker       TEXT NOT NULL,
            sort_order   INTEGER DEFAULT 0,
            PRIMARY KEY (watchlist_id, ticker)
        );

        CREATE TABLE IF NOT EXISTS portfolios (
            id       INTEGER PRIMARY KEY,
            name     TEXT NOT NULL,
            currency TEXT NOT NULL,
            cash     REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS positions (
            portfolio_id INTEGER NOT NULL,
            ticker       TEXT NOT NULL,
            quantity     REAL NOT NULL,
            avg_cost     REAL NOT NULL,
            PRIMARY KEY (portfolio_id, ticker)
        );

        CREATE TABLE IF NOT EXISTS trades (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL,
            ticker       TEXT NOT NULL,
            side         TEXT NOT NULL,    -- 'buy' / 'sell'
            quantity     REAL NOT NULL,
            price        REAL NOT NULL,
            fee          REAL NOT NULL DEFAULT 0,
            realized_pnl REAL DEFAULT 0,   -- 売却時のみ
            traded_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS equity (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL,
            ts           TEXT NOT NULL,
            total        REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS predictions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker       TEXT NOT NULL,
            made_on      TEXT NOT NULL,    -- 予測した基準日（直近の株価日）
            base_price   REAL NOT NULL,    -- 基準日の終値
            horizon_days INTEGER NOT NULL, -- 何営業日先を見るか
            target_date  TEXT NOT NULL,    -- 答え合わせの目安日
            direction    TEXT NOT NULL,    -- 'up' / 'down'
            probability  REAL,             -- 参考確率(0-100)
            source       TEXT NOT NULL,    -- '自分' / 'AI'
            note         TEXT,
            resolved     INTEGER DEFAULT 0,
            actual_price REAL,
            actual_dir   TEXT,             -- 'up' / 'down' / 'flat'
            correct      INTEGER           -- 1 / 0
        );
        """
    )

    # --- seed: 銘柄（既存DBにも不足分を毎回追加する。重複は無視） ---
    for t, name, mk, sec, cur in SEED_STOCKS:
        c.execute(
            "INSERT OR IGNORE INTO symbols(ticker,name,market,sector,currency,kind) "
            "VALUES(?,?,?,?,?, 'stock')",
            (t, name, mk, sec, cur),
        )
    for t, name, cur in SEED_INDICES:
        c.execute(
            "INSERT OR IGNORE INTO symbols(ticker,name,market,sector,currency,kind) "
            "VALUES(?,?, 'IDX', NULL, ?, 'index')",
            (t, name, cur),
        )

    # --- seed: 仮想口座 ---
    if c.execute("SELECT COUNT(*) FROM portfolios").fetchone()[0] == 0:
        for pid, name, cur, cash in SEED_PORTFOLIOS:
            c.execute(
                "INSERT INTO portfolios(id,name,currency,cash) VALUES(?,?,?,?)",
                (pid, name, cur, cash),
            )

    # --- seed: 設定（手数料率など） ---
    if c.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0:
        c.execute("INSERT INTO settings(key,value) VALUES('fee_rate','0')")

    # --- seed: 既定ウォッチリスト。無ければ作り、SEED銘柄で不足分を補う ---
    row = c.execute("SELECT id FROM watchlists ORDER BY id LIMIT 1").fetchone()
    if row is None:
        c.execute("INSERT INTO watchlists(name) VALUES('マイウォッチ')")
        wid = c.lastrowid
    else:
        wid = row["id"]
    for i, (t, *_rest) in enumerate(SEED_STOCKS):
        c.execute(
            "INSERT OR IGNORE INTO watchlist_items(watchlist_id,ticker,sort_order) VALUES(?,?,?)",
            (wid, t, i),
        )

    conn.commit()
    conn.close()


if __name__ == "__main__":
    init_db()
    print("DB initialized at", DB_PATH)
