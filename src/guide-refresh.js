// 引導訊息文案更新：把「還沒過期」的每日討論串裡的引導訊息換成新文案（加註「請直接編輯留言，不要刪除重打」）。
// 用 daily_summary.guide_version 記錄，換過的不會重複處理；新建立的討論串一開始就是新文案。
import { formatGuideText, getBookingDateToday } from "./format.js";
import { getAllGuildSettings, getSummariesNeedingGuideUpdate, markGuideVersion } from "./db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 找出討論串裡機器人發的引導訊息（論壇貼文是第一則；一般討論串要往前找）
async function findGuideMessage(client, thread, summaryMessageId) {
  const messages = await thread.messages.fetch({ after: "0", limit: 10 }); // 最舊的 10 則
  return [...messages.values()]
    .sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0))
    .find((m) => m.author?.id === client.user.id && m.id !== summaryMessageId && (m.content || "").includes("預約說明"));
}

export async function refreshGuideMessages({ client, today = getBookingDateToday(), delayMs = 400 } = {}) {
  const result = { updated: 0, missing: 0, failed: 0 };
  for (const settings of getAllGuildSettings()) {
    for (const row of getSummariesNeedingGuideUpdate(settings.guild_id, today)) {
      try {
        const thread = await client.channels.fetch(row.channel_id);
        const guide = thread ? await findGuideMessage(client, thread, row.message_id) : null;
        if (!guide) {
          markGuideVersion(row.guild_id, row.booking_date, 1); // 找不到（被刪了）就不用再試
          result.missing++;
        } else {
          await guide.edit({ content: formatGuideText(row.booking_date) });
          markGuideVersion(row.guild_id, row.booking_date, 1);
          result.updated++;
        }
      } catch (err) {
        result.failed++; // 暫時性錯誤（網路、權限）不標記，下次啟動再試
        console.warn(`[${row.guild_id}] 更新引導訊息失敗 (${row.booking_date})：`, err.message);
      }
      if (delayMs) await sleep(delayMs);
    }
  }
  if (result.updated || result.failed) console.log(`引導訊息更新：成功 ${result.updated}、找不到 ${result.missing}、失敗 ${result.failed}`);
  return result;
}
