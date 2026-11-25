"""機械学習による上昇/下落の予測（Phase 5）。

- 全ての株式銘柄の日足から特徴量（比率ベース）を作り、1つのモデルを学習する。
- 目的変数: horizon 営業日後の終値が今より高いか（上がる=1）。
- 時系列を守って前80%で学習・後20%で検証（先読み防止）。

⚠️ 日足＋単純な指標だけの簡易モデル。的中率は50%前後が普通で、
   当たる保証はない。『当て勘（多数派）ベースライン』と必ず比べること。
"""
from __future__ import annotations

import json
import warnings

import numpy as np
import pandas as pd

from db import DATA_DIR, get_conn

warnings.simplefilter("ignore")

FEATURES = [
    "ret1", "ret5", "ret10", "ret20",
    "c_sma5", "c_sma25", "c_sma75",
    "sma5_25", "sma25_75",
    "rsi", "macd_hist", "vol20", "volrat",
]


def _features_for(g: pd.DataFrame) -> pd.DataFrame:
    """1銘柄（日付昇順）から特徴量を作る。"""
    c = g["close"].astype(float)
    v = g["volume"].astype(float)
    f = pd.DataFrame(index=g.index)
    f["ret1"] = c.pct_change(1)
    f["ret5"] = c.pct_change(5)
    f["ret10"] = c.pct_change(10)
    f["ret20"] = c.pct_change(20)
    sma5, sma25, sma75 = c.rolling(5).mean(), c.rolling(25).mean(), c.rolling(75).mean()
    f["c_sma5"] = c / sma5 - 1
    f["c_sma25"] = c / sma25 - 1
    f["c_sma75"] = c / sma75 - 1
    f["sma5_25"] = sma5 / sma25 - 1
    f["sma25_75"] = sma25 / sma75 - 1
    d = c.diff()
    gain = d.clip(lower=0).rolling(14).mean()
    loss = (-d.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    f["rsi"] = (100 - 100 / (1 + rs)) / 100
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    sig = macd.ewm(span=9, adjust=False).mean()
    f["macd_hist"] = (macd - sig) / c
    f["vol20"] = f["ret1"].rolling(20).std()
    f["volrat"] = v / v.rolling(20).mean() - 1
    f["close"] = c.values
    f["date"] = g["date"].values
    return f


def _load_stocks() -> pd.DataFrame:
    conn = get_conn()
    rows = conn.execute(
        "SELECT p.ticker, p.date, p.close, p.volume FROM prices p "
        "JOIN symbols s ON s.ticker=p.ticker WHERE s.kind='stock' "
        "ORDER BY p.ticker, p.date"
    ).fetchall()
    conn.close()
    return pd.DataFrame([dict(r) for r in rows])


def build_dataset(horizon: int = 5) -> pd.DataFrame | None:
    df = _load_stocks()
    if df.empty:
        return None
    parts = []
    for t, g in df.groupby("ticker"):
        g = g.sort_values("date").reset_index(drop=True)
        f = _features_for(g)
        future = g["close"].shift(-horizon)
        f["target"] = (future.values > g["close"].values).astype(float)
        f["has_future"] = future.notna().values
        f["ticker"] = t
        parts.append(f)
    allf = pd.concat(parts, ignore_index=True)
    allf = allf.dropna(subset=FEATURES)
    allf = allf[allf["has_future"]]
    return allf


def train(horizon: int = 5) -> dict:
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score
    import joblib

    data = build_dataset(horizon)
    if data is None or len(data) < 200:
        raise ValueError("学習データが足りません。『更新』で株価を取得してから試してください")

    data = data.sort_values("date")
    X = data[FEATURES].values
    y = data["target"].values
    n = len(data)
    split = int(n * 0.8)
    Xtr, Xte, ytr, yte = X[:split], X[split:], y[:split], y[split:]

    model = RandomForestClassifier(
        n_estimators=200, max_depth=5, min_samples_leaf=20,
        random_state=0, class_weight="balanced",
    )
    model.fit(Xtr, ytr)
    acc = float(accuracy_score(yte, model.predict(Xte)))
    baseline = float(max(yte.mean(), 1 - yte.mean())) if len(yte) else 0.5

    # 実運用の予測用に、全データで学習し直して保存
    model.fit(X, y)
    joblib.dump(model, DATA_DIR / f"model_h{horizon}.joblib")

    imp = sorted(zip(FEATURES, model.feature_importances_), key=lambda x: -x[1])[:5]
    metrics = {
        "horizon": horizon,
        "n": int(n),
        "test_accuracy": acc,
        "baseline": baseline,
        "up_ratio": float(y.mean()),
        "top_features": [{"name": k, "importance": round(float(v), 3)} for k, v in imp],
    }
    (DATA_DIR / f"ml_metrics_h{horizon}.json").write_text(
        json.dumps(metrics, ensure_ascii=False), encoding="utf-8")
    return metrics


def metrics(horizon: int = 5) -> dict | None:
    p = DATA_DIR / f"ml_metrics_h{horizon}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def predict_prob(ticker: str, horizon: int = 5) -> dict:
    import joblib

    mp = DATA_DIR / f"model_h{horizon}.joblib"
    if not mp.exists():
        raise ValueError("先にモデルを学習してください")
    conn = get_conn()
    rows = conn.execute(
        "SELECT ticker, date, close, volume FROM prices WHERE ticker=? ORDER BY date",
        (ticker,),
    ).fetchall()
    conn.close()
    if len(rows) < 80:
        raise ValueError("この銘柄はデータ不足です（『更新』で取得してください）")

    g = pd.DataFrame([dict(r) for r in rows])
    f = _features_for(g).dropna(subset=FEATURES)
    if f.empty:
        raise ValueError("特徴量を作れるだけのデータがありません")

    model = joblib.load(mp)
    x = f[FEATURES].values[-1:]
    classes = list(model.classes_)
    prob_up = float(model.predict_proba(x)[0][classes.index(1.0)]) * 100
    direction = "up" if prob_up >= 50 else "down"
    probability = prob_up if direction == "up" else 100 - prob_up
    return {"ticker": ticker, "horizon": horizon, "prob_up": prob_up,
            "direction": direction, "probability": probability}
