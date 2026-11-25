"""ローカルで起動するだけのスクリプト。

    python run.py
でサーバーが立ち上がり、ブラウザで http://127.0.0.1:8000 を開く。
"""
import pathlib
import sys

import uvicorn

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "backend"))

if __name__ == "__main__":
    print("投資研究ソフト: http://127.0.0.1:8000  (止めるには Ctrl+C)")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
