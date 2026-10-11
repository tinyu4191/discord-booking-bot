// 每日預約總結日報：定時發送 + 訂閱開關
//
// 發送時機：每天 00:05 的排程（見 index.js）在鎖定過期討論串之後，呼叫 publishPendingReports，
// 把「已鎖定、還沒發過日報」的日子依日期由舊到新各發一份到日報頻道（report_channel_id）。
// - 沒設定 report_channel_id → 完全不發（也不記錄，之後設定好就會開始發）
// - 管理頻道輸入「取消訂閱」→ report_enabled = 0：這些日子記成 skipped，之後恢復訂閱也不會補發
// - 發送成功才記錄 sent；失敗（頻道被刪、沒有權限）不記錄，下次排程或重啟時會再試
// - 機器人停機後重啟，只補最近 REPORT_CATCHUP_DAYS 天，不會把很久以前的歷史一次倒出來

import { addDays, formatDateLabel, getBookingDateToday } from "./format.js";
import { getDailyReportRecord, getLockedSummariesBetween, recordDailyReport, setReportEnabled } from "./db.js";
import { buildDailyReportEmbed, getDailyStats } from "./daily-report.js";

export const REPORT_CATCHUP_DAYS = 3;
const NO_PING = { parse: [] };

// guildSettings：guild_settings 的一列。deps 只給測試用（可注入假的統計函式）
export async function publishPendingReports({ client, guildSettings, logToAdmin = async () => {}, today = getBookingDateToday(), getStats = getDailyStats }) {
  if (!guildSettings?.report_channel_id) return { sent: 0, skipped: 0, failed: 0 };

  const guildId = guildSettings.guild_id;
  const rows = getLockedSummariesBetween(guildId, addDays(today, -REPORT_CATCHUP_DAYS), addDays(today, -1));
  const result = { sent: 0, skipped: 0, failed: 0 };
  let channel = null;

  for (const row of rows) {
    const date = row.booking_date;
    if (getDailyReportRecord(guildId, date)) continue; // 已經處理過（發過或略過）

    if (!guildSettings.report_enabled) {
      recordDailyReport(guildId, date, "skipped");
      result.skipped++;
      continue;
    }

    try {
      channel ??= await client.channels.fetch(guildSettings.report_channel_id);
      const embed = buildDailyReportEmbed(date, getStats(guildId, date));
      const msg = await channel.send({ embeds: [embed], allowedMentions: NO_PING });
      recordDailyReport(guildId, date, "sent", msg?.id ?? null);
      result.sent++;
      console.log(`[${guildId}] 已發送日報：${date}`);
    } catch (err) {
      result.failed++;
      console.warn(`[${guildId}] 發送日報失敗 (${date})：`, err.message);
      await logToAdmin(guildSettings, `⚠️ ${formatDateLabel(date)} 的日報發送失敗（${err.message}）。請確認機器人在日報頻道有「查看頻道」跟「發送訊息」「嵌入連結」權限，下次排程會再試一次。`);
      break; // 頻道有問題的話，後面幾天也一樣會失敗，不用連續重試
    }
  }
  return result;
}

// 管理頻道的「取消訂閱」「訂閱報告」。回覆都用 reply 但不 @ 任何人
export async function handleReportSubscriptionCommand(message, guildSettings, wantSubscribe) {
  const reply = (content) => message.reply({ content, allowedMentions: NO_PING }).catch(() => {});

  if (!guildSettings.report_channel_id) {
    await reply("這個伺服器還沒有設定日報頻道，所以目前沒有日報可以訂閱或取消。（設定方式：`node scripts/add-guild.js <guildId> --report <頻道ID>`）");
    return;
  }

  const subscribed = !!guildSettings.report_enabled;
  const where = `<#${guildSettings.report_channel_id}>`;

  if (wantSubscribe) {
    if (subscribed) {
      await reply(`ℹ️ 目前已經是訂閱中，不需要重複訂閱。日報會在每天 00:05 左右發到 ${where}。`);
      return;
    }
    setReportEnabled(guildSettings.guild_id, true);
    await reply(`✅ 已恢復訂閱日報，從下一次開始會發到 ${where}。（取消訂閱期間的日報不會補發）`);
    return;
  }

  if (!subscribed) {
    await reply("ℹ️ 目前已經是「取消訂閱」狀態，不需要重複取消。要恢復請輸入「訂閱報告」。");
    return;
  }
  setReportEnabled(guildSettings.guild_id, false);
  await reply("✅ 已取消訂閱日報，之後不會再發。要恢復請輸入「訂閱報告」。");
}

