const el = (id) => document.getElementById(id);

const state = {
  manifest: null,
  cache: new Map(),      // `${year}_${sex}` -> json
  peakCache: new Map(),  // `${year}_${sex}` -> { [event]: minSeconds }
  runTimer: null,
  activeTarget: null     // null | "peakM" | "peakF" | "ageM" | "ageF" | "custom"
};

function parseTimeToSeconds(s) {
  s = String(s).trim();
  if (!s) return NaN;
  const parts = s.split(":").map(x => x.trim());
  if (parts.length === 2) return (Number(parts[0]) * 60) + Number(parts[1]);
  if (parts.length === 3) return (Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2]);
  return NaN;
}

function secondsToTime(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = (s % 60);
  const ssStr = String(ss).padStart(2, "0");
  const mmStr = hh > 0 ? String(mm).padStart(2, "0") : String(mm);
  return hh > 0 ? `${hh}:${mmStr}:${ssStr}` : `${mmStr}:${ssStr}`;
}

function formatInputTime(raw) {
  const sec = parseTimeToSeconds(raw);
  if (!isFinite(sec) || sec <= 0) return "—";
  return secondsToTime(sec);
}

async function loadManifest() {
  if (state.manifest) return state.manifest;
  const res = await fetch("age_grade_standards/manifest.json");
  if (!res.ok) throw new Error("Failed to load age_grade_standards/manifest.json");
  state.manifest = await res.json();
  return state.manifest;
}

function getSelectedSetEntry() {
  const idx = Number(el("setPick").value);
  const entry = state.manifest?.sets?.[idx];
  if (!entry) throw new Error("Selected standards set not found in manifest");
  return entry;
}

async function loadStandards(entry, sex) {
  const sexKey = sex === "M" ? "male" : "female";
  const url = `${entry.base}/${entry[sexKey]}`;
  const cacheKey = `${entry.year}_${sex}`;

  if (state.cache.has(cacheKey)) return state.cache.get(cacheKey);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  const json = await res.json();
  state.cache.set(cacheKey, json);
  return json;
}

function getTable(json) {
  if (json.AgeStdSec?.standards_seconds) return json.AgeStdSec;
  if (json.AgeStdHMS?.standards_seconds) return json.AgeStdHMS;
  throw new Error("No usable standards table found in JSON");
}

function getStandardSeconds(table, event, age) {
  const m = table.standards_seconds?.[event];
  if (!m) return null;
  return m[String(age)] ?? null;
}

function computePeak(table) {
  const peak = {};
  for (const event of table.events) {
    let best = Infinity;
    const m = table.standards_seconds[event];
    for (const a of Object.keys(m)) {
      const v = m[a];
      if (typeof v === "number" && v > 0 && v < best) best = v;
    }
    peak[event] = isFinite(best) ? best : null;
  }
  return peak;
}

function getPeak(cacheKey, table) {
  if (!state.peakCache.has(cacheKey)) state.peakCache.set(cacheKey, computePeak(table));
  return state.peakCache.get(cacheKey);
}

function sexLabel(sex) { return sex === "M" ? "Male" : "Female"; }
function otherSex(sex) { return sex === "M" ? "F" : "M"; }

function scheduleRun(delayMs = 0) {
  if (state.runTimer) clearTimeout(state.runTimer);
  state.runTimer = setTimeout(runLive, delayMs);
}

function clampAge(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 5) return 5;
  if (n > 110) return 110;
  return Math.round(n);
}

function getAge() {
  const raw = String(el("agePick").value || "").trim();
  const n = Number(raw);
  return clampAge(n);
}

function updateAgeButtons() {
  const age = String(el("agePick").value || "").trim() || "—";
  el("ageLabelM").textContent = age;
  el("ageLabelF").textContent = age;
}

function setAgeGradeUI({ gradePct, note, sex, event, otherGenderTime, peakSameTime, peakOtherTime }) {
  const sLabel = sexLabel(sex);
  const oLabel = sexLabel(otherSex(sex));
  const ev = event ? ` ${event}` : "";

  el("ageGradeOut").textContent = gradePct ?? "—";
  el("ageGradeNote").textContent = note ?? "";

  el("otherGenderLabel").textContent = `Equivalent ${oLabel}${ev} Time`;
  el("peakTimeLabel").textContent = `Equivalent Peak Age ${sLabel}${ev} Time`;
  el("peakOtherGenderLabel").textContent = `Equivalent Peak Age ${oLabel}${ev} Time`;

  el("otherGenderTime").textContent = otherGenderTime ?? "—";
  el("peakTime").textContent = peakSameTime ?? "—";
  el("peakOtherGenderTime").textContent = peakOtherTime ?? "—";
}

function section(title, rows) {
  const div = document.createElement("div");
  div.className = "resultSection";

  const h = document.createElement("h3");
  h.textContent = title;
  div.appendChild(h);

  const wrap = document.createElement("div");
  wrap.className = "resultTableWrap";

  const table = document.createElement("table");

  // ✅ header row
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const th1 = document.createElement("th");
  const th2 = document.createElement("th");
  th1.textContent = "Distance / Event";
  th2.textContent = "Equivalent Time";
  hr.appendChild(th1);
  hr.appendChild(th2);
  thead.appendChild(hr);
  table.appendChild(thead);

  const tb = document.createElement("tbody");

  for (const r of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    const td2 = document.createElement("td");
    td1.textContent = r.event;
    td2.textContent = r.time;
    tr.appendChild(td1);
    tr.appendChild(td2);
    tb.appendChild(tr);
  }

  table.appendChild(tb);
  wrap.appendChild(table);
  div.appendChild(wrap);

  return div;
}

function setActiveTarget(targetOrNull) {
  state.activeTarget = targetOrNull;

  document.querySelectorAll(".targetBtn").forEach(btn => {
    const t = btn.dataset.target;
    btn.classList.toggle("is-active", t === state.activeTarget);
    btn.setAttribute("aria-pressed", t === state.activeTarget ? "true" : "false");
  });

  el("customRow").hidden = (state.activeTarget !== "custom");

  /* ✅ show divider only when a target is active */
  const divider = document.querySelector(".targetsDivider");
  if (divider) {
    divider.style.display = state.activeTarget ? "block" : "none";
  }

  if (!state.activeTarget) el("results").innerHTML = "";
  scheduleRun(0);
}

async function refreshSetPick() {
  const manifest = await loadManifest();
  const pick = el("setPick");
  pick.innerHTML = "";

  manifest.sets.forEach((entry, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = entry.label;
    pick.appendChild(opt);
  });

  if (manifest.sets.length) pick.value = String(manifest.sets.length - 1);
}

function pickDefaultEvent(pick) {
  const preferred = ["5 km", "5k", "5K", "parkrun"]; // try common variants
  for (const p of preferred) {
    const opt = Array.from(pick.options).find(o => o.value === p || o.textContent === p);
    if (opt) { pick.value = opt.value; return true; }
  }
  // fallback: first option
  if (pick.options.length) { pick.value = pick.options[0].value; return true; }
  return false;
}

async function refreshEvents() {
  const entry = getSelectedSetEntry();
  const sex = el("sexPick").value;

  const json = await loadStandards(entry, sex);
  const table = getTable(json);

  const pick = el("eventPick");
  const prev = pick.value;

  pick.innerHTML = "";
  for (const ev of table.events) {
    const opt = document.createElement("option");
    opt.value = ev;
    opt.textContent = ev;
    pick.appendChild(opt);
  }

  // Keep previous selection if possible; else default to 5k
  if (prev && Array.from(pick.options).some(o => o.value === prev)) {
    pick.value = prev;
  } else {
    pickDefaultEvent(pick);
  }
}

async function computeContext() {
  const entry = getSelectedSetEntry();
  const sex = el("sexPick").value;
  const os = otherSex(sex);

  const age = getAge();
  const event = el("eventPick").value;
  const tSec = parseTimeToSeconds(el("timePick").value);

  const json = await loadStandards(entry, sex);
  const table = getTable(json);
  const std = (age != null) ? getStandardSeconds(table, event, age) : null;

  const jsonM = await loadStandards(entry, "M");
  const jsonF = await loadStandards(entry, "F");
  const tableM = getTable(jsonM);
  const tableF = getTable(jsonF);

  const peakM = getPeak(`${entry.year}_M`, tableM);
  const peakF = getPeak(`${entry.year}_F`, tableF);

  return { entry, sex, os, age, event, tSec, table, std, tableM, tableF, peakM, peakF };
}

async function runLive() {
  updateAgeButtons();

  const resultsEl = el("results");

  const sex = el("sexPick").value;
  const eventNow = el("eventPick")?.value || "";
  
  setAgeGradeUI({
    gradePct: "—",
    note: "Enter a valid time to calculate.",
    sex,
    event: eventNow,
    otherGenderTime: "—",
    peakSameTime: "—",
    peakOtherTime: "—"
  });

  let ctx;
  try {
    ctx = await computeContext();
  } catch {
    return;
  }

  const { entry, age, event, tSec, sex: s, os, table, std, tableM, tableF, peakM, peakF } = ctx;

  if (!isFinite(tSec) || tSec <= 0) {
    if (!state.activeTarget) resultsEl.innerHTML = "";
    return;
  }

  if (age == null) {
    setAgeGradeUI({
      gradePct: "—",
      note: "Enter a valid age to calculate.",
      sex: s,
      event,
      otherGenderTime: "—",
      peakSameTime: "—",
      peakOtherTime: "—"
    });
    if (!state.activeTarget) resultsEl.innerHTML = "";
    return;
  }

  if (!std) {
    setAgeGradeUI({
      gradePct: "—",
      note: "That age/event doesn’t exist in this standards set.",
      sex: s,
      event,
      otherGenderTime: "—",
      peakSameTime: "—",
      peakOtherTime: "—"
    });
    if (!state.activeTarget) resultsEl.innerHTML = "";
    return;
  }

  const p = std / tSec;
  const ageGradePct = p * 100;

  // headline times for selected event
  const tableOther = (os === "M") ? tableM : tableF;
  const peakSame = (s === "M") ? peakM : peakF;
  const peakOther = (os === "M") ? peakM : peakF;

  const otherStdSameAge = getStandardSeconds(tableOther, event, age);
  const peakStdSameSex = peakSame[event];
  const peakStdOtherSex = peakOther[event];

  setAgeGradeUI({
    gradePct: `${ageGradePct.toFixed(2)}%`,
    note: `${formatInputTime(el("timePick").value)} ${event}, ${sexLabel(s)}, Age ${age}, WMA ${entry.label}`,
    sex: s,
    event,
    otherGenderTime: otherStdSameAge ? secondsToTime(otherStdSameAge / p) : "—",
    peakSameTime: peakStdSameSex ? secondsToTime(peakStdSameSex / p) : "—",
    peakOtherTime: peakStdOtherSex ? secondsToTime(peakStdOtherSex / p) : "—"
  });

  if (!state.activeTarget) {
    resultsEl.innerHTML = "";
    return;
  }

  resultsEl.innerHTML = "";

  if (state.activeTarget === "peakM") {
    const rows = tableM.events.map(ev => {
      const s2 = peakM[ev];
      return { event: ev, time: s2 ? secondsToTime(s2 / p) : "—" };
    });
    resultsEl.appendChild(section("Peak Age Male Equivalents", rows));
    return;
  }

  if (state.activeTarget === "peakF") {
    const rows = tableF.events.map(ev => {
      const s2 = peakF[ev];
      return { event: ev, time: s2 ? secondsToTime(s2 / p) : "—" };
    });
    resultsEl.appendChild(section("Peak Age Female Equivalents", rows));
    return;
  }

  if (state.activeTarget === "ageM") {
    const rows = tableM.events.map(ev => {
      const s2 = getStandardSeconds(tableM, ev, age);
      return { event: ev, time: s2 ? secondsToTime(s2 / p) : "—" };
    });
    resultsEl.appendChild(section(`Age ${age} Male Equivalents`, rows));
    return;
  }

  if (state.activeTarget === "ageF") {
    const rows = tableF.events.map(ev => {
      const s2 = getStandardSeconds(tableF, ev, age);
      return { event: ev, time: s2 ? secondsToTime(s2 / p) : "—" };
    });
    resultsEl.appendChild(section(`Age ${age} Female Equivalents`, rows));
    return;
  }

  if (state.activeTarget === "custom") {
    const cSex = el("customSex").value;
    const cAge = clampAge(Number(el("customAge").value));

    const jsonC = await loadStandards(entry, cSex);
    const tableC = getTable(jsonC);

    const rows = tableC.events.map(ev => {
      const s2 = (cAge != null) ? getStandardSeconds(tableC, ev, cAge) : null;
      return { event: ev, time: s2 ? secondsToTime(s2 / p) : "—" };
    });

    resultsEl.appendChild(section(`Custom Target (${sexLabel(cSex)}, age ${cAge ?? "—"})`, rows));
  }
}

function wire() {
  document.querySelectorAll(".targetBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.target;
      setActiveTarget(state.activeTarget === t ? null : t);
    });
  });

  el("setPick").addEventListener("change", async () => {
    await refreshEvents();
    scheduleRun(0);
  });

  el("sexPick").addEventListener("change", async () => {
    await refreshEvents();
    scheduleRun(0);
  });

  el("agePick").addEventListener("input", () => scheduleRun(0));
  el("eventPick").addEventListener("change", () => scheduleRun(0));
  el("timePick").addEventListener("input", () => scheduleRun(120));

  el("customSex").addEventListener("change", () => scheduleRun(0));
  el("customAge").addEventListener("input", () => scheduleRun(0));
}

(async function init() {
  await loadManifest();
  await refreshSetPick();
  await refreshEvents();
  wire();

  setActiveTarget(null);
  scheduleRun(0);
})();
