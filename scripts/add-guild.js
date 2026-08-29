// 登記新語音群：之後每次要讓機器人服務一個新的語音群，跑一次這支腳本就好
// 用法：
//   node scripts/add-guild.js <guildId> --booking <頻道ID> [--admin <頻道ID>] [--management <頻道ID>] [--announcement <頻道ID>]
//
// --booking 必填，其他三個選填（不設定的功能就不會啟用，例如沒設 --announcement 就不會發公告）
//
// guildId 怎麼拿：在 Discord 對該語音群的伺服器圖示按右鍵「複製伺服器 ID」（要先開開發者模式）
// 頻道 ID：對應頻道按右鍵「複製頻道 ID」
//
// 這支腳本可以重複執行：同一個 guildId 再跑一次，會直接覆蓋更新設定，不會產生重複資料

import "dotenv/config";
import { upsertGuildSettings, getGuildSettings } from "../src/db.js";

const [, , guildId, ...rest] = process.argv;

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
  console.log("  node scripts/add-guild.js <guildId> --booking <頻道ID> [--admin <頻道ID>] [--management <頻道ID>] [--announcement <頻道ID>]");
}

const flags = parseFlags(rest);

if (!guildId || !flags.booking) {
  printUsage();
  process.exit(1);
}

upsertGuildSettings(guildId, {
  bookingParentChannelId: flags.booking,
  adminChannelId: flags.admin,
  managementChannelId: flags.management,
  announcementChannelId: flags.announcement,
});

const saved = getGuildSettings(guildId);
console.log(`✅ 已登記語音群 ${guildId}：`);
console.log(saved);
console.log("\n重啟機器人（pm2 restart booking-bot）後，這個語音群就會開始自動運作。");
