"""Phase 7: 関連ニュースの取得と簡易センチメント判定。

⚠️ ここでの「ポジティブ/ネガティブ」は**キーワードによる簡易判定**で、
   本物のAI（大規模言語モデル）による要約・分析ではない。
   本格的な要約が必要なら、別途 LLM の API キーを組み込む想定（Phase 7の発展）。
"""
from __future__ import annotations

import datetime as dt
import warnings

import yfinance as yf

warnings.simplefilter("ignore")

POS = ["beat", "beats", "surge", "surges", "rise", "rises", "gain", "gains", "record",
       "growth", "upgrade", "strong", "profit", "jump", "jumps", "rally", "soar",
       "上方修正", "増益", "最高益", "好調", "上昇", "買い"]
NEG = ["miss", "misses", "fall", "falls", "drop", "drops", "decline", "cut", "cuts",
       "downgrade", "weak", "loss", "losses", "lawsuit", "probe", "plunge", "slump",
       "warning", "下方修正", "減益", "赤字", "不調", "下落", "売り", "リコール"]


def fetch_news(ticker: str, limit: int = 8) -> list[dict]:
    try:
        raw = yf.Ticker(ticker).news or []
    except Exception:  # noqa: BLE001
        raw = []

    items = []
    for n in raw:
        content = n.get("content") if isinstance(n.get("content"), dict) else None
        title = n.get("title") or (content or {}).get("title")
        if not title:
            continue
        publisher = n.get("publisher") or (content or {}).get("provider", {}).get("displayName", "")
        link = n.get("link") or (content or {}).get("canonicalUrl", {}).get("url", "") \
            or (content or {}).get("clickThroughUrl", {}).get("url", "")
        when = _pub_time(n, content)
        items.append({
            "title": title,
            "publisher": publisher or "",
            "link": link or "",
            "sentiment": _sentiment(title),
            "date": when.strftime("%Y-%m-%d") if when else None,     # チャートに印を打つ日
            "ts": when.strftime("%Y-%m-%d %H:%M") if when else None,  # 表示用（日時）
        })

    # 新しい順（日時の降順。日時不明は末尾）に並べ、同じ見出しの重複は除く
    items.sort(key=lambda x: x["ts"] or "", reverse=True)
    seen: set[str] = set()
    uniq = []
    for it in items:
        if it["title"] in seen:
            continue
        seen.add(it["title"])
        uniq.append(it)
    return uniq[:limit]


def _pub_time(n: dict, content: dict | None) -> dt.datetime | None:
    """ニュースの配信日時を取り出す（新旧スキーマ対応）。ローカル時刻に変換して返す。"""
    iso = (content or {}).get("pubDate") or (content or {}).get("displayTime")
    if iso:
        try:
            t = dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            return t.astimezone().replace(tzinfo=None)  # ローカル日時（naive）
        except (ValueError, TypeError):
            pass
    ep = n.get("providerPublishTime")
    if ep:
        try:
            return dt.datetime.fromtimestamp(int(ep))
        except (ValueError, TypeError, OSError):
            pass
    return None


def _sentiment(title: str) -> str:
    tl = title.lower()
    p = sum(1 for w in POS if w in tl)
    n = sum(1 for w in NEG if w in tl)
    if p > n:
        return "pos"
    if n > p:
        return "neg"
    return "neu"
