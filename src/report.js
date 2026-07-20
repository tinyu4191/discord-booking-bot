// 週報告產生邏輯：計算某個遊戲週（週四~週三）的統計數據，並存成 JSON 留存
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { addDays, formatDateLabel } from "./format.js";

const REPORTS_DIR = path.join(process.cwd(), "reports");

// 把地點名稱正規化成大分類（"龍王"、"蝴蝶（女王藏身處）" 這種都算同一類）
function normalizeLocation(location) {
  if (location.startsWith("龍王")) return "龍王";
  if (location.startsWith("蝴蝶")) return "蝴蝶";
  if (location.includes("道場")) return "道場"; // 涵蓋「道場」「武陵道場」等變體
  return "其他";
}

// 計算指定週（weekStart 為週四日期 YYYY-MM-DD）的統計數據
export function generateWeeklyReport(weekStart) {
  const weekEnd = addDays(weekStart, 6);

  const confirmed = db
    .prepare(`SELECT * FROM bookings WHERE booking_date >= ? AND booking_date <= ? AND status = 'confirmed'`)
    .all(weekStart, weekEnd);
  const cancelled = db
    .prepare(`SELECT * FROM bookings WHERE booking_date >= ? AND booking_date <= ? AND status = 'cancelled'`)
    .all(weekStart, weekEnd);

  const dailyCounts = {};
  for (let i = 0; i <= 6; i++) {
    dailyCounts[addDays(weekStart, i)] = 0;
  }
  const hourlyCounts = Array(24).fill(0);
  const locationCounts = {};
  let proxyCount = 0;

  for (const b of confirmed) {
    dailyCounts[b.booking_date] = (dailyCounts[b.booking_date] || 0) + 1;

    const hour = Number((b.scheduled_time || "").split(":")[0]);
    if (!Number.isNaN(hour) && hour >= 0 && hour < 24) hourlyCounts[hour]++;

    const loc = normalizeLocation(b.location || "");
    locationCounts[loc] = (locationCounts[loc] || 0) + 1;

    if (b.proxy_for) proxyCount++;
  }

  const daysWithData = new Set(confirmed.map((b) => b.booking_date)).size;

  return {
    weekStart,
    weekEnd,
    weekLabel: `${formatDateLabel(weekStart)}~${formatDateLabel(weekEnd)}`,
    generatedAt: new Date().toISOString(),
    totalConfirmed: confirmed.length,
    totalCancelled: cancelled.length,
    daysWithData, // 這週實際有資料的天數，用來判斷是不是完整週（< 7 代表資料不完整，數字僅供參考）
    dailyCounts,
    hourlyCounts,
    locationCounts,
    proxyCount,
    proxyRatio: confirmed.length ? proxyCount / confirmed.length : 0,
  };
}

export function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, `${report.weekStart}_${report.weekEnd}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  rebuildIndex();
  return filePath;
}

// 重新掃描 reports/ 底下所有週報告，彙整成單一索引檔 all-reports.json，
// 給 report.html 在瀏覽器打開當下用 fetch() 讀取，這樣 HTML 本身完全不用重新產生
function rebuildIndex() {
  const files = listReportFiles();
  const all = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf-8")))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  fs.writeFileSync(path.join(REPORTS_DIR, "all-reports.json"), JSON.stringify(all), "utf-8");
}

export function loadReport(weekStart, weekEnd) {
  const filePath = path.join(REPORTS_DIR, `${weekStart}_${weekEnd}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function listReportFiles() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "all-reports.json")
    .sort();
}