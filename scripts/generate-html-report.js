// 產生一份「靜態」的互動式 HTML 報告檢視器（reports/report.html）
// 這支腳本只需要跑一次（或想改樣式時再跑），之後不需要每週重跑——
// report.html 本身在瀏覽器打開時，會用 fetch() 動態讀取同資料夾裡的 all-reports.json，
// 永遠反映 reports/ 資料夾目前的最新內容（all-reports.json 由 saveReport() 自動維護）
//
// 用法：node scripts/generate-html-report.js

import fs from "node:fs";
import path from "node:path";

const REPORTS_DIR = path.join(process.cwd(), "reports");
const OUTPUT_PATH = path.join(REPORTS_DIR, "report.html");

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<title>預約週報告</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
  body { font-family: -apple-system, "Microsoft JhengHei", sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; }
  h2 { font-size: 17px; margin-top: 36px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  select { font-size: 15px; padding: 8px 12px; margin: 12px 0 24px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
  th { background: #f5f5f5; }
  .warn { color: #b45309; font-size: 12px; }
  .chart-wrap { position: relative; height: 260px; margin: 20px 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
  .metric { background: #f7f7f5; border-radius: 8px; padding: 12px 14px; }
  .metric .label { font-size: 12px; color: #666; }
  .metric .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
  .metric .delta { font-size: 13px; margin-top: 2px; }
  .up { color: #1baf7a; }
  .down { color: #e34948; }
  .muted { color: #666; font-size: 13px; }
  #loadError { color: #e34948; display: none; }
</style>
</head>
<body>

<h1>📊 預約統計週報告</h1>
<p class="muted" id="generatedAt"></p>
<p id="loadError">找不到 all-reports.json，請先跑過至少一次 <code>node scripts/generate-weekly-report.js</code>。</p>

<div id="reportRoot" style="display:none;">
  <label for="weekSelect"><strong>選擇要查看的週：</strong></label><br/>
  <select id="weekSelect"></select>

  <div id="incompleteWarning" class="warn" style="display:none;"></div>

  <h2>總覽指標</h2>
  <div class="grid4" id="metricCards"></div>

  <h2>逐日場次（本週 vs 上週，依星期對齊）</h2>
  <div class="chart-wrap"><canvas id="dailyChart"></canvas></div>

  <h2>時段分佈（本週 vs 上週）</h2>
  <div class="chart-wrap"><canvas id="hourChart"></canvas></div>

  <h2>地圖分佈</h2>
  <div class="grid2">
    <div class="chart-wrap"><canvas id="locChartCurrent"></canvas></div>
    <div class="chart-wrap"><canvas id="locChartPrev"></canvas></div>
  </div>

  <h2>所有週總覽</h2>
  <table id="overviewTable"></table>
</div>

<script>
const weekdayNames = ["週四","週五","週六","週日","週一","週二","週三"];
const blue = "#2a78d6";
const grayLight = "rgba(176,176,176,0.4)";
const locationColorMap = { "龍王": "#2a78d6", "蝴蝶": "#eb6834", "道場": "#898781", "其他": "#1baf7a" };
const fallbackColors = ["#e87ba4", "#4a3aa7", "#eda100"];
function getLocationColor(label, fallbackIndex) {
  return locationColorMap[label] || fallbackColors[fallbackIndex % fallbackColors.length];
}

let dailyChart, hourChart, locChartCurrent, locChartPrev, reports = [];

function fmtPct(n) { return (n * 100).toFixed(1) + "%"; }

function deltaHtml(curr, prev, formatter, higherIsBetter = true) {
  if (prev === null || prev === undefined) return '<div class="delta muted">（無上週資料可比較）</div>';
  const diff = curr - prev;
  if (diff === 0) return '<div class="delta muted">與上週持平</div>';
  const positive = higherIsBetter ? diff > 0 : diff < 0;
  const cls = positive ? "up" : "down";
  const sign = diff > 0 ? "+" : "";
  return '<div class="delta ' + cls + '">' + sign + formatter(diff) + ' 較上週</div>';
}

function render(index) {
  const current = reports[index];
  const prev = index > 0 ? reports[index - 1] : null;

  const warnEl = document.getElementById("incompleteWarning");
  if (current.daysWithData < 7) {
    warnEl.style.display = "block";
    warnEl.textContent = "⚠️ 這週資料還不完整（僅 " + current.daysWithData + "/7 天），以下數字僅供參考";
  } else {
    warnEl.style.display = "none";
  }

  document.getElementById("metricCards").innerHTML = [
    { label: "總場次", value: current.totalConfirmed, delta: deltaHtml(current.totalConfirmed, prev && prev.totalConfirmed, (d) => Math.abs(d) + " 場") },
    { label: "取消數", value: current.totalCancelled, delta: deltaHtml(current.totalCancelled, prev && prev.totalCancelled, (d) => Math.abs(d) + " 場", false) },
    { label: "代約比例", value: fmtPct(current.proxyRatio), delta: deltaHtml(current.proxyRatio, prev && prev.proxyRatio, (d) => Math.abs(d * 100).toFixed(1) + " pp") },
    { label: "有資料天數", value: current.daysWithData + " / 7", delta: "" },
  ].map((m) => '<div class="metric"><div class="label">' + m.label + '</div><div class="value">' + m.value + '</div>' + m.delta + '</div>').join("");

  const currentDaily = Object.values(current.dailyCounts);
  const prevDaily = prev ? Object.values(prev.dailyCounts) : null;
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(document.getElementById("dailyChart"), {
    type: "bar",
    data: {
      labels: weekdayNames,
      datasets: [
        { label: current.weekLabel, data: currentDaily, backgroundColor: blue, borderRadius: 4 },
        ...(prevDaily ? [{ label: prev.weekLabel, data: prevDaily, backgroundColor: grayLight, borderRadius: 4 }] : []),
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top" } } },
  });

  if (hourChart) hourChart.destroy();
  hourChart = new Chart(document.getElementById("hourChart"), {
    type: "bar",
    data: {
      labels: current.hourlyCounts.map((_, h) => h + ":00"),
      datasets: [
        { label: current.weekLabel, data: current.hourlyCounts, backgroundColor: blue, borderRadius: 3 },
        ...(prev ? [{ label: prev.weekLabel, data: prev.hourlyCounts, backgroundColor: grayLight, borderRadius: 3 }] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top" } },
      scales: { x: { ticks: { autoSkip: false, maxRotation: 90, font: { size: 9 } } } },
    },
  });

  const currLocLabels = Object.keys(current.locationCounts);
  if (locChartCurrent) locChartCurrent.destroy();
  locChartCurrent = new Chart(document.getElementById("locChartCurrent"), {
    type: "doughnut",
    data: { labels: currLocLabels, datasets: [{ data: currLocLabels.map((l) => current.locationCounts[l]), backgroundColor: currLocLabels.map(getLocationColor) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, title: { display: true, text: "本週：" + current.weekLabel } } },
  });

  if (locChartPrev) locChartPrev.destroy();
  if (prev) {
    const prevLocLabels = Object.keys(prev.locationCounts);
    locChartPrev = new Chart(document.getElementById("locChartPrev"), {
      type: "doughnut",
      data: { labels: prevLocLabels, datasets: [{ data: prevLocLabels.map((l) => prev.locationCounts[l]), backgroundColor: prevLocLabels.map(getLocationColor) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, title: { display: true, text: "上週：" + prev.weekLabel } } },
    });
  }
}

async function init() {
  let data;
  try {
    const res = await fetch("all-reports.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (err) {
    document.getElementById("loadError").style.display = "block";
    return;
  }

  if (!data.length) {
    document.getElementById("loadError").style.display = "block";
    return;
  }

  reports = data;
  document.getElementById("reportRoot").style.display = "block";
  document.getElementById("generatedAt").textContent =
    "頁面載入時間：" + new Date().toLocaleString("zh-TW") + "（每週定義：週四~下週三，資料即時讀取 all-reports.json）";

  const select = document.getElementById("weekSelect");
  reports.forEach((r, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = r.weekLabel + (r.daysWithData < 7 ? "（資料不完整）" : "") + (i === reports.length - 1 ? "（最新）" : "");
    select.appendChild(opt);
  });
  select.value = reports.length - 1;
  select.addEventListener("change", () => render(Number(select.value)));

  document.getElementById("overviewTable").innerHTML =
    "<tr><th>週次</th><th>總場次</th><th>取消</th><th>代約比例</th><th>有資料天數</th></tr>" +
    reports.map((r) =>
      "<tr><td>" + r.weekLabel + "</td><td>" + r.totalConfirmed + "</td><td>" + r.totalCancelled + "</td><td>" +
      fmtPct(r.proxyRatio) + "</td><td>" + r.daysWithData + " / 7 " +
      (r.daysWithData < 7 ? '<span class="warn">⚠️ 不完整</span>' : "") + "</td></tr>"
    ).join("");

  render(reports.length - 1);
}

init();
</script>

</body>
</html>
`;

fs.writeFileSync(OUTPUT_PATH, html, "utf-8");
console.log(`已產生靜態 HTML 報告檢視器：${OUTPUT_PATH}`);
console.log(`這支腳本之後不用每週重跑，report.html 打開時會自動讀取最新的 all-reports.json。`);