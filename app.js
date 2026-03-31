/**dd}`;
}
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  x.setHours(0, 0, 0, 0);
  return x;
}
function sameDay(a, b) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function inRangeYear(y) {
  return y >= SUPPORT_MIN_YEAR && y <= SUPPORT_MAX_YEAR;
}
function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/* ---------- Cache ---------- */
function cacheKey(year) {
  return `twcal-${year}-whitecal-v2`;
}
function loadCache(year) {
  try {
    const raw = localStorage.getItem(cacheKey(year));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.savedAt || !obj.data) return null;
    if (Date.now() - obj.savedAt > CACHE_TTL_MS) return null;
    return obj.data;
  } catch {
    return null;
  }
}
function saveCache(year, data) {
  try {
    localStorage.setItem(
      cacheKey(year),
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {}
}

/* ---------- Fetch (with throttle) ---------- */
let lastRequestAt = 0;
async function fetchYear(year) {
  const cached = loadCache(year);
  if (cached) return cached;

  const now = Date.now();
  const wait = Math.max(0, REQUEST_GAP_MS - (now - lastRequestAt));
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();

  const url = `${API_BASE}/${year}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API 取得 ${year} 失敗（HTTP ${res.status}）`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("API 回傳格式非陣列，無法解析。");

  saveCache(year, data);
  return data;
}
function buildMap(yearData) {
  const map = new Map();
  for (const row of yearData) {
    if (row?.date) map.set(String(row.date), row);
  }
  return map;
}

/* ---------- App state ---------- */
const state = {
  tab: "add",
  pickMode: "from", // diff: from / to

  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-11

  // yearMaps[year] = Map(date->row) OR null (fallback/no-data)
  yearMaps: {},
  // yearLoadStatus[year] = "ok" | "fallback" | "blocked"
  yearLoadStatus: {},

  startDate: null,
  dueDate: null,

  fromDate: null,
  toDate: null,

  explainOpen: false,
  explainItems: [],
};

/* ---------- Status UI ---------- */
function setStatus(msg, type = "normal") {
  const el = $("#statusMsg");
  if (!el) return;
  el.textContent = msg;

  // CSS: .status.warn
  el.classList.toggle("warn", type === "warn");
}

/* ---------- Holiday info (API or fallback) ---------- */
async function ensureYearMap(year, mode) {
  // mode: "fallback" | "block"
  if (state.yearLoadStatus[year] === "ok" || state.yearLoadStatus[year] === "fallback") {
    return;
  }

  // out-of-range year
  if (!inRangeYear(year)) {
    if (mode === "block") {
      state.yearLoadStatus[year] = "blocked";
      throw new Error(`年份 ${year} 不在支援範圍（${SUPPORT_MIN_YEAR}–${SUPPORT_MAX_YEAR}）`);
    }
    state.yearMaps[year] = null;
    state.yearLoadStatus[year] = "fallback";
    return;
  }

  // try fetch API
  try {
    setStatus(`載入 ${year} 台灣行事曆資料…`);
    const data = await fetchYear(year);
    state.yearMaps[year] = buildMap(data);
    state.yearLoadStatus[year] = "ok";
    setStatus("就緒");
  } catch (e) {
    if (mode === "block") {
      state.yearLoadStatus[year] = "blocked";
      throw new Error(`無法取得 ${year} 假日資料（阻擋模式已啟用）：${e.message}`);
    }
    // fallback to weekend-only
    state.yearMaps[year] = null;
    state.yearLoadStatus[year] = "fallback";

    const msg =
      "無法取得台灣假日資料（可能是 CORS/網路限制/請求限制），已改用「週末規則」繼續使用。";
    setStatus(msg, "warn");
  }
}

function getInfo(d) {
  const y = d.getFullYear();
  const m = state.yearMaps[y];
  if (!m) return null;
  return m.get(yyyymmdd(d)) || null;
}

function isHolidayByApi(d) {
  const info = getInfo(d);
  if (info && typeof info.isHoliday === "boolean") return info.isHoliday;
  return null; // unknown
}

// business day determination:
// - If API knows: !isHoliday
// - Else fallback: Mon-Fri = business, Sat/Sun = non-business
function isBusinessDay(d) {
  const api = isHolidayByApi(d);
  if (api === true) return false;
  if (api === false) return true;
  return !isWeekend(d);
}

/* ---------- Calendar rendering ---------- */
function calTitle() {
  const y = state.calYear;
  const m = state.calMonth + 1;
  return `${y} 年 ${m} 月`;
}

function firstCellDate(year, month) {
  const first = new Date(year, month, 1);
  const day = first.getDay(); // 0-6
  return addDays(first, -day); // start Sunday
}

function lastDateOfMonth(year, month) {
  return new Date(year, month + 1, 0);
}

function daySubText(d) {
  const info = getInfo(d);
  if (info?.caption) return info.caption;
  return "";
}

function dayClasses(d) {
  const cls = ["day"];
  const inMonth = d.getMonth() === state.calMonth && d.getFullYear() === state.calYear;
  if (!inMonth) cls.push("muted");

  if (isWeekend(d)) cls.push("weekend");

  // today highlight (works even without API)
  const t = parseISO(todayISO());
  if (t && sameDay(d, t)) cls.push("today");

  // if API known: holiday/makeup
  const apiHol = isHolidayByApi(d);
  if (apiHol === true) cls.push("holiday");
  if (isWeekend(d) && apiHol === false) cls.push("makeup");

  // highlight start/due depending on tab
  if (state.tab === "add") {
    if (state.startDate && sameDay(d, state.startDate)) cls.push("start");
    if (state.dueDate && sameDay(d, state.dueDate)) cls.push("due");
  } else {
    if (state.fromDate && sameDay(d, state.fromDate)) cls.push("start");
    if (state.toDate && sameDay(d, state.toDate)) cls.push("due");
  }

  return cls.join(" ");
}

function renderCalendar() {
  $("#calTitle").textContent = calTitle();
  const grid = $("#calGrid");
  grid.innerHTML = "";

  const start = firstCellDate(state.calYear, state.calMonth);

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);

    const el = document.createElement("button");
    el.type = "button";
    el.className = dayClasses(d);

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = d.getDate();

    const sub = document.createElement("div");
    sub.className = "subtxt";
    const txt = daySubText(d);
    sub.textContent = txt;

    // tooltip
    const apiHol = isHolidayByApi(d);
    if (txt) el.title = `${fmtYMD(d)} ${txt}`;
    else if (apiHol === true) el.title = `${fmtYMD(d)} 假日`;
    else if (apiHol === false) el.title = `${fmtYMD(d)} 工作日`;
    else el.title = fmtYMD(d);

    el.appendChild(num);
    el.appendChild(sub);

    // makeup tag
    if (isWeekend(d) && apiHol === false) {
      const tag = document.createElement("div");
      tag.className = "tag makeup";
      tag.textContent = "補班";
      el.appendChild(tag);
    }

    el.addEventListener("click", () => onPickDate(d));
    grid.appendChild(el);
  }
}

async function ensureMonthData() {
  const mode = state.tab === "add" ? $("#outOfRange").value : $("#outOfRangeDiff").value;

  // Try loading data for displayed year; if fails, still render calendar with weekend/today/start/due
  try {
    await ensureYearMap(state.calYear, mode);
  } catch (e) {
    // if blocked, show warn but still render (for UI) — calculations will be blocked on action
    setStatus(e.message, "warn");
  }

  renderCalendar();
}

/* ---------- Picking from calendar ---------- */
function onPickDate(d) {
  const iso = fmtYMD(d);

  if (state.tab === "add") {
    $("#startDate").value = iso;
    state.startDate = d;
    // auto-calc to show due immediately
    calcAdd().catch((err) => setStatus(err.message, "warn"));
  } else {
    if (state.pickMode === "from") {
      $("#fromDate").value = iso;
      state.fromDate = d;
    } else {
      $("#toDate").value = iso;
      state.toDate = d;
    }
    renderCalendar();
  }
}

/* ---------- Explain list (Add mode) ---------- */
function setSummaryAdd(main, meta) {
  $("#summaryAdd .summary-main").textContent = main;
  $("#summaryAdd .summary-meta").textContent = meta;
}

function addExplainItem(left, right, badgeClass, badgeText) {
  state.explainItems.push({ left, right, badgeClass, badgeText });
}

function renderExplain() {
  const box = $("#explainBox");
  const list = $("#explainList");
  box.hidden = !state.explainOpen;
  if (!state.explainOpen) return;

  list.innerHTML = "";
  const items = state.explainItems.slice(-60).reverse();
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div style="font-weight:1000;">${it.left}</div>
        <div style="color:#64748B; font-size:12px; margin-top:3px;">${it.right}</div>
      </div>
      <div class="badge ${it.badgeClass}">${it.badgeText}</div>
    `;
    list.appendChild(row);
  }
}

/* ---------- Add mode calculation ---------- */
async function calcAdd() {
  const start = parseISO($("#startDate").value);
  const n = Number($("#daysToAdd").value);
  const dayType = $("#dayType").value; // calendar / business
  const countMode = $("#countMode").value; // include / next
  const outOfRange = $("#outOfRange").value; // fallback / block

  state.explainItems = [];

  if (!start) {
    setSummaryAdd("—", "請選擇起始日期");
    return;
  }
  if (!Number.isFinite(n) || n < 0) {
    setSummaryAdd("—", "天數需為 0 以上整數");
    return;
  }

  state.startDate = start;

  // ensure start year map (may fallback)
  await ensureYearMap(start.getFullYear(), outOfRange);

  if (n === 0) {
    state.dueDate = start;
    setSummaryAdd(fmtYMD(start), "天數為 0：結果日期等於起始日期");
    state.calYear = start.getFullYear();
    state.calMonth = start.getMonth();
    await ensureMonthData();
    renderExplain();
    return;
  }

  let due = null;

  if (dayType === "calendar") {
    due = addDays(start, countMode === "include" ? n - 1 : n);
    await ensureYearMap(due.getFullYear(), outOfRange);

    const info = getInfo(due);
    const hol = info?.isHoliday === true ? "假日" : "工作日";
    const cap = info?.caption ? `（${info.caption}）` : "";
    setSummaryAdd(
      fmtYMD(due),
      `${n} 個日曆天｜${countMode === "include" ? "含當日" : "次一日"}｜${hol}${cap}`
    );
  } else {
    let cur = new Date(start);
    if (countMode === "next") cur = addDays(cur, 1);

    let count = 0;

    while (true) {
      await ensureYearMap(cur.getFullYear(), outOfRange);

      const info = getInfo(cur);
      const cap = info?.caption || "";
      const apiHol = info?.isHoliday;

      const business = isBusinessDay(cur);

      let label = "";
      let badgeClass = "";
      let badgeText = "";

      if (business) {
        count++;
        label = `計入第 ${count} 個工作天`;
        badgeClass = "count";
        badgeText = "計入";
      } else {
        label = "跳過（非工作天）";
        badgeClass = "skip";
        badgeText = "跳過";
      }

      const left = `${fmtYMD(cur)}（${["日","一","二","三","四","五","六"][cur.getDay()]}）`;
      const right = [
        label,
        cap ? cap : (apiHol === true ? "假日" : apiHol === false ? "工作日" : (isWeekend(cur) ? "週末" : "平日")),
        isWeekend(cur) && apiHol === false ? "補班" : ""
      ].filter(Boolean).join("｜");

      // badge override: holiday/makeup more important
      if (apiHol === true) {
        badgeClass = "hol";
        badgeText = "假日";
      } else if (isWeekend(cur) && apiHol === false) {
        badgeClass = "makeup";
        badgeText = "補班";
      }

      addExplainItem(left, right, badgeClass, badgeText);

      if (count === n) {
        due = cur;
        break;
      }

      cur = addDays(cur, 1);
      if (count > 8000) throw new Error("計算異常（迴圈過長）");
    }

    const dueInfo = getInfo(due);
    const cap = dueInfo?.caption ? `（${dueInfo.caption}）` : "";
    const hol = dueInfo?.isHoliday === true ? "假日" : "工作日";
    setSummaryAdd(
      fmtYMD(due),
      `${n} 個工作天｜${countMode === "include" ? "含當日" : "次一日"}｜到期日為${hol}${cap}`
    );
  }

  state.dueDate = due;

  // show due month for visibility
  state.calYear = due.getFullYear();
  state.calMonth = due.getMonth();
  await ensureMonthData();

  renderExplain();
}

/* ---------- Diff mode calculation ---------- */
function setSummaryDiff(main, meta) {
  $("#summaryDiff .summary-main").textContent = main;
  $("#summaryDiff .summary-meta").textContent = meta;
}

async function calcDiff() {
  const from = parseISO($("#fromDate").value);
  const to = parseISO($("#toDate").value);
  const incStart = $("#diffIncludeStart").value === "yes";
  const incEnd = $("#diffIncludeEnd").value === "yes";
  const outOfRange = $("#outOfRangeDiff").value; // fallback / block

  if (!from || !to) {
    setSummaryDiff("—", "請選擇起迄日期");
    return;
  }

  state.fromDate = from;
  state.toDate = to;

  const dir = from <= to ? 1 : -1;
  const start = dir === 1 ? from : to;
  const end = dir === 1 ? to : from;

  // calendar days
  const msPerDay = 86400000;
  let days = Math.round((end - start) / msPerDay);
  if (incStart) days += 1;
  if (!incEnd) days -= 1;
  if (days < 0) days = 0;

  // ensure year maps across range
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    await ensureYearMap(y, outOfRange);
  }

  // business days
  let bdays = 0;
  let cur = new Date(start);
  cur.setHours(0, 0, 0, 0);

  while (cur <= end) {
    const isStart = sameDay(cur, start);
    const isEnd = sameDay(cur, end);
    const includeThis = (!isStart || incStart) && (!isEnd || incEnd);

    if (includeThis) {
      if (isBusinessDay(cur)) bdays++;
    }
    cur = addDays(cur, 1);
  }

  const meta = `${fmtYMD(start)} ~ ${fmtYMD(end)}｜${incStart ? "含起" : "不含起"}｜${incEnd ? "含迄" : "不含迄"}`;
  setSummaryDiff(`日曆天 ${days} 天 · 工作天 ${bdays} 天`, meta);

  // focus end month
  state.calYear = end.getFullYear();
  state.calMonth = end.getMonth();
  await ensureMonthData();
}

/* ---------- UI wiring ---------- */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  });

  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  $(`#panel-${tab}`).classList.add("active");

  ensureMonthData().catch((e) => setStatus(e.message, "warn"));
}

function setPickMode(mode) {
  state.pickMode = mode;
  $("#pickFrom").classList.toggle("active", mode === "from");
  $("#pickTo").classList.toggle("active", mode === "to");
}

function resetAll() {
  $("#startDate").value = todayISO();
  $("#daysToAdd").value = 10;
  $("#dayType").value = "business";
  $("#countMode").value = "include";
  $("#outOfRange").value = "fallback";

  $("#fromDate").value = todayISO();
  $("#toDate").value = todayISO();
  $("#diffIncludeStart").value = "no";
  $("#diffIncludeEnd").value = "yes";
  $("#outOfRangeDiff").value = "fallback";

  state.startDate = parseISO($("#startDate").value);
  state.dueDate = null;

  state.fromDate = parseISO($("#fromDate").value);
  state.toDate = parseISO($("#toDate").value);

  state.explainOpen = false;
  $("#explainBox").hidden = true;

  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();

  setSummaryAdd("—", "請先設定起始日期與天數");
  setSummaryDiff("—", "設定起迄日期後按「計算」");

  setStatus("就緒");
  ensureMonthData().catch((e) => setStatus(e.message, "warn"));
}

function init() {
  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  // Month nav
  $("#prevMonth").addEventListener("click", async () => {
    state.calMonth -= 1;
    if (state.calMonth < 0) {
      state.calMonth = 11;
      state.calYear -= 1;
    }
    await ensureMonthData();
  });
  $("#nextMonth").addEventListener("click", async () => {
    state.calMonth += 1;
    if (state.calMonth > 11) {
      state.calMonth = 0;
      state.calYear += 1;
    }
    await ensureMonthData();
  });

  // Buttons
  $("#btnCalcAdd").addEventListener("click", () =>
    calcAdd().catch((e) => setStatus(e.message, "warn"))
  );
  $("#btnCalcDiff").addEventListener("click", () =>
    calcDiff().catch((e) => setStatus(e.message, "warn"))
  );

  $("#btnSwap").addEventListener("click", () => {
    const a = $("#fromDate").value;
    $("#fromDate").value = $("#toDate").value;
    $("#toDate").value = a;
    state.fromDate = parseISO($("#fromDate").value);
    state.toDate = parseISO($("#toDate").value);
    renderCalendar();
  });

  $("#btnToday").addEventListener("click", () => {
    const t = todayISO();
    if (state.tab === "add") {
      $("#startDate").value = t;
      state.startDate = parseISO(t);
      calcAdd().catch((e) => setStatus(e.message, "warn"));
    } else {
      $("#fromDate").value = t;
      $("#toDate").value = t;
      state.fromDate = parseISO(t);
      state.toDate = parseISO(t);
      renderCalendar();
    }
  });

  $("#btnReset").addEventListener("click", resetAll);

  $("#btnExplain").addEventListener("click", () => {
    state.explainOpen = !state.explainOpen;
    renderExplain();
  });

  // Diff pick mode
  $("#pickFrom").addEventListener("click", () => setPickMode("from"));
  $("#pickTo").addEventListener("click", () => setPickMode("to"));

  // Inputs
  $("#startDate").addEventListener("change", () => {
    state.startDate = parseISO($("#startDate").value);
    renderCalendar();
  });
  $("#fromDate").addEventListener("change", () => {
    state.fromDate = parseISO($("#fromDate").value);
    renderCalendar();
  });
  $("#toDate").addEventListener("change", () => {
    state.toDate = parseISO($("#toDate").value);
    renderCalendar();
  });

  // Start
  resetAll();
}

init();
``
 * White Calendar UI - app.js
 * Data source: 880831ian/taiwan-calendar API
 * - Endpoint: GET /taiwan-calendar/{year}
 * - Fields: date(YYYYMMDD), isHoliday(boolean), caption(string) ... etc.
 *
 * If API fetch fails (CORS / network / rate limit), UI will:
 * - Show a human-friendly warning
 * - Fallback to weekend-only rule (still usable)
 */

/* ---------- API settings ---------- */
const API_BASE = "https://api.pin-yi.me/taiwan-calendar"; // basePath already includes /taiwan-calendar
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const REQUEST_GAP_MS = 650; // conservative throttle for rate limit (2 req/sec)

/* ---------- Supported range (from project README note) ---------- */
const SUPPORT_MIN_YEAR = 2017;
const SUPPORT_MAX_YEAR = 2026;

/* ---------- DOM helpers ---------- */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Date utils ---------- */
function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function parseISO(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
