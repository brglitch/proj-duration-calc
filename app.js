/**
 * Uses 880831ian/taiwan-calendar API.
 * Endpoints include: GET /taiwan-calendar/{year} and data contains fields like date(YYYYMMDD), isHoliday, caption. (See README)
 */
const API_BASE = "https://api.pin-yi.me/taiwan-calendar";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const REQUEST_GAP_MS = 650; // be conservative about rate limit (2 req/sec)

const SUPPORT_MIN_YEAR = 2017;
const SUPPORT_MAX_YEAR = 2026;

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- Date utils ---------- */
function todayISO(){
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function parseISO(iso){
  if(!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if(isNaN(d.getTime())) return null;
  d.setHours(0,0,0,0);
  return d;
}
function fmtYMD(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function yyyymmdd(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}${m}${dd}`;
}
function addDays(d, n){
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  x.setHours(0,0,0,0);
  return x;
}
function sameDay(a,b){
  if(!a || !b) return false;
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function inRangeYear(y){ return y>=SUPPORT_MIN_YEAR && y<=SUPPORT_MAX_YEAR; }

/* ---------- Cache ---------- */
function cacheKey(year){ return `twcal-${year}-whitecal-v1`; }
function loadCache(year){
  try{
    const raw = localStorage.getItem(cacheKey(year));
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || !obj.savedAt || !obj.data) return null;
    if(Date.now() - obj.savedAt > CACHE_TTL_MS) return null;
    return obj.data;
  }catch{ return null; }
}
function saveCache(year, data){
  try{
    localStorage.setItem(cacheKey(year), JSON.stringify({ savedAt: Date.now(), data }));
  }catch{}
}

/* ---------- API (year) ---------- */
let lastRequestAt = 0;

async function fetchYear(year){
  const cached = loadCache(year);
  if(cached) return cached;

  const now = Date.now();
  const wait = Math.max(0, REQUEST_GAP_MS - (now - lastRequestAt));
  if(wait) await sleep(wait);
  lastRequestAt = Date.now();

  const url = `${API_BASE}/${year}`;
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error(`API 取得 ${year} 失敗（HTTP ${res.status}）`);
  const data = await res.json();
  if(!Array.isArray(data)) throw new Error("API 回傳格式非陣列，無法解析。");
  saveCache(year, data);
  return data;
}

function buildMap(yearData){
  const map = new Map();
  for(const row of yearData){
    if(row?.date) map.set(String(row.date), row);
  }
  return map;
}

/* ---------- State ---------- */
const state = {
  tab: "add",
  pickMode: "from", // diff mode: from / to
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-11
  yearMaps: {},

  // inputs snapshot
  startDate: null,
  dueDate: null,

  fromDate: null,
  toDate: null,

  // explain list
  explainOpen: false,
  explainItems: []
};

function setStatus(msg){ $("#statusMsg").textContent = msg; }

/* ---------- Holiday info ---------- */
async function ensureYearMap(year, outOfRangeMode){
  if(state.yearMaps[year]) return;

  if(!inRangeYear(year)){
    if(outOfRangeMode === "block"){
      throw new Error(`年份 ${year} 不在支援範圍（${SUPPORT_MIN_YEAR}–${SUPPORT_MAX_YEAR}）`);
    }
    // fallback: no map, just skip loading
    state.yearMaps[year] = null;
    return;
  }

  setStatus(`載入 ${year} 行事曆資料…`);
  const data = await fetchYear(year);
  state.yearMaps[year] = buildMap(data);
  setStatus("就緒");
}

function getInfo(d){
  const y = d.getFullYear();
  const m = state.yearMaps[y];
  if(!m) return null;
  return m.get(yyyymmdd(d)) || null;
}

function isWeekend(d){
  const w = d.getDay();
  return w === 0 || w === 6;
}

function isHolidayByApi(d){
  const info = getInfo(d);
  if(info && typeof info.isHoliday === "boolean"){
    return info.isHoliday;
  }
  return null; // unknown
}

function isBusinessDay(d, outOfRangeMode){
  const api = isHolidayByApi(d);
  if(api === true) return false;
  if(api === false) return true;

  // fallback: weekend rule
  if(outOfRangeMode === "block"){
    // if block mode but no info, treat as error at a higher layer (ensureYearMap)
    return !isWeekend(d);
  }
  return !isWeekend(d);
}

/* ---------- Calendar rendering ---------- */
function calTitle(){
  const y = state.calYear;
  const m = state.calMonth + 1;
  return `${y} 年 ${m} 月`;
}

function firstCellDate(year, month){
  // month: 0-11
  const first = new Date(year, month, 1);
  const day = first.getDay(); // 0-6
  return addDays(first, -day); // start from Sunday
}

function lastDateOfMonth(year, month){
  return new Date(year, month + 1, 0);
}

function daySubText(d){
  const info = getInfo(d);
  if(info?.caption) return info.caption;
  return "";
}

function dayClasses(d){
  const cls = ["day"];

  const inMonth = d.getMonth() === state.calMonth && d.getFullYear() === state.calYear;
  if(!inMonth) cls.push("muted");

  if(isWeekend(d)) cls.push("weekend");

  const apiHol = isHolidayByApi(d);
  if(apiHol === true) cls.push("holiday");

  // makeup: weekend but isHoliday=false
  if(isWeekend(d) && apiHol === false) cls.push("makeup");

  // highlights based on current tab result
  if(state.tab === "add"){
    if(state.startDate && sameDay(d, state.startDate)) cls.push("start");
    if(state.dueDate && sameDay(d, state.dueDate)) cls.push("due");
  }else{
    if(state.fromDate && sameDay(d, state.fromDate)) cls.push("start");
    if(state.toDate && sameDay(d, state.toDate)) cls.push("due");
  }

  return cls.join(" ");
}

function renderCalendar(){
  $("#calTitle").textContent = calTitle();
  const grid = $("#calGrid");
  grid.innerHTML = "";

  const start = firstCellDate(state.calYear, state.calMonth);
  const end = lastDateOfMonth(state.calYear, state.calMonth);
  // 6 rows always (42 cells)
  for(let i=0;i<42;i++){
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

    // tooltip: show caption if any
    if(txt){
      el.title = `${fmtYMD(d)} ${txt}`;
    }else{
      // show basic info if holiday known
      const apiHol = isHolidayByApi(d);
      if(apiHol === true) el.title = `${fmtYMD(d)} 假日`;
      else if(apiHol === false) el.title = `${fmtYMD(d)} 工作日`;
      else el.title = fmtYMD(d);
    }

    el.appendChild(num);
    el.appendChild(sub);

    // makeup tag
    const apiHol = isHolidayByApi(d);
    if(isWeekend(d) && apiHol === false){
      const tag = document.createElement("div");
      tag.className = "tag makeup";
      tag.textContent = "補班";
      el.appendChild(tag);
    }

    el.addEventListener("click", () => onPickDate(d));
    grid.appendChild(el);
  }
}

async function ensureMonthData(){
  // load year map for current displayed year, to show holidays in the calendar
  const mode = state.tab === "add" ? $("#outOfRange").value : $("#outOfRangeDiff").value;
  try{
    await ensureYearMap(state.calYear, mode);
  }catch(e){
    setStatus(e.message);
  }
  renderCalendar();
}

/* ---------- Picking dates from calendar ---------- */
function onPickDate(d){
  const iso = fmtYMD(d);

  if(state.tab === "add"){
    $("#startDate").value = iso;
    state.startDate = d;
    // auto-calc for convenience
    calcAdd().catch(err => setStatus(err.message));
  }else{
    if(state.pickMode === "from"){
      $("#fromDate").value = iso;
      state.fromDate = d;
    }else{
      $("#toDate").value = iso;
      state.toDate = d;
    }
    // only refresh highlights (calc after user hits calc)
    renderCalendar();
  }
}

/* ---------- Add mode calculation ---------- */
function setSummaryAdd(main, meta){
  $("#summaryAdd .summary-main").textContent = main;
  $("#summaryAdd .summary-meta").textContent = meta;
}

function addExplainItem(left, right, badgeClass, badgeText){
  state.explainItems.push({ left, right, badgeClass, badgeText });
}

function renderExplain(){
  const box = $("#explainBox");
  const list = $("#explainList");
  box.hidden = !state.explainOpen;

  if(!state.explainOpen) return;

  list.innerHTML = "";
  const items = state.explainItems.slice(-60).reverse();
  for(const it of items){
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div style="font-weight:900;">${it.left}</div>
        <div style="color:#6B7280; font-size:12px; margin-top:2px;">${it.right}</div>
      </div>
      <div class="badge ${it.badgeClass}">${it.badgeText}</div>
    `;
    list.appendChild(row);
  }
}

async function calcAdd(){
  const start = parseISO($("#startDate").value);
  const n = Number($("#daysToAdd").value);
  const dayType = $("#dayType").value; // calendar / business
  const countMode = $("#countMode").value; // include / next
  const outOfRange = $("#outOfRange").value; // fallback / block

  state.explainItems = [];

  if(!start){ setSummaryAdd("—", "請選擇起始日期"); return; }
  if(!Number.isFinite(n) || n < 0){ setSummaryAdd("—", "天數需為 0 以上整數"); return; }
  if(n === 0){
    state.startDate = start;
    state.dueDate = start;
    setSummaryAdd(fmtYMD(start), "天數為 0：結果日期等於起始日期");
    // keep calendar on the month of start
    state.calYear = start.getFullYear();
    state.calMonth = start.getMonth();
    await ensureMonthData();
    return;
  }

  state.startDate = start;

  // ensure year map for start year and possible later years
  await ensureYearMap(start.getFullYear(), outOfRange);

  let due = null;

  if(dayType === "calendar"){
    due = addDays(start, countMode === "include" ? (n-1) : n);
    // ensure due year for holiday labels
    await ensureYearMap(due.getFullYear(), outOfRange);

    const info = getInfo(due);
    const hol = info?.isHoliday === true ? "假日" : "工作日";
    const cap = info?.caption ? `（${info.caption}）` : "";
    setSummaryAdd(fmtYMD(due), `${n} 個日曆天｜${countMode==="include"?"含當日":"次一日"}｜${hol}${cap}`);
  }else{
    let cur = new Date(start);
    if(countMode === "next") cur = addDays(cur, 1);

    let count = 0;

    while(true){
      await ensureYearMap(cur.getFullYear(), outOfRange);

      const info = getInfo(cur);
      const cap = info?.caption || "";
      const apiHol = info?.isHoliday;

      let label = "";
      let badgeClass = "";
      let badgeText = "";

      const business = isBusinessDay(cur, outOfRange);
      if(business){
        count++;
        label = `計入第 ${count} 個工作天`;
        badgeClass = "count";
        badgeText = "計入";
      }else{
        label = "跳過（非工作天）";
        badgeClass = "skip";
        badgeText = "跳過";
      }

      const left = `${fmtYMD(cur)}（${["日","一","二","三","四","五","六"][cur.getDay()]}）`;
      const right = [
        cap ? cap : (apiHol===true ? "假日" : apiHol===false ? "工作日" : (isWeekend(cur) ? "週末" : "平日")),
        isWeekend(cur) && apiHol===false ? "補班" : ""
      ].filter(Boolean).join(" · ");

      if(apiHol === true){
        badgeClass = "hol"; badgeText = "假日";
      }else if(isWeekend(cur) && apiHol === false){
        badgeClass = "makeup"; badgeText = "補班";
      }

      addExplainItem(left, `${label}｜${right}`, badgeClass, badgeText);

      if(count === n){
        due = cur;
        break;
      }
      cur = addDays(cur, 1);

      // safety
      if(count > 5000) throw new Error("計算異常（迴圈過長）");
    }

    state.dueDate = due;

    const dueInfo = getInfo(due);
    const cap = dueInfo?.caption ? `（${dueInfo.caption}）` : "";
    const hol = dueInfo?.isHoliday === true ? "假日" : "工作日";
    setSummaryAdd(fmtYMD(due), `${n} 個工作天｜${countMode==="include"?"含當日":"次一日"}｜到期日為${hol}${cap}`);
  }

  state.dueDate = due;

  // move calendar view to due month for visibility
  state.calYear = due.getFullYear();
  state.calMonth = due.getMonth();
  await ensureMonthData();

  renderExplain();
}

/* ---------- Diff mode calculation ---------- */
function setSummaryDiff(main, meta){
  $("#summaryDiff .summary-main").textContent = main;
  $("#summaryDiff .summary-meta").textContent = meta;
}

async function calcDiff(){
  const from = parseISO($("#fromDate").value);
  const to = parseISO($("#toDate").value);
  const incStart = $("#diffIncludeStart").value === "yes";
  const incEnd = $("#diffIncludeEnd").value === "yes";
  const outOfRange = $("#outOfRangeDiff").value;

  if(!from || !to){ setSummaryDiff("—", "請選擇起迄日期"); return; }

  state.fromDate = from;
  state.toDate = to;

  const dir = from <= to ? 1 : -1;
  const start = dir === 1 ? from : to;
  const end = dir === 1 ? to : from;

  // Calendar days difference (inclusive options)
  const msPerDay = 86400000;
  let days = Math.round((end - start) / msPerDay);
  if(incStart) days += 1;
  if(!incEnd) days -= 1;
  if(days < 0) days = 0;

  // Ensure year maps for range
  // If block mode and any year out of range => error
  const years = [];
  for(let y = start.getFullYear(); y <= end.getFullYear(); y++){
    years.push(y);
  }
  for(const y of years){
    await ensureYearMap(y, outOfRange);
  }

  // Business days count
  let bdays = 0;
  let cur = new Date(start);
  cur.setHours(0,0,0,0);

  while(cur <= end){
    const isStart = sameDay(cur, start);
    const isEnd = sameDay(cur, end);

    const includeThis = (!isStart || incStart) && (!isEnd || incEnd);
    if(includeThis){
      if(isBusinessDay(cur, outOfRange)) bdays++;
    }
    cur = addDays(cur, 1);
  }

  const meta = `${fmtYMD(start)} ~ ${fmtYMD(end)}｜${incStart?"含起":"不含起"}｜${incEnd?"含迄":"不含迄"}`;
  setSummaryDiff(`日曆天 ${days} 天 · 工作天 ${bdays} 天`, meta);

  // show range endpoints on calendar
  // Put calendar on end month for clarity
  state.calYear = end.getFullYear();
  state.calMonth = end.getMonth();
  await ensureMonthData();
}

/* ---------- UI wiring ---------- */
function setTab(tab){
  state.tab = tab;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  $(`#panel-${tab}`).classList.add("active");

  // refresh month data using correct outOfRange mode
  ensureMonthData().catch(e => setStatus(e.message));
}

function setPickMode(mode){
  state.pickMode = mode;
  $("#pickFrom").classList.toggle("active", mode === "from");
  $("#pickTo").classList.toggle("active", mode === "to");
}

function resetAll(){
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

  ensureMonthData().catch(e => setStatus(e.message));
}

function init(){
  // Tabs
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  // Month nav
  $("#prevMonth").addEventListener("click", async () => {
    state.calMonth -= 1;
    if(state.calMonth < 0){ state.calMonth = 11; state.calYear -= 1; }
    await ensureMonthData();
  });
  $("#nextMonth").addEventListener("click", async () => {
    state.calMonth += 1;
    if(state.calMonth > 11){ state.calMonth = 0; state.calYear += 1; }
    await ensureMonthData();
  });

  // Buttons
  $("#btnCalcAdd").addEventListener("click", () => calcAdd().catch(e => setStatus(e.message)));
  $("#btnCalcDiff").addEventListener("click", () => calcDiff().catch(e => setStatus(e.message)));
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
    if(state.tab === "add"){
      $("#startDate").value = t;
      state.startDate = parseISO(t);
      calcAdd().catch(e => setStatus(e.message));
    }else{
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

  // Inputs: when changed, refresh highlight & optionally calc
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

  // Init default
  resetAll();
}

init();