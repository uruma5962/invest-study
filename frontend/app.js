"use strict";

// ---- API ヘルパ ----
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || ("エラー " + res.status));
  return data;
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// ---- 表示ヘルパ ----
const el = (id) => document.getElementById(id);
function num(v, dec = 2) {
  if (v === null || v === undefined || isNaN(v)) return "-";
  return Number(v).toLocaleString("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: dec });
}
function money(v, cur) {
  if (v === null || v === undefined || isNaN(v)) return "-";
  const dec = cur === "JPY" ? 0 : 2;
  const sym = cur === "JPY" ? "¥" : "$";
  return sym + Number(v).toLocaleString("ja-JP", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : "flat"; }
function pct(v) {
  if (v === null || v === undefined || isNaN(v)) return '<span class="flat">-</span>';
  const s = (v > 0 ? "+" : "") + v.toFixed(2) + "%";
  return `<span class="${cls(v)}">${s}</span>`;
}
function signed(v, dec) {
  if (v === null || v === undefined || isNaN(v)) return '<span class="flat">-</span>';
  return `<span class="${cls(v)}">${v > 0 ? "+" : ""}${num(v, dec)}</span>`;
}
function toast(msg, isErr) {
  const t = el("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), 3000);
}

// ---- 使い方（目的）：短期スイング / 長期じっくり ----
let investMode = "short";
try { investMode = localStorage.getItem("invest_mode") || "short"; } catch (e) { investMode = "short"; }
function rangeForMode() { return investMode === "long" ? "1y" : "1mo"; }
function horizonForMode() { return investMode === "long" ? 20 : 5; }
function applyModeUI() {
  document.querySelectorAll("#modeChips .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.mode === investMode));
  const d = el("modeDesc");
  if (d) d.innerHTML = investMode === "long"
    ? "数ヶ月〜年の値動きでじっくり学ぶモード。チャートは最初に <b>1年</b>、予測は <b>20営業日</b> を既定にします。"
    : "数日〜数週間（スイング）で学ぶモード。チャートは最初に <b>1ヶ月</b>、予測は <b>5営業日</b> を既定にします。";
}
document.querySelectorAll("#modeChips .chip").forEach((c) => {
  c.onclick = () => {
    investMode = c.dataset.mode;
    try { localStorage.setItem("invest_mode", investMode); } catch (e) {}
    applyModeUI();
    toast(investMode === "long" ? "長期（じっくり）モードにしました" : "短期（スイング）モードにしました");
  };
});

// ---- タブ ----
let currentTab = "market";
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  saveUI();
  refresh();
}
document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});

// ---- 表示の記憶（この端末のブラウザに保存） ----
function saveUI() {
  try {
    localStorage.setItem("invest_ui", JSON.stringify({
      tab: currentTab, live: el("chkLive").checked, interval: el("liveInterval").value,
    }));
  } catch (e) { /* localStorage 不可でも動く */ }
}
function restoreUI() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("invest_ui") || "{}"); } catch (e) { s = {}; }
  if (s.interval) el("liveInterval").value = s.interval;
  if (s.tab && document.getElementById("view-" + s.tab)) {
    currentTab = s.tab;
    document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === s.tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + s.tab));
  }
  if (s.live) { el("chkLive").checked = true; startLive(); }
}

// ---- 更新 ----
el("btnUpdate").onclick = async () => {
  const btn = el("btnUpdate");
  btn.disabled = true; btn.textContent = "更新中…"; btn.classList.add("spin");
  try {
    const r = await post("/api/update", { scope: "all", period: "1y" });
    el("updated").textContent = "更新: " + new Date().toLocaleString("ja-JP") + ` (成功 ${r.success} / 失敗 ${r.fail})`;
    toast(`更新しました（成功 ${r.success}・失敗 ${r.fail}）`);
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = "更新"; btn.classList.remove("spin"); }
};

// ---- 自動更新（ライブ） ----
const prevClose = {};
function flashCls(ticker, close) {
  const p = prevClose[ticker];
  if (p == null || close == null || close === p) return "";
  return close > p ? " flash-up" : " flash-down";
}
let liveTimer = null, liveBusy = false;
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
function startLive() {
  stopLive();
  const sec = Number(el("liveInterval").value) || 60;
  liveTick();
  liveTimer = setInterval(liveTick, sec * 1000);
}
async function liveTick() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const r = await post("/api/refresh_live");
    el("updated").textContent = "自動更新 " + new Date().toLocaleTimeString("ja-JP") + ` (${r.success}件)`;
    el("updated").classList.add("live-on");
    if (currentTab === "market") await loadMarket();
    else if (currentTab === "trade") await loadTrade();
  } catch (e) { /* 一時失敗は次の周期で回復 */ }
  finally { liveBusy = false; }
}
el("chkLive").onchange = (e) => {
  if (e.target.checked) { startLive(); }
  else { stopLive(); el("updated").classList.remove("live-on"); }
  saveUI();
};
el("liveInterval").onchange = () => { if (el("chkLive").checked) startLive(); saveUI(); };

// ---- マーケット ----
let watchData = [];
let lastMarket = null;  // 直近の /api/market（「なぜ動いた？」の地合い分解で使い回す）
const WL_PAGE = 60; // 一度に表示する最大件数（多すぎて見づらいのを防ぐ）
const wlState = { q: "", mk: "", sector: "", sortKey: null, sortDir: 1, limit: WL_PAGE };

async function loadMarket() {
  const m = await api("/api/market");
  lastMarket = m;
  el("indexTiles").innerHTML = m.indices.map((i) => tile(i)).join("");
  el("breadth").textContent = m.breadth.total
    ? `上昇 ${m.breadth.up} / ${m.breadth.total} 銘柄` : "（未更新）";
  watchData = m.watch;
  renderMarketSummary(m);
  fillSectorOptions();
  renderWatch();
  renderSectorMap();
  loadMovers();
  el("gainers").innerHTML = m.gainers.map((g) => miniRow(g)).join("") || emptyRow();
  el("losers").innerHTML = m.losers.map((g) => miniRow(g)).join("") || emptyRow();
  [...m.indices, ...m.watch].forEach((x) => { if (x.close != null) prevClose[x.ticker] = x.close; });
  loadPresets();
  bindRowClicks();
}
// セクター絞り込みの選択肢を、件数つきで作る（現在の市場フィルタを反映）
function fillSectorOptions() {
  const sel = el("wlSector");
  if (!sel) return;
  const base = wlState.mk ? watchData.filter((w) => w.market === wlState.mk) : watchData;
  const counts = {};
  base.forEach((w) => { const s = w.sector || "その他"; counts[s] = (counts[s] || 0) + 1; });
  const sectors = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "ja"));
  sel.innerHTML = `<option value="">すべての業種 (${base.length})</option>` +
    sectors.map((s) => `<option value="${s}">${s}（${counts[s]}）</option>`).join("");
  if (wlState.sector && counts[wlState.sector]) sel.value = wlState.sector;
  else { sel.value = ""; wlState.sector = ""; }
}
function renderWatch() {
  let rows = watchData.slice();
  if (wlState.mk) rows = rows.filter((w) => w.market === wlState.mk);
  if (wlState.sector) rows = rows.filter((w) => (w.sector || "その他") === wlState.sector);
  if (wlState.q) {
    const q = wlState.q.toLowerCase();
    rows = rows.filter((w) => (w.name || "").toLowerCase().includes(q) || (w.ticker || "").toLowerCase().includes(q));
  }
  if (wlState.sortKey) {
    const k = wlState.sortKey, d = wlState.sortDir;
    rows.sort((a, b) => {
      if (k === "name") return (a.name || "").localeCompare(b.name || "", "ja") * d;
      const va = a[k] == null ? -Infinity : a[k], vb = b[k] == null ? -Infinity : b[k];
      return (va - vb) * d;
    });
  }
  const total = rows.length;
  const shown = rows.slice(0, wlState.limit);
  let html = shown.map((w) => watchRow(w)).join("") ||
    `<tr><td colspan="7" class="note">該当する銘柄がありません。「更新」でデータ取得、または条件を変えてください。</td></tr>`;
  if (total > wlState.limit) {
    const rest = total - wlState.limit;
    html += `<tr class="more-row"><td colspan="7" style="text-align:center">
      <button class="sm" id="wlMore">もっと見る（残り ${rest} 件）</button>
      <span class="note" style="margin-left:8px">${shown.length} / ${total} 件を表示中</span></td></tr>`;
  } else if (total > WL_PAGE) {
    html += `<tr class="more-row"><td colspan="7" class="note" style="text-align:center">${total} 件すべて表示中</td></tr>`;
  }
  el("watchBody").innerHTML = html;
  const more = el("wlMore");
  if (more) more.onclick = () => { wlState.limit += WL_PAGE * 2; renderWatch(); };
  document.querySelectorAll("#wlTable th.sortable .arrow").forEach((a) => {
    const th = a.closest("th");
    a.textContent = th.dataset.sort === wlState.sortKey ? (wlState.sortDir > 0 ? "▲" : "▼") : "";
  });
  bindRowClicks();
  bindRemoveButtons();
}
// 市場サマリー：当日の実データから「全体の地合い」を観測して一言で示す。
// ※ 予測・助言ではない。原因（ニュース）の断定もしない（データ由来のみ）。
const EQUITY_IDX = ["日経平均", "S&P 500", "NASDAQ", "NYダウ", "SOX 半導体"];
function renderMarketSummary(m) {
  const box = el("marketSummary");
  if (!box) return;
  const idx = m.indices || [];
  const eq = idx.filter((i) => EQUITY_IDX.includes(i.name) && i.change_pct != null);
  const vix = idx.find((i) => (i.name || "").toUpperCase().includes("VIX"));
  const vixPct = vix && vix.change_pct != null ? vix.change_pct : null;

  // ウォッチリストの騰落（値が入っている銘柄だけ・0は除外）
  const w = watchData.filter((x) => x.change_pct != null && x.change_pct !== 0);
  const up = w.filter((x) => x.change_pct > 0).length;
  const down = w.filter((x) => x.change_pct < 0).length;
  const total = w.length;
  const avgW = total ? w.reduce((s, x) => s + x.change_pct, 0) / total : null;

  if (!eq.length && total === 0) {
    box.innerHTML = `<div class="mkt-head"><span class="mkt-dot flat"></span>
      <span class="mkt-line note">右上の「更新」を押すと、当日の地合いサマリーが出ます。</span></div>`;
    return;
  }

  // セクターの最強・最弱（ウォッチリストの平均騰落から）
  const agg = {};
  watchData.forEach((x) => {
    if (x.change_pct == null || x.change_pct === 0) return;
    const s = x.sector || "その他";
    (agg[s] = agg[s] || { sum: 0, n: 0 }).sum += x.change_pct; agg[s].n += 1;
  });
  const secRows = Object.keys(agg)
    .filter((s) => agg[s].n >= 2)
    .map((s) => ({ s, avg: agg[s].sum / agg[s].n }));
  secRows.sort((a, b) => b.avg - a.avg);
  const best = secRows[0], worst = secRows[secRows.length - 1];

  // 地合いトーン（株価指数の平均＋VIX の素直な読み。あくまで観測）
  const eqDown = eq.filter((i) => i.change_pct < 0).length;
  const avgEq = eq.length ? eq.reduce((s, i) => s + i.change_pct, 0) / eq.length : null;
  const vixUp = vixPct != null && vixPct > 0;
  let tone = "flat", line;
  const downish = (avgEq != null && avgEq < -0.3) || (total && down > up * 1.3);
  const upish = (avgEq != null && avgEq > 0.3) && !vixUp || (total && up > down * 1.3);
  if (downish && vixUp) {
    tone = "down";
    line = `主要指数の多くが下落し、VIX（恐怖指数）も上昇。<b>リスク回避（リスクオフ）寄り</b>の地合いに見えます。`;
  } else if (downish) {
    tone = "down";
    line = `主要指数は<b>やや下げ基調</b>。全体に売り優勢に見えます。`;
  } else if (upish) {
    tone = "up";
    line = `主要指数は<b>上げ基調</b>。VIXも落ち着き、買い優勢に見えます。`;
  } else {
    tone = "flat";
    line = `上げ下げが混在した<b>方向感の乏しい</b>地合いに見えます。`;
  }
  const whenTxt = eqDown ? `株価指数 ${eqDown}/${eq.length} が下落` : "株価指数は堅調";

  const chip = (label, v, cls) =>
    `<span class="mkt-chip"><span class="k">${label}</span>` +
    `<span class="v ${cls || ""}">${v}</span></span>`;
  const chips = [];
  if (total) chips.push(chip("上昇/下落", `${up} / ${down} 銘柄`, ""));
  if (avgW != null) chips.push(chip("平均騰落", pct(avgW), cls(avgW)));
  if (worst && worst !== best) chips.push(chip("最も弱い", `${worst.s} ${pct(worst.avg)}`, cls(worst.avg)));
  if (best && best !== worst) chips.push(chip("最も強い", `${best.s} ${pct(best.avg)}`, cls(best.avg)));
  if (vixPct != null) chips.push(chip("VIX", pct(vixPct), vixPct > 0 ? "down" : "up"));

  box.innerHTML = `
    <div class="mkt-head">
      <span class="mkt-dot ${tone}"></span>
      <span class="mkt-line"><b>${whenTxt}。</b> ${line} <span class="note">（観測）</span></span>
    </div>
    <div class="mkt-chips">${chips.join("")}</div>
    <div class="mkt-foot note">※ 当日の実データからの<b>観測</b>で、予測・投資助言ではありません。原因（ニュース）の断定はしません。VIX上昇＝警戒感の高まりという一般的な読みを添えています。</div>`;
}

// セクター騰落マップ：業種ごとの平均騰落率を色分けで表示
function renderSectorMap() {
  const box = el("sectorMap");
  if (!box) return;
  const agg = {};
  watchData.forEach((w) => {
    if (w.change_pct == null) return;
    const s = w.sector || "その他";
    (agg[s] = agg[s] || { sum: 0, n: 0 }).sum += w.change_pct;
    agg[s].n += 1;
  });
  const rows = Object.keys(agg).map((s) => ({ sector: s, avg: agg[s].sum / agg[s].n, n: agg[s].n }));
  if (!rows.length) {
    el("sectorNote").textContent = "（未更新：右上「更新」でデータ取得）";
    box.innerHTML = "";
    return;
  }
  rows.sort((a, b) => b.avg - a.avg);
  el("sectorNote").textContent = `${rows.length} 業種`;
  box.innerHTML = rows.map((r) => {
    const up = r.avg >= 0;
    const a = Math.min(Math.abs(r.avg) / 3, 1) * 0.5 + 0.08;  // 騰落の大きさで濃さ
    const col = up ? `rgba(47,211,107,${a.toFixed(2)})` : `rgba(255,93,98,${a.toFixed(2)})`;
    return `<button class="sector-cell" data-sector="${r.sector}" style="background:${col}">
      <span class="s-name">${r.sector}</span>
      <span class="s-chg ${up ? "up" : "down"}">${pct(r.avg)}</span>
      <span class="s-n note">${r.n}</span>
    </button>`;
  }).join("");
  box.querySelectorAll(".sector-cell").forEach((c) => {
    c.onclick = () => {
      wlState.mk = ""; wlState.sector = c.dataset.sector; wlState.limit = WL_PAGE;
      document.querySelectorAll("#wlMarket .chip").forEach((x) => x.classList.toggle("active", x.dataset.mk === ""));
      fillSectorOptions();
      const sel = el("wlSector"); if (sel) sel.value = c.dataset.sector;
      renderWatch();
      el("wlSearch").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

// 値動きが大きい銘柄（動的リスト）。更新のたびに入れ替わる。
let moversData = [];
let moversMv = ""; // "" すべて / "normal" 両方向のみ / "abn" 異常のみ
async function loadMovers() {
  try { const data = await api("/api/movers?limit=40&win=15&min_vol=1.5"); moversData = data.movers || []; }
  catch (e) { return; }
  renderMovers();
}
function renderMovers() {
  let rows = moversData;
  if (moversMv === "normal") rows = rows.filter((w) => w.kind === "両方向");
  else if (moversMv === "abn") rows = rows.filter((w) => w.kind === "異常");
  const abn = moversData.filter((w) => w.kind === "異常").length;
  el("moversNote").textContent = moversData.length
    ? `${moversData.length} 銘柄（うち異常 ${abn}）`
    : "（データ不足：右上「更新」で履歴を取ると出ます）";
  el("moversBody").innerHTML = rows.map((w) => {
    const mk = w.market === "JP" ? "日本" : "米国";
    const tag = w.kind === "異常"
      ? `<span class="badge-abn">異常</span>${w.shock ? '<span class="badge-shock">急変</span>' : (w.trend ? '<span class="badge-shock">一方向</span>' : "")}`
      : `<span class="badge-norm">両方向</span>`;
    return `<tr class="clickable" data-ticker="${w.ticker}">
      <td>${w.name}<span class="tk">${w.ticker}</span></td>
      <td>${mk}</td>
      <td>${w.close == null ? "-" : money(w.close, w.currency)}</td>
      <td><b>${w.vol == null ? "-" : w.vol}%</b></td>
      <td class="note">±${w.range}%</td>
      <td>${pct(w.today)}</td>
      <td style="text-align:left">${tag}</td>
      <td class="note" style="text-align:left">${w.sector || "-"}</td>
    </tr>`;
  }).join("") ||
    `<tr><td colspan="8" class="note">条件に合う銘柄がありません。フィルタを変えるか、右上の「更新」で履歴を取得してください。</td></tr>`;
  document.querySelectorAll("#moversBody tr.clickable").forEach((tr) => {
    tr.onclick = () => openModal(tr.dataset.ticker);
  });
}
document.querySelectorAll("#moversFilter .chip").forEach((c) => {
  c.onclick = () => {
    moversMv = c.dataset.mv;
    document.querySelectorAll("#moversFilter .chip").forEach((x) => x.classList.toggle("active", x === c));
    renderMovers();
  };
});
function tile(i) {
  const c = i.change_pct;
  return `<div class="tile${flashCls(i.ticker, i.close)}" data-ticker="${i.ticker}">
    <div class="name">${i.name}</div>
    <div class="val">${num(i.close, 2)}</div>
    <div class="chg ${cls(c)}">${c == null ? "-" : pct(c)}</div>
  </div>`;
}
function watchRow(w) {
  const mk = w.market === "JP" ? "日本" : "米国";
  return `<tr class="clickable" data-ticker="${w.ticker}">
    <td>${w.name}<span class="tk">${w.ticker}</span></td>
    <td>${mk}</td>
    <td class="${flashCls(w.ticker, w.close)}">${w.close == null ? "-" : money(w.close, w.currency)}</td>
    <td>${signed(w.change, w.currency === "JPY" ? 0 : 2)}</td>
    <td>${pct(w.change_pct)}</td>
    <td class="note" style="text-align:left">${w.sector || "-"}</td>
    <td style="text-align:center"><button class="rm" data-rm="${w.ticker}" title="ウォッチから削除">×</button></td>
  </tr>`;
}
function bindRemoveButtons() {
  document.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const t = b.dataset.rm;
      try {
        await post("/api/watchlist/remove", { ticker: t });
        watchData = watchData.filter((w) => w.ticker !== t);
        renderWatch();
        toast(`${t} をウォッチから外しました`);
      } catch (err) { toast(err.message, true); }
    };
  });
}
// ツールバー（検索・市場フィルタ・並べ替え）の初期設定
el("wlSearch").oninput = (e) => { wlState.q = e.target.value.trim(); wlState.limit = WL_PAGE; renderWatch(); };
document.querySelectorAll("#wlMarket .chip").forEach((c) => {
  c.onclick = () => {
    wlState.mk = c.dataset.mk;
    wlState.limit = WL_PAGE;
    document.querySelectorAll("#wlMarket .chip").forEach((x) => x.classList.toggle("active", x === c));
    fillSectorOptions();  // 市場を変えたら業種の選択肢と件数を作り直す
    renderWatch();
  };
});
el("wlSector").onchange = (e) => { wlState.sector = e.target.value; wlState.limit = WL_PAGE; renderWatch(); };
document.querySelectorAll("#wlTable th.sortable").forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.sort;
    if (wlState.sortKey === k) wlState.sortDir *= -1;
    else { wlState.sortKey = k; wlState.sortDir = k === "name" ? 1 : -1; }
    renderWatch();
  };
});
function miniRow(g) {
  return `<tr class="clickable" data-ticker="${g.ticker}">
    <td>${g.name}<span class="tk">${g.ticker}</span></td>
    <td>${pct(g.change_pct)}</td></tr>`;
}
const emptyRow = () => `<tr><td class="note">データなし</td></tr>`;

async function addTickers() {
  const raw = el("addTicker").value.trim();
  if (!raw) return toast("ティッカーを入れてください", true);
  const tickers = raw.split(/[\s,、]+/).filter(Boolean);
  el("btnAdd").disabled = true; el("btnAdd").textContent = "追加中…";
  try {
    const r = await post("/api/symbols/bulk", { tickers });
    toast(`${r.fetched_ok}/${r.added} 銘柄を追加しました` + (r.fail ? `（取得できず ${r.fail}）` : ""));
    el("addTicker").value = "";
    await loadMarket();
  } catch (e) { toast(e.message, true); }
  finally { el("btnAdd").disabled = false; el("btnAdd").textContent = "追加して取得"; }
}
el("btnAdd").onclick = addTickers;

let presetsLoaded = false;
async function loadPresets() {
  if (presetsLoaded) return;
  try {
    const d = await api("/api/presets");
    el("presetSelect").innerHTML = d.groups.map((g) => `<option value="${g}">${g}</option>`).join("");
    presetsLoaded = true;
  } catch (e) { /* noop */ }
}
el("btnPreset").onclick = async () => {
  const group = el("presetSelect").value;
  if (!group) return;
  el("btnPreset").disabled = true; el("btnPreset").textContent = "追加中…";
  try {
    const r = await post("/api/symbols/bulk", { group });
    toast(`「${group}」から ${r.fetched_ok}/${r.added} 銘柄を追加`);
    await loadMarket();
  } catch (e) { toast(e.message, true); }
  finally { el("btnPreset").disabled = false; el("btnPreset").textContent = "このテーマを追加"; }
};

// ---- 仮想投資 ----
async function loadTrade() {
  renderMarketStatus();
  const ps = await api("/api/portfolios");
  el("portfolios").innerHTML = ps.map((p) => portfolioCard(p)).join("");
  bindRowClicks();
  bindSellAll();
  const ts = await api("/api/trades");
  el("tradesBody").innerHTML = ts.map((t) => tradeRow(t)).join("") ||
    `<tr><td colspan="7" class="note">まだ取引はありません。</td></tr>`;
  bindTradeRowClicks();
  loadEquity();
}
// 取引履歴の行クリック → その銘柄のチャートを約定地点つきで開く
function bindTradeRowClicks() {
  document.querySelectorAll("#tradesBody tr.clickable").forEach((tr) => {
    tr.onclick = () => {
      const side = tr.dataset.tradeSide;
      openModal(tr.dataset.tradeTicker, {
        marker: {
          t: tr.dataset.tradeDate, price: Number(tr.dataset.tradePrice),
          label: (side === "buy" ? "買い" : "売り") + "約定",
          color: side === "buy" ? "#30d158" : "#ff5a5f",
        },
      });
    };
  });
}

// 市場が開いているか。各市場の現地時刻（タイムゾーン）で判定するので、
// 夏時間（サマータイム）や祝日ズレの影響を受けにくい。祝日休場は未対応。
function localWdHm(timeZone) {
  // その市場の現地での「曜日」と「0時からの分数」を返す
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  let h = parseInt(p.hour, 10);
  if (h === 24) h = 0; // 一部環境で 24:00 表記になるのを 0:00 に
  return { wd: wdMap[p.weekday], hm: h * 60 + parseInt(p.minute, 10) };
}
function renderMarketStatus() {
  const j = localWdHm("Asia/Tokyo");       // 日本の現地時刻
  const u = localWdHm("America/New_York");  // 米国東部の現地時刻（夏/冬を自動判定）
  const jWd = j.wd >= 1 && j.wd <= 5;
  const uWd = u.wd >= 1 && u.wd <= 5;
  // 東証: 9:00-11:30, 12:30-15:30（2024/11〜 後場30分延長）
  const jp = jWd && ((j.hm >= 540 && j.hm <= 690) || (j.hm >= 750 && j.hm <= 930));
  // 米国: 9:30-16:00（東部時間）
  const us = uWd && (u.hm >= 570 && u.hm <= 960);
  const dot = (open) => open
    ? '<span class="up">● 取引中</span>'
    : '<span class="flat">○ 閉場</span>';
  el("marketStatus").innerHTML =
    `日本市場 ${dot(jp)} ・ 米国市場 ${dot(us)}` +
    `<span class="note" style="margin-left:8px">— 値は実データの終値ベース。開いている時間に「更新」か自動更新で動きます（閉場中に動かないのは正常）。祝日は未判定。</span>`;
}
function portfolioCard(p) {
  const dec = p.currency === "JPY" ? 0 : 2;
  const pos = p.positions.map((x) => `<tr class="clickable" data-ticker="${x.ticker}">
      <td>${x.name}<span class="tk">${x.ticker}</span></td>
      <td>${num(x.quantity, 2)}</td>
      <td>${money(x.avg_cost, p.currency)}</td>
      <td>${money(x.last, p.currency)}</td>
      <td>${signed(x.pnl, dec)} (${pct(x.pnl_pct)})</td>
      <td style="text-align:center; white-space:nowrap">
        <button class="sm" title="チャート・指標・予測を見る">📈 チャート</button>
        <button class="sm danger" data-sellall="${x.ticker}" data-qty="${x.quantity}">全部売る</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="note">保有なし。注文か、銘柄詳細の「買う」で持てます。</td></tr>`;
  const hint = p.positions.length
    ? `<div class="note" style="margin-top:10px">行（または「📈 チャート」）をクリックすると、その銘柄のチャート・指標・売買・予測が開きます。</div>`
    : "";
  return `<div class="panel">
    <h2 style="margin-top:0">${p.name}</h2>
    <div class="kpi">
      <div class="item"><div class="label">総資産</div><div class="big">${money(p.total, p.currency)}</div></div>
      <div class="item"><div class="label">現金</div><div class="big">${money(p.cash, p.currency)}</div></div>
      <div class="item"><div class="label">評価損益</div><div class="big ${cls(p.unrealized_pnl)}">${money(p.unrealized_pnl, p.currency)}</div></div>
      <div class="item"><div class="label">実現損益</div><div class="big ${cls(p.realized_pnl)}">${money(p.realized_pnl, p.currency)}</div></div>
    </div>
    <div class="tbl-wrap"><table style="margin-top:12px">
      <thead><tr><th>銘柄</th><th>数量</th><th>平均取得</th><th>現在値</th><th>評価損益</th><th></th></tr></thead>
      <tbody>${pos}</tbody>
    </table></div>
    ${hint}
  </div>`;
}
function bindSellAll() {
  document.querySelectorAll("[data-sellall]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const t = b.dataset.sellall, q = Number(b.dataset.qty);
      if (!confirm(`${t} を ${q} 株すべて売却しますか？`)) return;
      await doTrade(t, "sell", q);
    };
  });
}
function tradeRow(t) {
  const sideJa = t.side === "buy" ? '<span class="up">買</span>' : '<span class="down">売</span>';
  const dec = t.currency === "JPY" ? 0 : 2;
  const r = t.side === "sell" ? signed(t.realized_pnl, dec) : "-";
  return `<tr class="clickable" data-trade-ticker="${t.ticker}" data-trade-date="${(t.traded_at || "").slice(0, 10)}" data-trade-price="${t.price}" data-trade-side="${t.side}" title="クリックでこの銘柄のチャート（約定地点つき）">
    <td style="text-align:left">${(t.traded_at || "").replace("T", " ")}</td>
    <td>${t.name || t.ticker}<span class="tk">${t.ticker}</span></td>
    <td>${sideJa}</td><td>${num(t.quantity, 2)}</td>
    <td>${money(t.price, t.currency)}</td>
    <td>${t.fee ? money(t.fee, t.currency) : "-"}</td><td>${r}</td>
  </tr>`;
}

// 資産推移グラフ
let equityChart = null;
async function loadEquity() {
  let d;
  try { d = await api("/api/equity"); } catch { return; }
  const names = { "1": "日本株口座", "2": "米国株口座" };
  const colors = { "1": "#4c8dff", "2": "#30d158" };
  const labelsSet = new Set();
  ["1", "2"].forEach((k) => (d[k] || []).forEach((p) => labelsSet.add(p.ts)));
  const labels = [...labelsSet].sort();
  const anyData = labels.length > 0;
  el("equityNote").style.display = anyData ? "none" : "block";
  const datasets = ["1", "2"].filter((k) => (d[k] || []).length).map((k) => {
    const base = d[k][0].total || 1;
    const map = Object.fromEntries(d[k].map((p) => [p.ts, (p.total / base - 1) * 100]));
    return { label: names[k] + "（開始比%）", data: labels.map((l) => (l in map ? map[l] : null)),
      borderColor: colors[k], backgroundColor: colors[k] + "22", spanGaps: true,
      pointRadius: 0, borderWidth: 1.6, tension: .15 };
  });
  const ctx = el("equityChart");
  if (equityChart) equityChart.destroy();
  equityChart = new Chart(ctx, {
    type: "line",
    data: { labels: labels.map((l) => l.slice(5, 16).replace("T", " ")), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 0, labels: { color: "#8a94a6", boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: "#8a94a6", maxTicksLimit: 6 }, grid: { color: "#272e3b55" } },
        y: { ticks: { color: "#8a94a6", callback: (v) => v + "%" }, grid: { color: "#272e3b55" } },
      },
    },
  });
}

el("btnTrade").onclick = () => doTrade(el("trTicker").value.trim(), el("trSide").value, Number(el("trQty").value));
async function doTrade(ticker, side, qty) {
  if (!ticker || !qty) return toast("銘柄と数量を入れてください", true);
  try {
    const r = await post("/api/trade", { ticker, side, quantity: qty });
    toast(`${ticker} を${side === "buy" ? "買い" : "売り"} ${qty} @ ${num(r.price, 2)}`);
    await loadTrade();
  } catch (e) { toast(e.message, true); }
}
// 注文前の概算金額を表示
async function updateEstimate() {
  const t = el("trTicker").value.trim(), q = Number(el("trQty").value);
  if (!t || !q) { el("trEstimate").textContent = ""; return; }
  try {
    const d = await api("/api/price/" + encodeURIComponent(t));
    const cur = d.symbol.currency || "USD";
    el("trEstimate").innerHTML = `概算 <b>${money(d.quote.close * q, cur)}</b>（@ ${money(d.quote.close, cur)}）`;
  } catch { el("trEstimate").textContent = ""; }
}
el("trTicker").onchange = updateEstimate;
el("trQty").oninput = updateEstimate;

// 保有銘柄だけ最新値を取り直す
el("btnRefreshHold").onclick = async () => {
  const b = el("btnRefreshHold");
  b.disabled = true; b.textContent = "取得中…";
  try {
    const r = await post("/api/refresh_holdings", {});
    if (!r.held) toast("保有銘柄がありません");
    else toast(`保有 ${r.held} 銘柄の最新値を取得（成功 ${r.success}・失敗 ${r.fail}）`);
    await loadTrade();
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = "保有の最新値を取得"; }
};

// ---- 最近見た銘柄 ----
let recentList = [];
try { recentList = JSON.parse(localStorage.getItem("invest_recent") || "[]"); } catch (e) { recentList = []; }
function recordRecent(ticker, name) {
  if (!ticker) return;
  recentList = recentList.filter((r) => r.t !== ticker);
  recentList.unshift({ t: ticker, n: name || ticker });
  recentList = recentList.slice(0, 10);
  try { localStorage.setItem("invest_recent", JSON.stringify(recentList)); } catch (e) {}
  renderRecent();
}
function renderRecent() {
  const box = el("aiRecent");
  if (!box) return;
  if (!recentList.length) { box.innerHTML = '<span class="lbl">最近見た銘柄はまだありません（銘柄を分析/表示すると、ここにたまります）</span>'; return; }
  box.innerHTML = '<span class="lbl">最近見た:</span>' + recentList.map((r) =>
    `<button class="rchip" data-recent="${r.t}">${r.n}<span class="tk">${r.t}</span></button>`).join("");
  box.querySelectorAll("[data-recent]").forEach((b) => {
    b.onclick = () => { el("aiTicker").value = b.dataset.recent; analyze(b.dataset.recent); };
  });
}

// ---- AI分析・予測 ----
el("btnAnalyze").onclick = () => analyze(el("aiTicker").value.trim());
async function analyze(ticker) {
  if (!ticker) return toast("銘柄を入れてください", true);
  recordRecent(ticker, (watchData.find((w) => w.ticker === ticker) || {}).name);
  try {
    const ind = await api("/api/indicators/" + encodeURIComponent(ticker));
    el("aiResult").innerHTML = indicatorBlock(ind, ticker) +
      `<div id="mlArea" class="note" style="margin-top:10px">AIモデル予測を確認中…</div>`;
    el("openDetail").onclick = () => openModal(ticker);
    // 機械学習モデルの予測（未学習なら案内を出す）
    const horizon = Number(el("mlHorizon").value) || 5;
    try {
      const m = await api(`/api/ml/predict/${encodeURIComponent(ticker)}?horizon=${horizon}`);
      const dirJa = { up: "上がる", down: "下がる" }[m.direction];
      el("mlArea").innerHTML =
        `<span class="badge ${m.direction}">AIモデル: ${dirJa}</span>
         <span style="margin-left:8px">${horizon}営業日先の上昇確率 <b>${m.prob_up.toFixed(0)}%</b></span>
         <button id="recML" class="ghost" style="margin-left:10px">このモデル予測を記録</button>`;
      el("recML").onclick = async () => {
        try {
          await post("/api/predict", { ticker, direction: m.direction, horizon_days: horizon,
            probability: m.probability, source: "ML" });
          toast("モデル予測を記録しました（ML）");
          loadPredictions();
        } catch (e) { toast(e.message, true); }
      };
    } catch (e) {
      el("mlArea").innerHTML = `<span class="note">AIモデル未学習です。上の「モデルを学習」を押してください。</span>`;
    }
  } catch (e) { el("aiResult").innerHTML = `<div class="warn">${e.message}</div>`; }
}

// ---- 機械学習モデル ----
el("btnTrainML").onclick = async () => {
  const b = el("btnTrainML");
  b.disabled = true; b.textContent = "学習中…";
  try {
    const m = await post("/api/ml/train", { horizon: Number(el("mlHorizon").value) || 5 });
    renderMLMetrics(m);
    toast("モデルを学習しました");
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = "モデルを学習"; }
};
el("mlHorizon").onchange = loadMLMetrics;
function renderMLMetrics(m) {
  if (!m || !m.n) { el("mlMetrics").textContent = "まだ学習していません。"; return; }
  const acc = (m.test_accuracy * 100).toFixed(1);
  const base = (m.baseline * 100).toFixed(1);
  const win = m.test_accuracy > m.baseline;
  el("mlMetrics").innerHTML =
    `学習データ <b>${m.n.toLocaleString()}</b> 件 ／ 検証accuracy <b class="${win ? "up" : "down"}">${acc}%</b>
     （当て勘ベースライン ${base}%）<br>
     よく効いた特徴: ${m.top_features.map((f) => f.name).join(", ")}
     <div class="${win ? "up" : "warn"}" style="margin-top:4px">
     ${win ? "ベースラインを少し上回っています（それでも参考程度に）。" : "ベースライン以下。この期間・特徴では予測力はほぼありません。"}</div>`;
}
async function loadMLMetrics() {
  try {
    const m = await api("/api/ml/metrics?horizon=" + (Number(el("mlHorizon").value) || 5));
    renderMLMetrics(m);
  } catch { /* 未学習 */ }
}
function indicatorBlock(ind, ticker) {
  const dirJa = { up: "上がりそう", down: "下がりそう", neutral: "どちらとも" }[ind.direction];
  return `<div class="row">
    <div class="panel" style="min-width:260px">
      <div class="badge ${ind.direction}">${dirJa}</div>
      <span style="margin-left:8px">参考確率 <b>${ind.probability.toFixed(0)}%</b>（スコア ${ind.score >= 0 ? "+" : ""}${ind.score}）</span>
      <ul class="reasons" style="margin:10px 0 0">${(ind.reasons || []).map((r) => `<li>${r}</li>`).join("")}</ul>
      <div class="warn" style="margin-top:8px">※ 断定ではなく参考です。必ず自分の予測として記録し、後で答え合わせしましょう。</div>
      <button id="openDetail" style="margin-top:10px">チャート・売買・予測を開く</button>
    </div>
    <div class="panel" style="min-width:220px">
      <table>
        <tr><th>終値</th><td>${num(ind.close, 2)}</td></tr>
        <tr><th>5日線</th><td>${num(ind.sma5, 2)}</td></tr>
        <tr><th>25日線</th><td>${num(ind.sma25, 2)}</td></tr>
        <tr><th>75日線</th><td>${num(ind.sma75, 2)}</td></tr>
        <tr><th>RSI</th><td>${num(ind.rsi, 1)}</td></tr>
        <tr><th>MACD</th><td>${num(ind.macd, 3)}</td></tr>
      </table>
    </div>
  </div>`;
}
async function loadPredictions() {
  const d = await api("/api/predictions");
  const a = d.accuracy;
  el("accuracy").innerHTML = ["自分", "AI", "ML", "全体"].map((k) => {
    const x = a[k];
    const rate = x.rate == null ? "-" : x.rate.toFixed(0) + "%";
    return `<div class="item"><div class="label">${k}</div><div class="big">${rate}</div>
      <div class="note">${x.hit}/${x.n} 的中</div></div>`;
  }).join("");
  const bet = betAmount();
  el("predBody").innerHTML = d.items.map((p) => predRow(p, bet)).join("") ||
    `<tr><td colspan="10" class="note">まだ予測はありません。</td></tr>`;
  document.querySelectorAll("[data-delpred]").forEach((b) => {
    b.onclick = async () => {
      try { await post("/api/predictions/delete", { id: Number(b.dataset.delpred) }); loadPredictions(); }
      catch (e) { toast(e.message, true); }
    };
  });
}
// 想定額（円）。ブラウザに記憶。
function betAmount() {
  const v = Number(el("betAmt") && el("betAmt").value);
  return isNaN(v) || v < 0 ? 0 : v;
}
// 予測どおりに賭けていた場合の損益（下げ予測は下落で利益＝符号を反転）
function predPL(p, bet) {
  let pctMove = null;
  if (p.resolved && p.actual_price != null && p.base_price) pctMove = (p.actual_price - p.base_price) / p.base_price * 100;
  else if (p.cur_pct != null) pctMove = p.cur_pct;
  if (pctMove == null || !bet) return "-";
  const signed = pctMove * (p.direction === "up" ? 1 : -1);  // 予測どおりなら+
  const yen = Math.round(bet * signed / 100);
  const cls = yen > 0 ? "up" : yen < 0 ? "down" : "";
  const s = yen > 0 ? "+" : "";
  const live = p.resolved ? "" : '<span class="note">（途中）</span>';
  return `<span class="pl-amt ${cls}">${s}${yen.toLocaleString()}円</span>${live}`;
}
function predRow(p, bet) {
  const dir = p.direction === "up" ? '<span class="up">上</span>' : '<span class="down">下</span>';
  let result = '<span class="note">判定待ち</span>', hit = "-";
  if (p.resolved) {
    const ad = { up: "上", down: "下", flat: "変わらず" }[p.actual_dir] || "-";
    result = `${ad} (${num(p.actual_price, 2)})`;
    hit = p.correct ? '<span class="up">○</span>' : '<span class="down">×</span>';
  } else if (p.cur_pct != null) {
    // 判定待ち：現時点で基準比±何%か（答え合わせ前の途中経過）
    const s = p.cur_pct > 0 ? "+" : "";
    const cc = p.cur_pct > 0 ? "up" : p.cur_pct < 0 ? "down" : "";
    const dl = p.days_left != null ? `あと約${p.days_left}日` : "";
    const track = p.cur_dir === "flat" ? ""
      : p.on_track ? ' <span class="up">予測どおり</span>' : ' <span class="down">逆行中</span>';
    result = `<span class="note">判定待ち</span> `
      + `<b class="${cc}">現時点 ${s}${p.cur_pct}%</b>`
      + `<span class="note"> (${num(p.cur_price, 2)}${dl ? " · " + dl : ""})</span>${track}`;
    hit = "<span class=\"note\">…</span>";
  }
  return `<tr>
    <td style="text-align:left">${p.made_on}</td>
    <td>${p.name || p.ticker}<span class="tk">${p.ticker}</span></td>
    <td>${dir}</td>
    <td>${p.probability == null ? "-" : p.probability.toFixed(0) + "%"}</td>
    <td>${p.source}</td>
    <td>${num(p.base_price, 2)}</td>
    <td>${predPL(p, bet)}</td>
    <td>${result}</td><td>${hit}</td>
    <td style="text-align:center"><button class="rm" data-delpred="${p.id}" title="削除">×</button></td>
  </tr>`;
}
// 想定額の入力：変更したら記憶して表を引き直す
(function setupBet() {
  const inp = el("betAmt");
  if (!inp) return;
  try { const v = localStorage.getItem("invest_bet"); if (v) inp.value = v; } catch {}
  inp.oninput = () => {
    try { localStorage.setItem("invest_bet", inp.value); } catch {}
    if (currentTab === "ai") loadPredictions();
  };
})();
el("btnResolve").onclick = async () => {
  try { const r = await post("/api/predict/resolve"); toast(`${r.resolved} 件を答え合わせしました`); await loadPredictions(); }
  catch (e) { toast(e.message, true); }
};

// ---- モーダル（銘柄詳細） ----
let chart = null, modalTicker = null, modalCurrency = "USD", modalMarker = null, modalRange = "6mo";
let modalNews = [], newsMeta = {};
function fmtCur(v) { return money(v, modalCurrency); }
function sentColor(s) { return ({ pos: "#30d158", neg: "#ff5a5f", neu: "#8a94a6" })[s] || "#8a94a6"; }
function sentJa(s) { return ({ pos: "ポジ", neg: "ネガ", neu: "中立" })[s] || "中立"; }
// 最小二乗法で傾き（1ステップあたりの変化量）を出す
function slopeOf(ys) {
  const n = ys.length; if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const den = n * sxx - sx * sx;
  return den ? (n * sxy - sx * sy) / den : 0;
}
function renderNewsList(items) {
  if (!items || !items.length) return '<div class="note">ニュースは取得できませんでした。</div>';
  // 日時(MM/DD HH:MM)を先頭に出す。新しい順で並ぶ。
  const short = (ts) => (ts ? ts.slice(5, 16).replace("-", "/") : "日付不明");
  return `<h2 style="margin:0 0 6px">関連ニュース <span class="note">（新しい順・チャートの△印と同じ・簡易センチメント）</span></h2>`
    + items.map((it) =>
      `<div style="margin-bottom:7px; display:flex; gap:7px; align-items:baseline">
        <span class="note" style="white-space:nowrap; min-width:76px">${short(it.ts)}</span>
        ${sentBadge(it.sentiment)}
        <span>${it.link ? `<a href="${it.link}" target="_blank" rel="noopener" style="color:var(--accent)">${it.title}</a>` : it.title}`
      + `${it.publisher ? ` <span class="note">・ ${it.publisher}</span>` : ""}</span>
      </div>`).join("");
}

// 約定日の古さから、最初に出す期間を選ぶ
function rangeForAge(t) {
  const age = (Date.now() - new Date(t).getTime()) / 86400000;
  return age <= 25 ? "1mo" : age <= 80 ? "3mo" : age <= 160 ? "6mo" : age <= 330 ? "1y" : "max";
}

async function openModal(ticker, opts = {}) {
  modalTicker = ticker;
  modalMarker = opts.marker || null;
  modalRange = opts.range || (modalMarker ? rangeForAge(modalMarker.t) : rangeForMode());
  document.querySelectorAll("#mRanges button").forEach((x) =>
    x.classList.toggle("active", x.dataset.range === modalRange));
  if (el("mHorizon")) el("mHorizon").value = horizonForMode();  // 予測の既定日数も目的に合わせる
  try {
    const d = await api("/api/price/" + encodeURIComponent(ticker));
    modalCurrency = d.symbol.currency || "USD";
    recordRecent(ticker, d.symbol.name);
    el("mTitle").textContent = `${d.symbol.name || ticker}`;
    el("mSub").textContent = `${ticker} ・ ${money(d.quote.close, d.symbol.currency)} ・ ${d.quote.date}`;
    // この銘柄/指数が何かのやさしい説明
    if (el("mAbout")) {
      const about = (typeof aboutText === "function") ? aboutText(d.symbol) : "";
      el("mAbout").innerHTML = about ? `<span class="about-ic">ℹ</span><span>${about}</span>` : "";
      el("mAbout").style.display = about ? "" : "none";
    }
    el("modalBg").classList.add("show"); // 先に表示してからチャートを描く（0x0対策）
    if (el("mWhy")) el("mWhy").innerHTML = ""; // 前の銘柄の見立てを残さない
    if (el("mSeason")) el("mSeason").innerHTML = "";
    // 関連ニュースを先に取得（チャートに△印を打つため）
    modalNews = [];
    el("mNews").innerHTML = '<div class="note">ニュースを取得中…</div>';
    try {
      const nw = await api("/api/news/" + encodeURIComponent(ticker));
      modalNews = nw.items || [];
      el("mNews").innerHTML = renderNewsList(modalNews);
    } catch { modalNews = []; el("mNews").innerHTML = ""; }
    loadChart(ticker, modalRange, modalMarker);  // ニュース印＋予測線つきで描画
    try {
      const ind = await api("/api/indicators/" + encodeURIComponent(ticker));
      el("mIndicators").innerHTML = indicatorBlockLite(ind);
      el("mDir").value = ind.direction === "down" ? "down" : "up";
      el("mPredictAI").dataset.prob = ind.probability;
    } catch { el("mIndicators").innerHTML = '<div class="note">指標はデータ不足で計算できません。</div>'; }
    // なぜ動いた？（AIの見立て）— 値動きの要因分解＋候補ニュース＋免責
    if (el("mWhy")) { try { el("mWhy").innerHTML = renderWhy(d, modalNews); } catch (e) { el("mWhy").innerHTML = ""; } }
    // 関係性（相対強弱・連動銘柄）
    el("mRelations").innerHTML = '<div class="note">関係性を計算中…</div>';
    try {
      const rel = await api("/api/relations/" + encodeURIComponent(ticker));
      el("mRelations").innerHTML = renderRelations(rel);
      document.querySelectorAll("#mRelations .rchip").forEach((b) => {
        b.onclick = () => openModal(b.dataset.ticker);
      });
    } catch { el("mRelations").innerHTML = ""; }
    // 曜日・季節のクセ（過去の統計）
    if (el("mSeason")) {
      el("mSeason").innerHTML = '<div class="note">曜日・季節の統計を計算中…</div>';
      try {
        const se = await api("/api/seasonality/" + encodeURIComponent(ticker));
        el("mSeason").innerHTML = renderSeason(se);
      } catch { el("mSeason").innerHTML = ""; }
    }
  } catch (e) { toast(e.message, true); }
}
// 相対強弱＋連動銘柄の表示
function relDiffBadge(d) {
  if (d == null) return "";
  const s = d >= 0 ? "up" : "down";
  const w = d >= 0 ? "強い" : "弱い";
  return `<span class="badge ${s}">${d >= 0 ? "+" : ""}${d}pt ${w}</span>`;
}
function renderRelations(r) {
  if (!r || !r.ok) {
    return `<div class="panel" style="margin:0"><h2 style="margin-top:0">関係性</h2>
      <div class="note">${(r && r.reason) || "データ不足で計算できません。"}</div></div>`;
  }
  const rel = r.relative, own = rel.ticker_ret;
  const row = (label, obj) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border)">
      <span class="note">${label}</span>
      <span>${obj.ret == null ? "-" : pct(obj.ret)} &nbsp;${relDiffBadge(obj.diff)}</span></div>`;
  const chip = (x) => `<button class="rchip" data-ticker="${x.ticker}">${x.name}<span class="tk">${x.ticker}</span> <b class="${x.corr >= 0 ? "up" : "down"}">${x.corr >= 0 ? "+" : ""}${x.corr}</b></button>`;
  const pos = (r.pos || []).filter((x) => x.corr > 0).map(chip).join("") || '<span class="note">該当なし（更新で履歴を増やすと出ます）</span>';
  const neg = (r.neg || []).filter((x) => x.corr < 0).map(chip).join("") || '<span class="note">該当なし</span>';
  return `<div class="panel" style="margin:0">
    <h2 style="margin-top:0">関係性 <span class="note">直近${rel.days}営業日・実データ</span></h2>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b>自分 ${own == null ? "-" : pct(own)}</b>
      <span class="note">指数・同業種と比べた強さ</span></div>
    ${row(`指数比（${rel.index.name}）`, rel.index)}
    ${row(`同業種比（${rel.sector.name || "-"}・${rel.sector.n}銘柄）`, rel.sector)}
    <div class="note" style="margin-top:6px">プラス＝市場/同業種より強い、マイナス＝弱い（相対評価）。上げても指数に負けていれば弱い。</div>
    <div style="margin-top:12px"><div class="note" style="margin-bottom:5px">よく一緒に動く銘柄（相関プラス＝連動・補完材）</div>
      <div class="recent" style="margin-top:0">${pos}</div></div>
    <div style="margin-top:12px"><div class="note" style="margin-bottom:5px">逆に動きやすい銘柄（相関マイナス＝代替・ヘッジ的）</div>
      <div class="recent" style="margin-top:0">${neg}</div></div>
  </div>`;
}
function sentBadge(s) {
  const m = { pos: ["up", "ポジ"], neg: ["down", "ネガ"], neu: ["neutral", "中立"] }[s] || ["neutral", "中立"];
  return `<span class="badge ${m[0]}">${m[1]}</span>`;
}
// 曜日・季節のクセ（過去の統計）。※ 過去の集計であって未来の保証ではない・助言ではない。
function renderSeason(s) {
  if (!s || !s.ok) {
    return `<div class="panel" style="margin:0"><h2 style="margin-top:0">曜日・季節のクセ</h2>
      <div class="note">${(s && s.reason) || "データ不足で計算できません。"}</div></div>`;
  }
  const wd = s.weekday || [];
  const maxAbs = Math.max(0.01, ...wd.map((x) => Math.abs(x.mean)));
  const bar = (x) => {
    const w = Math.round(Math.abs(x.mean) / maxAbs * 100);
    const cls = x.mean >= 0 ? "up" : "down";
    return `<div class="se-row">
      <span class="se-wd">${x.name}</span>
      <span class="se-bar"><span class="se-fill ${cls}" style="width:${w}%"></span></span>
      <span class="se-val ${cls}">${x.mean >= 0 ? "+" : ""}${x.mean.toFixed(2)}%</span>
      <span class="se-sub note">勝率${x.win}% ・ ${x.n}日</span>
    </div>`;
  };
  const mo = s.month || [];
  const mmax = Math.max(0.01, ...mo.map((x) => Math.abs(x.mean)));
  const cell = (x) => {
    const inten = Math.min(1, Math.abs(x.mean) / mmax);
    const col = x.mean >= 0 ? `rgba(48,209,88,${(0.14 + inten * 0.6).toFixed(2)})`
      : `rgba(255,90,95,${(0.14 + inten * 0.6).toFixed(2)})`;
    return `<span class="se-cell" style="background:${col}"
      title="${x.name} 平均${x.mean >= 0 ? "+" : ""}${x.mean.toFixed(2)}% ・ 勝率${x.win}% ・ ${x.n}日">${x.m}</span>`;
  };
  const thinNote = s.years < 2
    ? `この銘柄は約${s.years}年ぶんしかなく、`
    : `サンプルが少ないほど`;
  return `<div class="panel" style="margin:0">
    <h2 style="margin-top:0">曜日・季節のクセ <span class="note">過去${s.years}年（${s.from}〜${s.to}・${s.n_days}日）の実データ</span></h2>
    <div class="note" style="margin-bottom:7px">1日の値動き（前営業日比）を曜日ごとに平均。月曜は週末をはさむ値動きを含みます。</div>
    ${wd.map(bar).join("")}
    <div class="note" style="margin-top:8px">この期間では <b>${s.best_wd}曜</b>が平均プラス方向、<b>${s.worst_wd}曜</b>が平均マイナス方向に出ています（この銘柄の・この期間だけの話）。</div>
    ${mo.length ? `<div style="margin-top:12px"><div class="note" style="margin-bottom:5px">月別の平均（緑=プラス／赤=マイナス・濃いほど大きい／ホバーで数値）</div>
      <div class="se-strip">${mo.map(cell).join("")}</div></div>` : ""}
    <div class="se-edu">
      <div style="margin-bottom:4px"><b>一般に“こう言われる”暦のクセ（教養・諸説あり）</b></div>
      ・<b>月曜効果</b>：週末をはさむ月曜は軟調になりやすい、と昔から言われる（近年は薄れたとも）。<br>
      ・<b>1月効果</b>：年末〜1月に小型株などが買われやすいとされる。<br>
      ・<b>Sell in May（セル・イン・メイ）</b>：5〜10月は相対的に弱く、11〜4月が強いとされる相場格言。<br>
      ・<b>連休・週末前</b>：手じまいでボラティリティ（荒れ具合）が変わりやすい。
    </div>
    <div class="why-disc"><b>⚠ 鵜呑みにしないでください。</b> これは<b>過去の集計</b>で、未来を保証しません。とくに<b>${thinNote}偶然のブレ</b>が大きく出ます。「クセがあるかも」程度に、過去の事実として眺める用です（売買の助言ではありません）。</div>
  </div>`;
}
// ===== 「なぜ動いた？」= 値動きの要因分解（AIの見立て） =====
// 実データ（きょうの騰落・対応指数・同業種平均）とニュースから機械的に組み立てる。
// ※ 相関であって因果の証明ではない。原因は断定しない。必ず免責を付ける。
function moveParts(d) {
  const q = d.quote || {}, sym = d.symbol || {};
  const chg = q.change_pct;
  if (chg == null) return null;
  const isIdx = !!(sym.ticker && sym.ticker.startsWith("^"));
  const p = { chg, isIdx, idx: null, idxName: null, sec: null, secName: sym.sector || null, secN: 0 };
  const lm = lastMarket;
  if (lm && !isIdx) {
    const benchT = sym.currency === "JPY" ? "^N225" : "^GSPC";
    const benchN = sym.currency === "JPY" ? "日経平均" : "S&P 500";
    if (lm.indices) {
      const ix = lm.indices.find((x) => x.ticker === benchT);
      if (ix && ix.change_pct != null) { p.idx = ix.change_pct; p.idxName = benchN; }
    }
    if (sym.sector && lm.watch) {
      const same = lm.watch.filter((x) => x.sector === sym.sector && x.change_pct != null && x.ticker !== sym.ticker);
      if (same.length >= 3) { p.sec = same.reduce((a, x) => a + x.change_pct, 0) / same.length; p.secN = same.length; }
    }
  }
  return p;
}
const _pctB = (v) => `<b class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</b>`;
function renderWhy(d, news) {
  const p = moveParts(d);
  if (!p) return "";
  const dir = p.chg > 0 ? "上げ" : p.chg < 0 ? "下げ" : "横ばい";
  if (p.isIdx) {
    return whyWrap(`この指数はきょう ${_pctB(p.chg)}。指数そのものなので、これは「市場全体の${dir}」そのものを表しています。個別銘柄ごとの要因分解は、各銘柄のページで見られます。`, news, false);
  }
  const lines = [`きょうのこの銘柄は ${_pctB(p.chg)}。`];
  const hasIdx = p.idx != null;
  const resid = hasIdx ? p.chg - p.idx : null;   // 指数で説明できない“固有ぶん”
  if (hasIdx) lines.push(`同じ日、${p.idxName}は ${_pctB(p.idx)}。`);
  if (p.sec != null) lines.push(`同業種（${p.secName}・${p.secN}銘柄）の平均は ${_pctB(p.sec)}。`);
  const a = Math.abs;
  let verdict, showNews = false;
  if (!hasIdx) {
    verdict = `→ きょうの地合い（指数）データが未取得のため、要因は分解できません。マーケットタブで「更新」すると出ます。`;
  } else if (a(resid) < 1.2 && a(p.idx) >= 0.8) {
    verdict = `→ きょうの${dir}の大半は<b>市場全体の地合い</b>で説明できます（指数もほぼ同じだけ動いている）。この銘柄だけの特別な材料は、数字の上では目立ちません。`;
  } else if (p.sec != null && resid < -1.2 && (p.chg - p.sec) > -1.2) {
    verdict = `→ 指数より大きく下げていますが、<b>同業種もまとめて弱い</b>ので、主因は<b>業種（セクター）全体</b>の可能性が高いです。`;
  } else if (p.sec != null && resid > 1.2 && (p.chg - p.sec) < 1.2) {
    verdict = `→ 指数より強いですが、<b>同業種もまとめて強い</b>ので、主因は<b>業種（セクター）全体</b>の可能性が高いです。`;
  } else if (resid < -1.5) {
    const sec = p.sec != null ? "・同業種" : "";
    const head = p.chg > 0
      ? `上げてはいますが指数${sec}より弱く、<b>出遅れ</b>ています。`
      : `指数${sec}より<b>大きく下げています</b>。`;
    verdict = `→ ${head}この銘柄<b>固有の弱さ</b>（決算・個別の悪材料など）が効いている可能性があります。下の「候補ニュース」を確認してください。`;
    showNews = true;  // 固有の弱さのときだけ、悪材料の候補を探す意味がある
  } else if (resid > 1.5) {
    const sec = p.sec != null ? "・同業種" : "";
    const head = p.chg < 0
      ? `下げてはいますが指数${sec}ほど下げておらず、<b>相対的に底堅い</b>です。`
      : `指数${sec}より<b>強く、逆行高</b>です。`;
    verdict = `→ ${head}この銘柄<b>固有の強さ</b>（個別の好材料など）がある可能性があります。`;
  } else {
    verdict = `→ 市場の地合いと、この銘柄固有の動きが<b>混在</b>しています。はっきり一つの理由には絞り切れません。`;
  }
  lines.push(verdict);
  return whyWrap(lines.join(" "), news, showNews);
}
function whyWrap(bodyHtml, news, showNews) {
  const short = (ts) => (ts ? ts.slice(5, 16).replace("-", "/") : "");
  let newsHtml = "";
  if (showNews) {
    const negs = (news || []).filter((n) => n.sentiment === "neg").slice(0, 3);
    if (negs.length) {
      newsHtml = `<div class="why-news"><div class="note">この銘柄のニュース欄にある直近の悪材料候補（内容が無関係に見えることもあります・因果は未確認）</div>
        ${negs.map((n) => `<div class="why-n">・${n.link ? `<a href="${n.link}" target="_blank" rel="noopener">${(n.title || "").slice(0, 64)}</a>` : (n.title || "").slice(0, 64)} <span class="note">${short(n.ts)}</span></div>`).join("")}</div>`;
    } else {
      newsHtml = `<div class="why-news"><div class="note">この銘柄のニュース欄に、はっきりした悪材料は見当たりません（無料ニュースは直近数日が中心なので、見落としの可能性はあります）。</div></div>`;
    }
  }
  const disc = `<div class="why-disc"><b>⚠ 鵜呑みにしないでください。</b> これは実データとニュースから機械的に組み立てた<b>AIの見立て</b>で、相関であって<b>因果の証明ではありません</b>。ここを出発点に、ご自身で精査してください。</div>`;
  return `<div class="why-head">なぜ動いた？ <span class="why-tag">AIの見立て</span></div>
    <div class="why-body">${bodyHtml}</div>${newsHtml}${disc}`;
}
function indicatorBlockLite(ind) {
  const dirJa = { up: "上がりそう", down: "下がりそう", neutral: "どちらとも" }[ind.direction];
  return `<span class="badge ${ind.direction}">${dirJa}</span>
    <span style="margin-left:8px">参考確率 <b>${ind.probability.toFixed(0)}%</b></span>
    <span class="note" style="margin-left:10px">RSI ${num(ind.rsi, 1)} ・ 25日線 ${num(ind.sma25, 2)}</span>
    ${deviationLine(ind)}`;
}
// 25日線からの乖離（＝「行き過ぎ」度）。平均回帰の練習の目安。
// ※ 事実としての位置を示すだけで、上がる/下がるの断定はしない。
function deviationLine(ind) {
  if (ind.close == null || !ind.sma25) return "";
  const dev = (ind.close - ind.sma25) / ind.sma25 * 100;
  const a = Math.abs(dev);
  const s = dev >= 0 ? "+" : "";
  const cls = dev >= 0 ? "up" : "down";
  const side = dev >= 0 ? "上" : "下";
  let gloss;
  if (a < 3) gloss = "ほぼ平均どおり（行き過ぎは小さい）";
  else if (a < 8) gloss = `平均より${side}にやや離れている`;
  else gloss = `平均より${side}に大きく離れている — <b>行き過ぎの目安</b>。離れたぶん平均へ戻る動き（平均回帰）が起きやすいとされる水準`;
  // RSI も添える（70超＝買われすぎ / 30未満＝売られすぎ の一般的な目安）
  let rsiTag = "";
  if (ind.rsi != null) {
    if (ind.rsi >= 70) rsiTag = ' <span class="badge up">買われすぎ(RSI≥70)</span>';
    else if (ind.rsi <= 30) rsiTag = ' <span class="badge down">売られすぎ(RSI≤30)</span>';
  }
  return `<div class="dev-line" style="margin-top:8px">
      25日線からの乖離 <b class="${cls}">${s}${dev.toFixed(1)}%</b>${rsiTag}
      <div class="note" style="margin-top:3px">${gloss}。</div>
    </div>`;
}
// この銘柄に対応する「市場の代表指数」（連動を見るための基準）
function benchmarkFor(ticker) {
  if (ticker && ticker.startsWith("^")) return null;          // 指数自身には重ねない
  if (modalCurrency === "JPY") return { ticker: "^N225", name: "日経平均" };
  return { ticker: "^GSPC", name: "S&P 500" };
}
// 指定期間のチャートを取得して描く
async function loadChart(ticker, range, marker) {
  if (chart) { try { chart.destroy(); } catch (e) {} chart = null; }
  const ctx = el("mChart");
  ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
  try {
    const d = await api(`/api/chart/${encodeURIComponent(ticker)}?range=${range}`);
    if (!d.series || !d.series.length) { toast("この期間のデータが取得できませんでした", true); return; }
    // 指数の重ね描き（連動しているかを見る）
    let overlay = null;
    const bench = benchmarkFor(ticker);
    const wrap = el("mOverlayRow"); const chk = el("mOverlay");
    if (wrap) wrap.style.display = bench ? "" : "none";
    if (el("mOverlayWrap")) el("mOverlayWrap").classList.toggle("on", !!(chk && chk.checked));
    if (bench && el("mOverlayLabel")) el("mOverlayLabel").textContent = `${bench.name}を重ねる`;
    if (bench && chk && chk.checked) {
      try {
        const di = await api(`/api/chart/${encodeURIComponent(bench.ticker)}?range=${range}`);
        if (di.series && di.series.length) overlay = { name: bench.name, series: di.series };
      } catch (e) { /* 指数が取れなくても本体は描く */ }
    }
    drawChart(d.series, { marker, news: modalNews, projection: true, overlay });
  } catch (e) { toast(e.message, true); }
}

// ホバー時に縦のガイド線を引く
const vLinePlugin = {
  id: "vline",
  afterDraw(c) {
    const act = c.tooltip && c.tooltip._active;
    if (act && act.length) {
      const x = act[0].element.x;
      const { top, bottom } = c.chartArea;
      const g = c.ctx;
      g.save(); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom);
      g.lineWidth = 1; g.strokeStyle = "#8a94a688"; g.stroke(); g.restore();
    }
  },
};

let lastChartArgs = null;
function redrawCurrentChart() {
  if (lastChartArgs && document.getElementById("mChart")) {
    drawChart(lastChartArgs.series, lastChartArgs.opts);
  }
}
function drawChart(series, opts = {}) {
  lastChartArgs = { series, opts };
  const ctx = el("mChart");
  if (chart) chart.destroy();
  // テーマの色を読み取る（ライト/ダークで目盛り・グリッドを合わせる）
  const _cs = getComputedStyle(document.documentElement);
  const cMuted = _cs.getPropertyValue("--muted").trim() || "#8a94a6";
  const cGrid = (_cs.getPropertyValue("--border").trim() || "#272e3b") + "66";
  const cLine = _cs.getPropertyValue("--accent").trim() || "#4c8dff";
  newsMeta = {};
  const labels = series.map((s) => s.t);
  const closes = series.map((s) => s.close);
  const baseLen = labels.length;
  const allLabels = labels.slice();
  const pad = (arr) => arr.concat(new Array(allLabels.length - arr.length).fill(null));

  // 日付（date）に最も近い点のインデックスにスナップする
  const snap = (dateStr) => {
    let i = labels.indexOf(dateStr);
    if (i < 0) for (let j = 0; j < baseLen; j++) if (labels[j].slice(0, 10) <= dateStr) i = j;
    return i;
  };
  // ニュースを置く位置。分足表示なら「時刻」で最も近い点、日足なら「日付」で合わせる
  const intradayAxis = baseLen > 0 && labels[0].length > 10;
  const toMs = (s) => Date.parse(s.replace(" ", "T"));
  const snapNews = (nw) => {
    if (intradayAxis && nw.ts) {
      const t = toMs(nw.ts);
      let best = -1, bestD = Infinity;
      for (let j = 0; j < baseLen; j++) {
        const dd = Math.abs(toMs(labels[j]) - t);
        if (dd < bestD) { bestD = dd; best = j; }
      }
      return bestD <= 2 * 86400000 ? best : -1;  // 2日以上離れた点には付けない
    }
    return nw.date ? snap(nw.date) : -1;
  };

  // 予測の点線（直近の傾きを右へ延長）— 先に未来ラベルを足す
  let projDataset = null;
  if (opts.projection && closes.length >= 3) {
    const win = Math.min(20, closes.length);
    const m = slopeOf(closes.slice(-win));         // 直近の傾き
    const anchor = closes[closes.length - 1];
    const K = Math.max(5, Math.round(baseLen * 0.18));
    for (let k = 0; k < K; k++) allLabels.push("");  // 未来は空ラベル
    const projData = new Array(baseLen + K).fill(null);
    projData[baseLen - 1] = anchor;                 // 現在値から始める
    for (let k = 1; k <= K; k++) projData[baseLen - 1 + k] = anchor + m * k;
    projDataset = {
      label: m < 0 ? "この傾きが続くと（下げ）" : "この傾きが続くと（上げ）",
      data: projData, borderColor: m < 0 ? "#ff5a5f" : "#30d158",
      borderDash: [6, 4], borderWidth: 1.6, pointRadius: 0, fill: false, spanGaps: false, tension: 0,
    };
  }

  const datasets = [{
    label: "終値", data: pad(closes.slice()),
    borderColor: cLine, backgroundColor: cLine + "22",
    fill: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 1.6, tension: .12,
  }];

  // ニュースの△印（配信された位置に、センチメント色で）
  if (opts.news && opts.news.length) {
    const data = new Array(allLabels.length).fill(null);
    opts.news.forEach((nw) => {
      const i = snapNews(nw);
      if (i < 0) return;
      data[i] = closes[i];
      (newsMeta[i] = newsMeta[i] || []).push(nw);
    });
    const idxs = Object.keys(newsMeta).map(Number);
    if (idxs.length) {
      // 同じ点に複数あるときは「ネガがあれば赤・ポジがあれば緑・それ以外は灰」
      const colors = new Array(allLabels.length).fill("#8a94a6");
      idxs.forEach((i) => {
        const ms = newsMeta[i];
        colors[i] = ms.some((m) => m.sentiment === "neg") ? "#ff5a5f"
          : ms.some((m) => m.sentiment === "pos") ? "#30d158" : "#8a94a6";
      });
      datasets.push({
        label: "ニュース", data, pointStyle: "triangle", pointRadius: 8, pointHoverRadius: 11,
        pointBackgroundColor: colors, pointBorderColor: colors, showLine: false, spanGaps: false,
      });
    }
  }

  // 約定の印（取引履歴から開いたとき）
  if (opts.marker) {
    const i = snap(opts.marker.t);
    if (i >= 0) {
      const md = new Array(allLabels.length).fill(null); md[i] = opts.marker.price;
      datasets.push({
        label: opts.marker.label || "約定", data: md,
        borderColor: opts.marker.color || "#f0b429", backgroundColor: opts.marker.color || "#f0b429",
        pointRadius: 7, pointHoverRadius: 8, showLine: false, spanGaps: false,
      });
    }
  }

  // 指数の重ね描き（右の別軸。価格の絶対値ではなく「形＝連動」を見る）
  let hasOverlay = false;
  if (opts.overlay && opts.overlay.series && opts.overlay.series.length) {
    const im = {};
    opts.overlay.series.forEach((s) => { im[s.t] = s.close; im[s.t.slice(0, 10)] = s.close; });
    let last = null;
    const idata = allLabels.map((lb) => {
      if (lb === "") return null;                // 予測用の未来ラベルには引かない
      const v = (im[lb] != null ? im[lb] : im[lb.slice(0, 10)]);
      if (v != null) last = v;
      return v != null ? v : last;               // 無い点は直近値で埋めて線を切らさない
    });
    if (idata.some((v) => v != null)) {
      hasOverlay = true;
      const cOv = (_cs.getPropertyValue("--muted").trim() || "#8a94a6");
      datasets.push({
        label: `${opts.overlay.name}（指数・右軸）`, data: idata, yAxisID: "yIdx",
        borderColor: cOv, backgroundColor: "transparent", borderDash: [5, 3],
        borderWidth: 1.4, pointRadius: 0, pointHoverRadius: 3, fill: false, tension: .12, spanGaps: true,
      });
    }
  }

  if (projDataset) datasets.push(projDataset);

  chart = new Chart(ctx, {
    type: "line",
    data: { labels: allLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        zoom: {
          pan: { enabled: true, mode: "x" },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
          limits: { x: { minRange: 3 } },
        },
        legend: { display: datasets.length > 1, labels: { color: cMuted, boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label || "",
            label: (item) => {
              const lbl = item.dataset.label;
              if (lbl === "ニュース") {
                const metas = newsMeta[item.dataIndex] || [];
                return metas.map((m) => {
                  const hm = m.ts ? m.ts.slice(11, 16) + " " : "";
                  return `${sentJa(m.sentiment)} ${hm}${(m.title || "").slice(0, 42)}`;
                });
              }
              if (lbl && lbl.startsWith("この傾き")) return "予測の目安（直近の傾きを延長・断定ではありません）";
              if (item.parsed.y == null) return null;
              if (lbl && lbl.includes("指数")) return `${lbl.replace("（指数・右軸）", "")} ${num(item.parsed.y, 2)}`;
              const name = item.datasetIndex === 0 ? "終値" : lbl;
              return `${name} ${fmtCur(item.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: cMuted, maxTicksLimit: 7, autoSkip: true, maxRotation: 0 }, grid: { color: cGrid } },
        y: { ticks: { color: cMuted, callback: (v) => num(v, 2) }, grid: { color: cGrid } },
        yIdx: { display: false, position: "right", grid: { display: false } },
      },
    },
    plugins: [vLinePlugin],
  });
}
// ズーム表示のリセット（ホイール拡大・ドラッグ移動を元に戻す）
if (el("mZoomReset")) el("mZoomReset").onclick = () => {
  try { if (chart && chart.resetZoom) chart.resetZoom(); } catch (e) {}
};
// 期間切替ボタン
document.querySelectorAll("#mRanges button").forEach((b) => {
  b.onclick = () => {
    modalRange = b.dataset.range;
    document.querySelectorAll("#mRanges button").forEach((x) => x.classList.toggle("active", x === b));
    loadChart(modalTicker, modalRange, modalMarker);
  };
});
// 指数の重ね描きトグル（ブラウザに記憶）
(function setupOverlay() {
  const chk = el("mOverlay");
  if (!chk) return;
  try { chk.checked = localStorage.getItem("invest_overlay") === "1"; } catch {}
  chk.onchange = () => {
    try { localStorage.setItem("invest_overlay", chk.checked ? "1" : "0"); } catch {}
    if (el("mOverlayWrap")) el("mOverlayWrap").classList.toggle("on", chk.checked);
    if (modalTicker) loadChart(modalTicker, modalRange, modalMarker);
  };
})();
el("mClose").onclick = () => el("modalBg").classList.remove("show");
el("modalBg").onclick = (e) => { if (e.target === el("modalBg")) el("modalBg").classList.remove("show"); };
el("mBuy").onclick = async () => { await doTrade(modalTicker, "buy", Number(el("mQty").value)); };
el("mSell").onclick = async () => { await doTrade(modalTicker, "sell", Number(el("mQty").value)); };
el("mPredictSelf").onclick = () => recordPred("自分", null);
el("mPredictAI").onclick = () => recordPred("AI", Number(el("mPredictAI").dataset.prob) || null);
async function recordPred(source, prob) {
  try {
    await post("/api/predict", {
      ticker: modalTicker, direction: el("mDir").value,
      horizon_days: Number(el("mHorizon").value) || 5, probability: prob, source,
    });
    toast(`予測を記録しました（${source}）`);
    if (currentTab === "ai") loadPredictions();
  } catch (e) { toast(e.message, true); }
}

// ---- 行クリックで詳細モーダル ----
function bindRowClicks() {
  document.querySelectorAll("[data-ticker]").forEach((n) => {
    if (n.classList.contains("tile") || n.classList.contains("clickable"))
      n.onclick = () => openModal(n.dataset.ticker);
  });
}

// ---- ランキング・セクター・スクリーナー（Phase 6） ----
let lastSnapshots = [];
function mlH() { const s = el("mlHorizon"); return s ? (Number(s.value) || 5) : 5; }
const rrow = (x, val) => `<tr class="clickable" data-ticker="${x.ticker}">
  <td>${x.name}<span class="tk">${x.ticker}</span></td><td>${val}</td></tr>`;
function rankCard(title, items, render) {
  const rows = (items || []).map(render).join("") || `<tr><td class="note">データなし</td></tr>`;
  return `<div class="panel" style="min-width:220px"><h2 style="margin-top:0">${title}</h2>
    <table><tbody>${rows}</tbody></table></div>`;
}
function sigBadge(d) {
  if (d === "up") return '<span class="up">上</span>';
  if (d === "down") return '<span class="down">下</span>';
  return '<span class="flat">-</span>';
}
async function loadRanking() {
  const a = await api("/api/analysis?horizon=" + mlH());
  const r = a.rankings;
  el("rankCards").innerHTML =
    rankCard("値上がり率", r.gainers, (x) => rrow(x, pct(x.change_pct))) +
    rankCard("値下がり率", r.losers, (x) => rrow(x, pct(x.change_pct))) +
    rankCard("出来高急増", r.volume, (x) => rrow(x, x.vol_ratio == null ? "-" : x.vol_ratio.toFixed(2) + "倍")) +
    rankCard("AIサイン 上昇", r.ai_up, (x) => rrow(x, `<span class="up">${Math.round(x.signal_prob)}%</span>`)) +
    rankCard("AIサイン 下落", r.ai_down, (x) => rrow(x, `<span class="down">${Math.round(x.signal_prob)}%</span>`)) +
    rankCard("AIモデル 上昇", r.ml_up, (x) => rrow(x, x.ml_prob == null ? "-" : Math.round(x.ml_prob) + "%"));
  el("sectorBody").innerHTML = a.sectors.map((s) =>
    `<tr><td style="text-align:left">${s.sector}</td><td>${pct(s.avg_change)}</td><td>${s.up}/${s.count}</td></tr>`).join("");
  lastSnapshots = a.snapshots;
  renderScreen();
  bindRowClicks();
}
function numOr(v, d) { const n = Number(v); return v === "" || v == null || isNaN(n) ? d : n; }
function renderScreen() {
  const rmin = numOr(el("scRsiMin").value, -1e9), rmax = numOr(el("scRsiMax").value, 1e9);
  const cmin = numOr(el("scChgMin").value, -1e9), sig = el("scSignal").value;
  const rows = lastSnapshots.filter((x) => {
    if (x.rsi != null && (x.rsi < rmin || x.rsi > rmax)) return false;
    if (x.change_pct != null && x.change_pct < cmin) return false;
    if (sig && x.signal_dir !== sig) return false;
    return true;
  });
  el("screenBody").innerHTML = rows.map((x) => `<tr class="clickable" data-ticker="${x.ticker}">
    <td>${x.name}<span class="tk">${x.ticker}</span></td>
    <td>${x.close == null ? "-" : money(x.close, x.currency)}</td>
    <td>${pct(x.change_pct)}</td>
    <td>${x.rsi == null ? "-" : x.rsi.toFixed(1)}</td>
    <td>${x.vol_ratio == null ? "-" : x.vol_ratio.toFixed(2) + "倍"}</td>
    <td>${sigBadge(x.signal_dir)}</td>
    <td>${x.ml_prob == null ? "-" : Math.round(x.ml_prob) + "%"}</td></tr>`).join("") ||
    `<tr><td colspan="7" class="note">条件に合う銘柄がありません。</td></tr>`;
  bindRowClicks();
}
el("btnScreen").onclick = renderScreen;

// ---- 設定（Phase 8） ----
async function loadSettings() {
  applyModeUI();
  try { const s = await api("/api/settings"); el("setFee").value = s.fee_rate; } catch (e) { /* noop */ }
}
el("btnSaveSettings").onclick = async () => {
  try {
    const s = await post("/api/settings", { fee_rate: Number(el("setFee").value) || 0 });
    el("setFee").value = s.fee_rate;
    toast("設定を保存しました（手数料率 " + s.fee_rate + "%）");
  } catch (e) { toast(e.message, true); }
};
el("btnReset").onclick = async () => {
  if (!confirm("本当にリセットしますか？\n取引・保有・予測がすべて消え、現金が初期額に戻ります。")) return;
  try { await post("/api/reset"); toast("練習を初期化しました"); refresh(); }
  catch (e) { toast(e.message, true); }
};

// ---- まとめて再描画 ----
async function refresh() {
  try {
    if (currentTab === "market") await loadMarket();
    else if (currentTab === "ranking") await loadRanking();
    else if (currentTab === "trade") await loadTrade();
    else if (currentTab === "ai") { renderRecent(); await loadPredictions(); await loadMLMetrics(); }
    else if (currentTab === "settings") await loadSettings();
    bindRowClicks();
  } catch (e) { toast(e.message, true); }
}

applyModeUI();
if (el("mlHorizon")) el("mlHorizon").value = String(horizonForMode());  // AI予測の既定期間も目的に合わせる
restoreUI();
refresh();

/* ===== テーマ切替（ライト / ダーク / 暗め） ===== */
(function setupTheme() {
  const seg = document.getElementById("themeSeg");
  if (!seg) return;
  const get = () => { try { return localStorage.getItem("invest_theme") || "dark"; } catch { return "dark"; } };
  const apply = (t) => {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("invest_theme", t); } catch {}
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.theme === t));
    // Chart.js の文字色を地色に合わせ、開いているチャートがあれば描き直す
    try {
      if (window.Chart) {
        const cs = getComputedStyle(document.documentElement);
        Chart.defaults.color = cs.getPropertyValue("--muted").trim();
        Chart.defaults.borderColor = cs.getPropertyValue("--border").trim();
      }
      if (typeof redrawCurrentChart === "function") redrawCurrentChart();
    } catch {}
  };
  seg.querySelectorAll("button").forEach((b) => { b.onclick = () => apply(b.dataset.theme); });
  apply(get());
})();
