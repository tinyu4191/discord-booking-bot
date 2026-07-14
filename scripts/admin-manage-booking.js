// 後台管理小工具：手動修改/刪除某一筆預約（改完會自動同步更新 Discord 上的統計 embed）
// 主要給「沒有對應真實留言」的資料用（例如用遷移腳本直接寫進資料庫的舊資料），
// 一般透過討論串留言建立的預約，請直接請使用者自己編輯/刪除留言即可，不需要用這支工具。
//
// 用法：
//   查詢某天所有預約的 id：
//     sqlite3 bookings.db "SELECT id, location, scheduled_time, channel, booker_id, proxy_for FROM bookings WHERE booking_date='2026-07-14' ORDER BY scheduled_time;"
//
//   修改（只需要給要改的欄位，沒給的維持原值）：
//     node scripts/admin-manage-booking.js edit 5 --channel 115
//     node scripts/admin-manage-booking.js edit 5 --time 21:10 --channel 115 --proxy rhhhhh
//
//   刪除：
//     node scripts/admin-manage-booking.js delete 5

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import {
  getBookingById,
  updateBookingById,
  deleteBookingById,
  getConfirmedBookingsByDate,
  getSummaryMessage,
} from "../src/db.js";
import { buildSummaryEmbed } from "../src/format.js";

const [, , action, idArg, ...rest] = process.argv;

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function printUsage() {
  console.log("用法：");
  console.log("  node scripts/admin-manage-booking.js edit <id> [--location xx] [--time HH:MM] [--channel xx] [--proxy xx]");
  console.log("  node scripts/admin-manage-booking.js delete <id>");
  console.log("");
  console.log("先用 sqlite3 查出要改的 id：");
  console.log('  sqlite3 bookings.db "SELECT id, location, scheduled_time, channel, booker_id, proxy_for FROM bookings WHERE booking_date=\'2026-07-14\' ORDER BY scheduled_time;"');
}

async function refreshSummaryMessage(client, bookingDate) {
  const summaryRow = getSummaryMessage(bookingDate);
  if (!summaryRow) {
    console.warn(`找不到 ${bookingDate} 的討論串紀錄，沒辦法更新統計 embed。`);
    return;
  }
  const bookings = getConfirmedBookingsByDate(bookingDate);
  const embed = buildSummaryEmbed(bookingDate, bookings);
  const thread = await client.channels.fetch(summaryRow.channel_id);
  const msg = await thread.messages.fetch(summaryRow.message_id);
  await msg.edit({ embeds: [embed] });
  console.log(`${bookingDate}：統計 embed 已更新`);
}

async function main() {
  if (!action || !idArg || !["edit", "delete"].includes(action)) {
    printUsage();
    process.exit(1);
  }

  const id = Number(idArg);
  const booking = getBookingById(id);
  if (!booking) {
    console.error(`找不到 id=${id} 的預約，先用 sqlite3 查一下正確的 id。`);
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    try {
      if (action === "delete") {
        deleteBookingById(id);
        console.log(`已刪除 id=${id}（${booking.location} / ${booking.scheduled_time} / ${booking.channel || "當日決定"}）`);
      } else {
        const flags = parseFlags(rest);
        const updated = {
          location: flags.location ?? booking.location,
          time: flags.time ?? booking.scheduled_time,
          channel: flags.channel ?? booking.channel,
          proxyFor: flags.proxy !== undefined ? flags.proxy : booking.proxy_for,
        };
        updateBookingById(id, updated);
        console.log(`已更新 id=${id}：`, updated);
      }

      await refreshSummaryMessage(client, booking.booking_date);
    } catch (err) {
      console.error("操作失敗：", err);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main();
