// 預約被擋下來（衝突／鎖定）時的回覆內容。
// 獨立成一個模組（不碰 Discord client），方便單獨測試。
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getConfirmedBookingsByDate, getSummaryPages } from "./db.js";
import { findNearestFreeTimes, SUGGEST_MIN_LEAD_MINUTES } from "./booking-rules.js";
import {
  chunkBookingsForSummary,
  formatDateLabel,
  getBookingDateToday,
  getCurrentTimeMinutes,
  minutesToTime,
  timeToMinutes,
} from "./format.js";

// 預約被擋下來（衝突／鎖定）時的回覆：原本的說明文字 + 最近的空檔建議 + 直接跳到當天班表的連結按鈕。
// 班表可能分好幾頁，連結會指到「想預約的那個時間」所在的那一頁
export function buildSlotReply(guildId, summaryRow, minutes, text) {
  const bookingDate = summaryRow.booking_date;
  let content = text;

  try {
    // 今天：建議的時間要比現在晚至少 SUGGEST_MIN_LEAD_MINUTES 分鐘（往前、往後兩側都套用）
    const isToday = bookingDate === getBookingDateToday();
    const notBefore = isToday ? getCurrentTimeMinutes() + SUGGEST_MIN_LEAD_MINUTES : 0;
    const { before, after } = findNearestFreeTimes(guildId, bookingDate, minutes, { notBefore });
    const free = [before, after].filter((m) => m !== null).map(minutesToTime);
    if (free.length) content += `\n💡 最近的空檔：${free.join("、")}`;
    else if (isToday) content += "\n💡 今天剩下的時段已經沒有空檔了，可以改約其他日期。";
  } catch (err) {
    console.warn("計算最近空檔失敗：", err.message);
  }

  const reply = { content };
  try {
    const bookings = getConfirmedBookingsByDate(guildId, bookingDate);
    const pages = chunkBookingsForSummary(bookings);
    let pageIndex = pages.findIndex((page) => {
      const last = page[page.length - 1];
      return last && timeToMinutes(last.scheduled_time) >= minutes;
    });
    if (pageIndex < 0) pageIndex = pages.length - 1;

    const pageRow = pageIndex > 0 ? getSummaryPages(guildId, bookingDate).find((p) => p.page_index === pageIndex) : null;
    const targetMessageId = pageRow?.message_id || summaryRow.message_id;
    const url = `https://discord.com/channels/${guildId}/${summaryRow.channel_id}/${targetMessageId}`;
    reply.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`查看 ${formatDateLabel(bookingDate)} 行程表`).setURL(url)
      ),
    ];
  } catch (err) {
    console.warn("產生班表連結失敗：", err.message);
  }
  return reply;
}
