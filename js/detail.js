/* ============================================================
   DETAIL PANEL
   ============================================================ */
async function openDetail(f, t) {
  const p = CFG.PAIRS.find(x => x.f === f && x.t === t);
  if (!p) return;
  S.selected = p;
  S.interval = "1m";

  // Populate header from cached rates
  const rate = calcRate(S.rates, f, t);
  const prev = S.prevRates[`${f}/${t}`];
  const chgAbs = (rate != null && prev != null) ? rate - prev : null;
  const chgPct = chgAbs != null ? (chgAbs / prev) * 100 : null;
  const up = chgPct != null ? chgPct >= 0 : null;

  document.getElementById("dPair").textContent = `${f}/${t}`;
  document.getElementById("dFull").textContent = `${p.fn} / ${p.tn}`;
  document.getElementById("dRate").textContent = rate != null ? fmt(rate, f, t) : "—";

  const dChg = document.getElementById("dChg");
  if (chgPct != null) {
    dChg.textContent = `${up ? "▲" : "▼"} ${fmt(Math.abs(chgAbs), f, t)} (${up ? "+" : ""}${chgPct.toFixed(3)}%)`;
    dChg.className = `d-chg ${up ? "up" : "down"}`;
  } else {
    dChg.textContent = "—";
    dChg.className = "d-chg";
  }

  // Reset interval buttons
  document.querySelectorAll(".period-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.iv === "1m"));

  // Open panel
  document.getElementById("detail").classList.add("open");
  document.body.style.overflow = "hidden";

  // Show any already-cached timeframe data immediately
  renderMultiTimeframe(f, t);

  await loadChart(f, t, "1m");
}

function closeDetail() {
  document.getElementById("detail").classList.remove("open");
  document.body.style.overflow = "";
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  document.getElementById("statsGrid").innerHTML = "";
  document.getElementById("infoBlock").innerHTML = "";
  document.getElementById("multiTf").innerHTML = "";
}

async function setChartInterval(btn, interval) {
  document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  S.interval = interval;
  if (S.selected) await loadChart(S.selected.f, S.selected.t, interval);
}

/* ============================================================
   CHART LOADING
   Intraday (1m–4h) → Yahoo Finance (via CORS proxy)
   1D / 1W → Frankfurter
   ============================================================ */
async function loadChart(f, t, interval) {
  const canvas = document.getElementById("mainChart");
  const loader = document.getElementById("chartLoader");
  loader.style.display = "flex";
  canvas.style.opacity = "0";

  if (S.chart) { S.chart.destroy(); S.chart = null; }

  const usesFrankfurter = interval === "1D" || interval === "1W";

  let data;
  try {
    data = usesFrankfurter
      ? await fetchFrankfurterChart(f, t, interval)
      : await fetchYahooFinanceChart(f, t, interval);
  } catch (err) {
    loader.style.display = "none";
    canvas.style.opacity = "1";

    document.getElementById("statsGrid").innerHTML =
      `<div style="grid-column:1/-1;color:var(--txt2);padding:8px 0;text-align:center">
        Chart data unavailable. Check your connection and try again.
      </div>`;
    document.getElementById("infoBlock").innerHTML = "";
    return;
  }

  loader.style.display = "none";
  canvas.style.opacity = "1";

  if (!data || !data.length) {
    document.getElementById("statsGrid").innerHTML =
      `<div style="grid-column:1/-1;color:var(--txt2);padding:8px 0">No data for this interval.</div>`;
    document.getElementById("infoBlock").innerHTML = "";
    return;
  }

  const vals   = data.map(d => d.rate);
  const open   = data[0].open  ?? vals[0];
  const close  = vals[vals.length - 1];
  const mn     = Math.min(...data.map(d => d.low  ?? d.rate));
  const mx     = Math.max(...data.map(d => d.high ?? d.rate));
  const chg    = close - open;
  const chgPct = (chg / open) * 100;
  const up     = chg >= 0;

  // Refresh multi-timeframe now that this interval's cache is populated
  renderMultiTimeframe(f, t);

  // Stats grid
  document.getElementById("statsGrid").innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Open</div>
      <div class="stat-val">${fmt(open, f, t)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Close</div>
      <div class="stat-val" style="color:var(--${up?"green":"red"})">${fmt(close, f, t)}</div>
    </div>
    <div class="stat-card stat-low">
      <div class="stat-label">Low</div>
      <div class="stat-val" style="color:var(--red)">${fmt(mn, f, t)}</div>
    </div>
    <div class="stat-card stat-high">
      <div class="stat-label">High</div>
      <div class="stat-val" style="color:var(--green)">${fmt(mx, f, t)}</div>
    </div>
  `;

  // Info block
  document.getElementById("infoBlock").innerHTML = `
    <div class="info-block">
      <div class="info-title">${INTERVAL_LABELS[interval] || interval} Chart — ${f}/${t}</div>
      <div class="info-row">
        <span class="info-k">Change</span>
        <span class="info-v" style="color:var(--${up?"green":"red"})">
          ${up ? "▲" : "▼"} ${fmt(Math.abs(chg), f, t)} (${up?"+":""}${chgPct.toFixed(3)}%)
        </span>
      </div>
      <div class="info-row">
        <span class="info-k">Range</span>
        <span class="info-v">${fmt(mx - mn, f, t)}</span>
      </div>
      <div class="info-row">
        <span class="info-k">Candles</span>
        <span class="info-v">${data.length}</span>
      </div>
      <div class="info-row">
        <span class="info-k">Source</span>
        <span class="info-v" style="color:var(--txt3)">${usesFrankfurter ? "Frankfurter / ECB" : "Yahoo Finance"}</span>
      </div>
    </div>
  `;

  // Build chart
  const labels = data.map(d => fmtChartLabel(d.ts, interval));
  const color  = up ? "#3FB950" : "#F85149";
  const ctx    = canvas.getContext("2d");

  S.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: vals,
        borderColor: color,
        backgroundColor: color + "18",
        fill: true,
        tension: 0.25,
        pointRadius: data.length > 200 ? 0 : (data.length > 60 ? 1 : 2),
        pointHoverRadius: 4,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1C2537",
          borderColor: "#30363D",
          borderWidth: 1,
          titleColor: "#8B949E",
          bodyColor: "#E6EDF3",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => ` ${fmt(ctx.raw, f, t)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "#1C2537" },
          ticks: { color: "#6E7681", maxTicksLimit: 6, maxRotation: 0, font: { size: 11 } },
        },
        y: {
          position: "right",
          grid: { color: "#1C2537" },
          ticks: {
            color: "#6E7681",
            font: { size: 11 },
            callback: v => fmt(v, f, t),
          },
        },
      },
    },
  });
}
