/* ============================================================
   SEARCH
   ============================================================ */
function onSearch(v) {
  S.query = v.trim();
  if (Object.keys(S.rates).length) renderList();
}

/* ============================================================
   REFRESH ENGINE
   ============================================================ */
let _cdInterval = null;

function startCountdown() {
  S.countdown = CFG.REFRESH_SECS;
  clearInterval(_cdInterval);
  _cdInterval = setInterval(() => {
    S.countdown--;
    updateCountdown();
    if (S.countdown <= 0) doRefresh();
  }, 1000);
}

function updateCountdown() {
  const m = Math.floor(S.countdown / 60);
  const s = S.countdown % 60;
  document.getElementById("countdownTxt").textContent =
    `${m}:${String(s).padStart(2, "0")}`;
}

function setStatus(txt, ok = true) {
  document.getElementById("statusTxt").textContent = txt;
  document.getElementById("liveDot").className = `live-dot${ok ? "" : " err"}`;
}

async function doRefresh() {
  if (S.busy) return;
  S.busy = true;
  document.getElementById("spinIcon").classList.add("spinning");
  setStatus("Updating…", true);

  try {
    const { rates, prevRates } = await fetchFrankfurterQuotes();
    S.rates     = rates;
    S.prevRates = prevRates;
    S.lastTs    = new Date();

    // Sparklines are populated by fetchFrankfurterQuotes; render immediately
    renderList();
    const ts = S.lastTs.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    setStatus(`Updated ${ts}`, true);
    startCountdown();

    const loader = document.getElementById("initLoader");
    if (loader) loader.remove();

  } catch (err) {
    console.error("Refresh failed:", err);
    setStatus("Update failed", false);

    if (!Object.keys(S.rates).length) {
      document.getElementById("mainContent").innerHTML = `
        <div class="center-msg">
          <div class="err-title">Unable to load rates</div>
          <span>Check your internet connection</span>
          <button class="retry-btn" onclick="manualRefresh()">Retry</button>
        </div>`;
    }
    S.countdown = 30;
    startCountdown();
  } finally {
    S.busy = false;
    document.getElementById("spinIcon").classList.remove("spinning");
  }
}

function manualRefresh() {
  clearInterval(_cdInterval);
  S.prevRates = {};
  doRefresh();
}

/* ============================================================
   SWIPE-TO-CLOSE DETAIL (touch)
   ============================================================ */
let _touchX = 0;
const detailEl = document.getElementById("detail");
detailEl.addEventListener("touchstart", e => { _touchX = e.touches[0].clientX; }, { passive: true });
detailEl.addEventListener("touchend",   e => {
  if (e.changedTouches[0].clientX - _touchX > 70) closeDetail();
}, { passive: true });

/* ============================================================
   KEYBOARD
   ============================================================ */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDetail();
});

/* ============================================================
   ONLINE / OFFLINE
   ============================================================ */
window.addEventListener("online",  () => { setStatus("Back online, refreshing…"); doRefresh(); });
window.addEventListener("offline", () => setStatus("Offline — showing cached rates", false));

/* ============================================================
   VISIBILITY — refresh if stale when tab regains focus
   ============================================================ */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.countdown <= 0) doRefresh();
});

/* ============================================================
   BOOT
   ============================================================ */
doRefresh();
