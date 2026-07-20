// 產生（或補產生）某一週的統計報告，存成 JSON 留存在 reports/ 資料夾，並跟上一週比較
//
// 用法：
//   node scripts/generate-weekly-report.js              → 抓「上一個已經結束的完整遊戲週」
//   node scripts/generate-weekly-report.js 2026-07-16   → 指定某週的週四日期，重新產生那週的報告
//
// 遊戲週定義：週四 ~ 下週三（配合遊戲更新時間），跟鎖定時段功能用同一套定義

import "dotenv/config";
import { generateWeeklyReport, saveReport, loadReport } from "../src/report.js";
import { getGameWeekRange, addDays, getBookingDateToday, formatDateLabel } from "../src/format.js";

const arg = process.argv[2];

let weekStart;
if (arg) {
  weekStart = arg;
} else {
  const today = getBookingDateToday();
  const { start: currentWeekStart } = getGameWeekRange(today);
  weekStart = addDays(currentWeekStart, -7); // 上一個完整週
}

const report = generateWeeklyReport(weekStart);
const filePath = saveReport(report);

console.log(`已產生週報告：${filePath}`);
console.log(`本週（${report.weekLabel}）：`);
console.log(`  總場次：${report.totalConfirmed}（取消 ${report.totalCancelled}）`);
console.log(`  代約比例：${(report.proxyRatio * 100).toFixed(1)}%`);
console.log(
  `  有資料的天數：${report.daysWithData} / 7${report.daysWithData < 7 ? "（⚠️ 不是完整週，數字僅供參考，不建議拿來跟其他週比較）" : ""}`
);
console.log(`  地圖分佈：${JSON.stringify(report.locationCounts)}`);

const prevWeekStart = addDays(report.weekStart, -7);
const prevWeekEnd = addDays(report.weekEnd, -7);
const prev = loadReport(prevWeekStart, prevWeekEnd);

if (prev) {
  const diff = report.totalConfirmed - prev.totalConfirmed;
  const diffText = diff > 0 ? `+${diff}` : `${diff}`;
  console.log(`\n跟上一週（${prev.weekLabel}，${prev.totalConfirmed} 場）比較：${diffText} 場`);
  if (prev.daysWithData < 7 || report.daysWithData < 7) {
    console.log("（其中一週資料不完整，這個比較僅供參考）");
  }
} else {
  console.log("\n（找不到上一週的報告，可能是第一次產生，或上一週還沒跑過這支腳本）");
}
