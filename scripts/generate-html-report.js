// 把 reports/ 資料夾裡所有的週報告 JSON，整合成一個互動式的 HTML 報告（reports/report.html）
// 網頁裡可以用下拉選單切換任一週，畫面固定顯示「選到的那週 vs 前一週」的比較
// 用瀏覽器打開即可，不需要另外架網頁伺服器
//
// 用法：node scripts/generate-html-report.js

import fs from "node:fs";
import path from "node:path";
import { listReportFiles } from "../src/report.js";

const REPORTS_DIR = path.join(process.cwd(), "reports");
const OUTPUT_PATH = path.join(REPORTS_DIR, "report.html");

const files = listReportFiles();
if (!files.length) {
  console.error("reports/ 資料夾裡沒有任何週報告，先跑 node scripts/generate-weekly-report.js 產生至少一份。");
  process.exit(1);
}

const reports = files
  .map((f) => JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf-8")))
  .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

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
  .legend { display: flex; gap: 16px; font-size: 12px; color: #555; margin-top: 4px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
</style>
</head>
<body>

<h1>📊 預約統計週報告</h1>
<p class="muted">產生時間：${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Ho_Chi_Minh" })}（每週定義：週四~下週三）</p>

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
<table>
  <tr><th>週次</th><th>總場次</th><th>取消</th><th>代約比例</th><th>有資料天數</th></tr>
  ${reports
    .map(
      (r) => `<tr>
    <td>${r.weekLabel}</td>
    <td>${r.totalConfirmed}</td>
    <td>${r.totalCancelled}</td>
    <td>${(r.proxyRatio * 100).toFixed(1)}%</td>
    <td>${r.daysWithData} / 7 ${r.daysWithData < 7 ? '<span class="warn">⚠️ 不完整</span>' : ""}</td>
  </tr>`
    )
    .join("\n")}
</table>

<script>
const reports = ${JSON.stringify(reports)};
const weekdayNames = ["週四","週五","週六","週日","週一","週二","週三"];
const blue = "#2a78d6";
const blueLight = "rgba(42,120,214,0.4)";
const gray = "#b0b0b0";
const grayLight = "rgba(176,176,176,0.4)";
const colors = ["#2a78d6","#eb6834","#898781","#1baf7a","#e87ba4"];

let dailyChart, hourChart, locChartCurrent, locChartPrev;

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
    data: { labels: currLocLabels, datasets: [{ data: currLocLabels.map((l) => current.locationCounts[l]), backgroundColor: colors }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, title: { display: true, text: "本週：" + current.weekLabel } } },
  });

  if (locChartPrev) locChartPrev.destroy();
  if (prev) {
    const prevLocLabels = Object.keys(prev.locationCounts);
    locChartPrev = new Chart(document.getElementById("locChartPrev"), {
      type: "doughnut",
      data: { labels: prevLocLabels, datasets: [{ data: prevLocLabels.map((l) => prev.locationCounts[l]), backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, title: { display: true, text: "上週：" + prev.weekLabel } } },
    });
  }
}

const select = document.getElementById("weekSelect");
reports.forEach((r, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = r.weekLabel + (r.daysWithData < 7 ? "（資料不完整）" : "") + (i === reports.length - 1 ? "（最新）" : "");
  select.appendChild(opt);
});
select.value = reports.length - 1;
select.addEventListener("change", () => render(Number(select.value)));
render(reports.length - 1);
</script>

</body>
</html>
`;

fs.writeFileSync(OUTPUT_PATH, html, "utf-8");
console.log(`已產生 HTML 報告：${OUTPUT_PATH}`);
console.log(`共整合 ${reports.length} 週的資料，可以用瀏覽器內建的「下載檔案」功能把它抓到本機打開。`);
