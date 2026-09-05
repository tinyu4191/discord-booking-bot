// 移除語音群：讓機器人停止管理某個語音群，支援「暫停」跟「完全清除資料」兩種模式
//
// 用法：
//   暫停（預設，保留所有歷史資料，之後可以用 add-guild.js 重新登記恢復）：
//     node scripts/remove-guild.js <guildId>
//
//   完全清除（連同這個語音群的所有預約、鎖定設定都從資料庫刪掉，無法復原）：
//     node scripts/remove-guild.js <guildId> --purge
//
// 這支腳本只會動資料庫，不會踢除 Discord 上的機器人、也不會刪除對方伺服器上的頻道/討論串，
// 那兩件事要請該語音群的管理員自己在 Discord 上操作。

import "dotenv/config";
import readline from "node:readline";
import db, { getGuildSettings, deleteGuildSettings } from "../src/db.js";

const guildId = process.argv[2];
const purge = process.argv.includes("--purge");

if (!guildId) {
  console.log("用法：");
  console.log("  node scripts/remove-guild.js <guildId>          （暫停，保留歷史資料）");
  console.log("  node scripts/remove-guild.js <guildId> --purge  （完全清除，含所有預約/鎖定資料，無法復原）");
  process.exit(1);
}

const settings = getGuildSettings(guildId);
if (!settings) {
  console.error(`找不到 guild_id=${guildId} 的登記紀錄，可能本來就沒登記過，或已經被移除過了。`);
  process.exit(1);
}

console.log("目前這個語音群的設定：");
console.log(settings);

function countRows(table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE guild_id = ?`).get(guildId).c;
}

const counts = {
  bookings: countRows("bookings"),
  daily_summary: countRows("daily_summary"),
  summary_pages: countRows("summary_pages"),
  blocked_slots: countRows("blocked_slots"),
  recurring_blocked_slots: countRows("recurring_blocked_slots"),
};
console.log("\n目前這個語音群的資料量：");
console.log(counts);

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  if (purge) {
    const ok = await confirm(
      `\n⚠️ 確定要「完全清除」guild_id=${guildId} 的所有資料嗎？這個動作無法復原。輸入 y 確認：`
    );
    if (!ok) {
      console.log("已取消，沒有做任何變更。");
      process.exit(0);
    }

    const purgeAll = db.transaction(() => {
      db.prepare(`DELETE FROM bookings WHERE guild_id = ?`).run(guildId);
      db.prepare(`DELETE FROM daily_summary WHERE guild_id = ?`).run(guildId);
      db.prepare(`DELETE FROM summary_pages WHERE guild_id = ?`).run(guildId);
      db.prepare(`DELETE FROM blocked_slots WHERE guild_id = ?`).run(guildId);
      db.prepare(`DELETE FROM recurring_blocked_slots WHERE guild_id = ?`).run(guildId);
      deleteGuildSettings(guildId);
    });
    purgeAll();

    console.log(`\n✅ 已完全清除 guild_id=${guildId} 的所有資料（含 guild_settings）。`);
  } else {
    deleteGuildSettings(guildId);
    console.log(
      `\n✅ 已移除 guild_id=${guildId} 的登記（guild_settings），機器人不會再管理這個語音群。` +
        `\n歷史資料還保留在資料庫裡，之後想恢復可以用 scripts/add-guild.js 重新登記。`
    );
  }

  console.log("\n記得接下來：");
  console.log("1. 重啟機器人：pm2 restart booking-bot");
  console.log("2. 請該語音群的管理員自己把機器人從 Discord 伺服器成員列表踢出");
  console.log("3. 該語音群裡機器人建立的討論串/頻道，要不要清也是由對方自己決定，我們不會主動去動");
}

main();