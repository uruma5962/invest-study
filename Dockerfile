# 投資研究ソフトを「どこでも動く箱」にする（Render / Hugging Face / Fly などで共通）。
FROM python:3.13-slim

WORKDIR /app

# 依存ライブラリだけ先に入れる（ビルドのキャッシュが効く）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリ本体（data/invest.db も同梱され、渡した相手がすぐ実データを見られる）
COPY . .

# クラウドが割り当てるポート($PORT)で待ち受ける。無ければ 8000。
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT}"]
