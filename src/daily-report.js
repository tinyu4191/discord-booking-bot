// 每日預約總結日報：統計 + 版面
//
// collectDailyStats  純計算（輸入預約清單，輸出統計），不碰資料庫、不碰 Discord，方便測試
// buildDailyReportEmbed  把統計排成一張 embed
// getDailyStats  從資料庫讀出某個語音群、某一天的資料，再算統計
//
// 目前只用在試作指令（見 daily-report-demo.js）。確認版面之後，正式版會在「鎖定過期討論串」的同時發到日報頻道。

import { EmbedBuilder } from "discord.js";
import { getBlockedSlotsByDate, getCancelledBookingsByDate, getConfirmedBookingsByDate } from "./db.js";
import { formatDateLabel, getLocationEmoji, getWeekdayLabel, minutesToTime, timeToMinutes } from "./format.js";

const BUCKET_HOURS = 3; // 時段熱度：每 3 小時一格，一天 8 格
const BAR_WIDTH = 10;
const MAX_LOCATION_ROWS = 6;
const REPORT_COLOR = 0x1abc9c;

// 續約自動新增的預約，message_id 是 "renew-<提醒編號>"（沒有對應的真實留言）
const isRenewed = (b) => String(b?.message_id || "").startsWith("renew-");

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------
export function collectDailyStats({ confirmed, cancelled = [], blockedSlots = [] }) {
  const byLocation = new Map();
  const byBooker = new Map();
  const hourCounts = new Array(24).fill(0);
  const times = [];

  for (const b of confirmed) {
    byLocation.set(b.location, (byLocation.get(b.location) || 0) + 1);
    if (b.booker_id) byBooker.set(b.booker_id, (byBooker.get(b.booker_id) || 0) + 1);
    const m = timeToMinutes(b.scheduled_time);
    if (m !== null) {
      hourCounts[Math.floor(m / 60)]++;
      times.push(m);
    }
  }

  const hourBuckets = [];
  for (let start = 0; start < 24; start += BUCKET_HOURS) {
    const end = start + BUCKET_HOURS;
    hourBuckets.push({
      label: `${String(start).padStart(2, "0")}–${String(end % 24 === 0 ? 24 : end).padStart(2, "0")}`,
      count: hourCounts.slice(start, end).reduce((a, c) => a + c, 0),
    });
  }

  let peak = null;
  hourCounts.forEach((count, hour) => {
    if (count > 0 && (!peak || count > peak.count)) peak = { hour, count };
  });

  const blockedItems = blockedSlots
    .map((s) => ({ start: s.start_time, end: s.end_time, reason: s.reason || "" }))
    .sort((a, b) => (timeToMinutes(a.start) ?? 0) - (timeToMinutes(b.start) ?? 0));
  const blockedMinutes = blockedItems.reduce((sum, s) => {
    const a = timeToMinutes(s.start);
    const b = timeToMinutes(s.end);
    return a === null || b === null ? sum : sum + Math.max(0, b - a);
  }, 0);

  return {
    total: confirmed.length,
    cancelled: cancelled.length,
    uniqueBookers: byBooker.size,
    proxyCount: confirmed.filter((b) => b.proxy_for).length,
    renewedCount: confirmed.filter(isRenewed).length,
    byLocation: [...byLocation.entries()].map(([location, count]) => ({ location, count })).sort((a, b) => b.count - a.count || a.location.localeCompare(b.location)),
    hourBuckets,
    peak,
    topBookers: [...byBooker.entries()]
      .map(([bookerId, count]) => ({ bookerId, count }))
      .sort((a, b) => b.count - a.count || String(a.bookerId).localeCompare(String(b.bookerId)))
      .slice(0, 3),
    blocked: { count: blockedItems.length, minutes: blockedMinutes, items: blockedItems },
    first: times.length ? minutesToTime(Math.min(...times)) : null,
    last: times.length ? minutesToTime(Math.max(...times)) : null,
  };
}

// 從資料庫讀出某天的資料再算統計（已取消的預約是 status = 'cancelled' 的那些；被使用者刪掉留言的預約不會留下紀錄）
export function getDailyStats(guildId, bookingDate) {
  return collectDailyStats({
    confirmed: getConfirmedBookingsByDate(guildId, bookingDate),
    cancelled: getCancelledBookingsByDate(guildId, bookingDate),
    blockedSlots: getBlockedSlotsByDate(guildId, bookingDate),
  });
}

// ---------------------------------------------------------------------------
// 版面
// ---------------------------------------------------------------------------

function heatmapBlock(buckets) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const countWidth = String(max).length;
  const rows = buckets.map((b) => {
    const filled = b.count === 0 ? 0 : Math.max(1, Math.round((b.count / max) * BAR_WIDTH));
    return `${b.label} ${"█".repeat(filled)}${"·".repeat(BAR_WIDTH - filled)} ${String(b.count).padStart(countWidth)}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

// formatBooker：把預約人 id 轉成顯示文字（預設是 Discord 的 @提及，在 embed 裡只會顯示名字、不會真的通知人）
export function buildDailyReportEmbed(bookingDate, stats, { formatBooker = (id) => `<@${id}>`, demo = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle(`📊 ${formatDateLabel(bookingDate)} (${getWeekdayLabel(bookingDate)}) 預約日報`)
    .setFooter({ text: `預約機器人自動產生・統計範圍 00:00–24:00${demo ? "・示範資料" : ""}` });

  if (stats.total === 0) {
    embed.setDescription("這一天沒有預約。");
    return embed;
  }

  const lines = [`共 **${stats.total}** 筆預約　👥 **${stats.uniqueBookers}** 位預約人`];
  if (stats.first) lines.push(`⏱ 最早 **${stats.first}**　最晚 **${stats.last}**`);

  lines.push("## 時段熱度", heatmapBlock(stats.hourBuckets));
  if (stats.peak) {
    const h = String(stats.peak.hour).padStart(2, "0");
    lines.push(`\`尖峰：${h}:00–${h}:59（${stats.peak.count} 筆）\``);
  }

  const shown = stats.byLocation.slice(0, MAX_LOCATION_ROWS);
  const rest = stats.byLocation.slice(MAX_LOCATION_ROWS);
  lines.push("## 地點");
  for (const l of shown) {
    const pct = Math.round((l.count / stats.total) * 100);
    lines.push(`${getLocationEmoji(l.location)} ${l.location}　${l.count} 筆（${pct}%）`);
  }
  if (rest.length) lines.push(`…其他 ${rest.length} 處　${rest.reduce((a, l) => a + l.count, 0)} 筆`);

  if (stats.topBookers.length) {
    lines.push("## 預約最多");
    stats.topBookers.forEach((b, i) => lines.push(`${i + 1}. ${formatBooker(b.bookerId)}　${b.count} 筆`));
  }

  embed.setDescription(lines.join("\n"));
  return embed;
}
