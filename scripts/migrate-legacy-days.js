// 一次性遷移腳本：把手動統計的舊資料直接寫進資料庫，保留原始預約人的 Discord ID
// 用法：node scripts/migrate-legacy-days.js
//
// 注意：
// - 直接寫入資料庫，跳過留言解析與衝突檢查（因為是已經確定發生過的歷史資料）
// - 每筆資料用假的 message_id（legacy-日期-序號），不對應真實留言，
//   之後沒辦法透過「編輯/刪除留言」的方式修改，要改只能手動處理資料庫
// - 可以放心重複執行：message_id 有 UNIQUE 限制，已經匯入過的資料會被跳過並印出提示，
//   不會產生重複紀錄，也不會讓其他天的匯入中斷

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { insertBooking, getConfirmedBookingsByDate, getSummaryMessage } from "../src/db.js";
import { buildSummaryEmbed } from "../src/format.js";

// 每個日期一組資料，proxyFor 沒有的填 null
// 沒有記錄到具體代約遊戲ID的（例如舊資料只寫「代約」兩個字沒附名字），proxyFor 一律填 null
const LEGACY_DAYS = {
  "2026-07-14": [
    { location: "龍王", time: "20:00", channel: "未定", bookerId: "1101877805970641019", proxyFor: null },
    { location: "龍王", time: "20:05", channel: "176s", bookerId: "505409812729954314", proxyFor: null },
    { location: "龍王", time: "20:10", channel: "當日決定", bookerId: "432910307296411648", proxyFor: null },
    { location: "龍王", time: "20:15", channel: "954s", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "20:30", channel: "當日決定", bookerId: "861286139272757349", proxyFor: "rhhhhh" },
    { location: "龍王", time: "20:35", channel: "當日決定", bookerId: "490862045961388033", proxyFor: null },
    { location: "龍王", time: "20:40", channel: "當日決定", bookerId: "592685139717390346", proxyFor: null },
    { location: "龍王", time: "21:00", channel: "當日決定", bookerId: "861286139272757349", proxyFor: "Shao" },
    { location: "蝴蝶（女王藏身處）", time: "21:05", channel: "當日決定", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "21:10", channel: "當日決定", bookerId: "861286139272757349", proxyFor: "球球不是黑騎大哥" },
    { location: "龍王", time: "21:30", channel: "當日決定", bookerId: "1402637425645195264", proxyFor: null },
    { location: "龍王", time: "21:40", channel: "當日決定", bookerId: "927630759383158856", proxyFor: null },
  ],
  "2026-07-15": [
    { location: "龍王", time: "20:15", channel: "954s", bookerId: "1462607027141611633", proxyFor: null },
    { location: "蝴蝶（女王藏身處）", time: "21:00", channel: "當日決定", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "23:00", channel: "當日決定", bookerId: "861286139272757349", proxyFor: null },
  ],
  "2026-07-16": [
    { location: "龍王", time: "20:15", channel: "902s", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "20:35", channel: "未定", bookerId: "861286139272757349", proxyFor: "rhhhhh" },
    { location: "龍王", time: "20:40", channel: "1057s", bookerId: "1346882051055423538", proxyFor: null },
    { location: "龍王", time: "21:00", channel: "未定", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "21:30", channel: "未定", bookerId: "756474696597373008", proxyFor: null },
    { location: "蝴蝶（女王藏身處）", time: "22:50", channel: "未定", bookerId: "1462607027141611633", proxyFor: null },
  ],
  "2026-07-17": [
    { location: "龍王", time: "20:00", channel: "未定", bookerId: "610461043717832713", proxyFor: null },
    { location: "龍王", time: "20:05-10", channel: "當日決定", bookerId: "1321886418565599473", proxyFor: null },
    { location: "龍王", time: "20:15", channel: "902s", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "21:00", channel: "未定", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "21:10", channel: "未定", bookerId: "861286139272757349", proxyFor: "Bubuland" },
    { location: "龍王", time: "21:30", channel: "未定", bookerId: "490862045961388033", proxyFor: null },
    { location: "蝴蝶（女王藏身處）", time: "22:50", channel: "未定", bookerId: "1462607027141611633", proxyFor: null },
  ],
  "2026-07-18": [
    { location: "龍王", time: "9:15", channel: "未定", bookerId: "292910973713383424", proxyFor: null },
    { location: "蝴蝶", time: "14:00", channel: "當日決定", bookerId: "1460121305532731534", proxyFor: null },
    { location: "龍王", time: "17:50", channel: "當日決定", bookerId: "1377073641069478030", proxyFor: null },
    { location: "龍王", time: "19:30", channel: "1085", bookerId: "595975887208316959", proxyFor: null },
    { location: "龍王", time: "20:15", channel: "未定", bookerId: "827605885571694613", proxyFor: null },
    { location: "龍王", time: "20:40", channel: "未定", bookerId: "1383460371288948869", proxyFor: null },
    { location: "龍王", time: "21:30", channel: "未定", bookerId: "490862045961388033", proxyFor: null },
    { location: "龍王", time: "21:40", channel: "未定", bookerId: "1233077344185483266", proxyFor: null },
    { location: "龍王", time: "00:00", channel: "588", bookerId: "863297912654135307", proxyFor: null },
  ],
  "2026-07-19": [
    { location: "龍王", time: "14:00", channel: "TBD", bookerId: "1462607027141611633", proxyFor: null },
    { location: "龍王", time: "20:30", channel: "未定", bookerId: "861286139272757349", proxyFor: "rhhhhh" },
    { location: "龍王", time: "21:10", channel: "未定", bookerId: "1233077344185483266", proxyFor: null },
  ],
};

async function migrateDay(client, bookingDate, entries) {
  const summaryRow = getSummaryMessage(bookingDate);
  if (!summaryRow) {
    console.warn(`找不到 ${bookingDate} 的討論串紀錄，跳過這天（可能該日期的討論串還沒被自動建立）。`);
    return;
  }

  const thread = await client.channels.fetch(summaryRow.channel_id);
  const guildId = thread.guildId;

  let inserted = 0;
  entries.forEach((b, i) => {
    try {
      insertBooking({
        guildId,
        bookingDate,
        messageId: `legacy-${bookingDate}-${i}`,
        location: b.location,
        time: b.time,
        channel: b.channel,
        bookerId: b.bookerId,
        proxyFor: b.proxyFor,
      });
      inserted++;
    } catch (err) {
      console.warn(`${bookingDate} 第 ${i + 1} 筆略過（可能已經匯入過）：`, err.message);
    }
  });

  console.log(`${bookingDate}：新寫入 ${inserted} / ${entries.length} 筆`);

  const bookings = getConfirmedBookingsByDate(bookingDate);
  const embed = buildSummaryEmbed(bookingDate, bookings);
  const msg = await thread.messages.fetch(summaryRow.message_id);
  await msg.edit({ embeds: [embed] });
  console.log(`${bookingDate}：統計 embed 已更新`);
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    try {
      for (const [date, entries] of Object.entries(LEGACY_DAYS)) {
        await migrateDay(client, date, entries);
      }
    } catch (err) {
      console.error("遷移過程發生錯誤：", err);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main();
