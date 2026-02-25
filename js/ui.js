/* ============================================================
   SPARKLINE (SVG inline mini-chart)
   ============================================================ */
function sparklineSVG(data, up) {
  if (!data || data.length < 2)
    return `<svg class="sparkline" viewBox="0 0 80 28"><line x1="0" y1="14" x2="80" y2="14" stroke="#30363D" stroke-width="1"/></svg>`;

  const vals = data.map(d => d.rate);
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * 78 + 1;
    const y = 24 - ((v - mn) / rng) * 20 + 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const col = up ? "#3FB950" : "#F85149";
  return `<svg class="sparkline" viewBox="0 0 80 28" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ============================================================
   MAIN LIST
   ============================================================ */
function renderList() {
  const el = document.getElementById("mainContent");
  const q  = S.query.toLowerCase();

  const filtered = CFG.PAIRS.filter(p => {
    if (!q) return true;
    return (`${p.f}/${p.t}`.toLowerCase().includes(q) ||
            p.fn.toLowerCase().includes(q) ||
            p.tn.toLowerCase().includes(q));
  });

  if (!filtered.length) {
    el.innerHTML = `<div class="center-msg"><span>No pairs match "<b>${S.query}</b>"</span></div>`;
    return;
  }

  const groups = {};
  filtered.forEach(p => (groups[p.cat] = groups[p.cat] || []).push(p));

  let html = "";
  for (const [cat, pairs] of Object.entries(groups)) {
    html += `<div class="cat-head">${cat}</div><div class="pair-list">`;
    for (const p of pairs) {
      const key     = `${p.f}/${p.t}`;
      const rate    = calcRate(S.rates, p.f, p.t);
      const prev    = S.prevRates[key];
      const chgAbs  = (rate != null && prev != null) ? rate - prev : null;
      const chgPct  = chgAbs != null ? (chgAbs / prev) * 100 : null;
      const up      = chgPct != null ? chgPct >= 0 : null;
      const chgTxt  = chgPct != null ? `${up ? "▲" : "▼"} ${Math.abs(chgPct).toFixed(2)}%` : "—";
      const chgCls  = up == null ? "" : (up ? "up" : "down");
      const spark   = S.histCache[`${p.f}/${p.t}/7`]?.data;

      html += `
        <div class="card" onclick="openDetail('${p.f}','${p.t}')">
          <div class="card-main">
            <div class="card-left">
              <span class="flags">${p.ff}${p.tf}</span>
              <div>
                <div class="pair-name">${key}</div>
                <div class="pair-sub">${p.fn} / ${p.tn}</div>
              </div>
            </div>
            <div class="card-right">
              <div class="rate-val">${rate != null ? fmt(rate, p.f, p.t) : "—"}</div>
              <div class="chg ${chgCls}">${chgTxt}</div>
            </div>
          </div>
          <div class="card-spark">
            ${sparklineSVG(spark, up !== false)}
          </div>
        </div>`;
    }
    html += "</div>";
  }

  el.innerHTML = html;
}

/* ============================================================
   MULTI-TIMEFRAME OVERVIEW
   ============================================================ */
const TF_INTERVALS = [
  { key: "1m",  label: "1m"  },
  { key: "5m",  label: "5m"  },
  { key: "15m", label: "15m" },
  { key: "30m", label: "30m" },
  { key: "1h",  label: "1h"  },
  { key: "2h",  label: "2h"  },
  { key: "4h",  label: "4h"  },
  { key: "1D",  label: "1D"  },
];

function buildMultiTimeframeData(f, t) {
  const currentRate = calcRate(S.rates, f, t);
  return TF_INTERVALS.map(({ key, label }) => {
    if (key === "1D") {
      const prev = S.prevRates[`${f}/${t}`];
      if (prev != null && currentRate != null) {
        const chgPct = ((currentRate - prev) / prev) * 100;
        return { key, label, chgPct, up: chgPct >= 0, hasData: true };
      }
    }
    const cached = S.chartCache[`${f}/${t}/${key}`];
    if (cached?.data?.length) {
      const data  = cached.data;
      const open  = data[0].open ?? data[0].rate;
      const close = data[data.length - 1].rate;
      if (open) {
        const chgPct = ((close - open) / open) * 100;
        return { key, label, chgPct, up: chgPct >= 0, hasData: true };
      }
    }
    return { key, label, chgPct: null, up: null, hasData: false };
  });
}

function renderMultiTimeframe(f, t) {
  const el = document.getElementById("multiTf");
  if (!el) return;

  const tfData = buildMultiTimeframeData(f, t);
  const hasAny = tfData.some(d => d.hasData);
  if (!hasAny) { el.innerHTML = ""; return; }

  const cells = tfData.map(d => {
    const cls       = d.hasData ? (d.up ? "tf-up" : "tf-down") : "";
    const activeCls = d.key === S.interval ? " tf-active" : "";
    const arrow     = d.hasData ? (d.up ? "▲" : "▼") : "·";
    const pct       = d.hasData ? `${d.up ? "+" : ""}${d.chgPct.toFixed(2)}%` : "—";
    return `<div class="tf-cell ${cls}${activeCls}" onclick="setChartIntervalByKey('${d.key}')">
      <span class="tf-key">${d.label}</span>
      <span class="tf-arrow">${arrow}</span>
      <span class="tf-val">${pct}</span>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="section-label">Timeframe Overview</div>
    <div class="tf-grid">${cells}</div>`;
}

function setChartIntervalByKey(interval) {
  const btn = document.querySelector(`.period-btn[data-iv="${interval}"]`);
  if (btn) setChartInterval(btn, interval);
}
