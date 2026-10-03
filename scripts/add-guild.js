// 新增或編輯語音群設定：
//   新增（guildId 第一次出現）：--booking 必填，其他選填
//   編輯（guildId 已經登記過）：只需要帶你想改的那幾個參數，沒帶的欄位維持原值不會被清空
//   要把某個選填欄位清掉：該參數帶 none，例如 --announcement none
//
// 用法：
//   node scripts/add-guild.js <guildId> --booking <頻道ID> [--admin <頻道ID>] [--management <頻道ID>] [--announcement <頻道ID>]
//
// guildId 怎麼拿：在 Discord 對該語音群的伺服器圖示按右鍵「複製伺服器 ID」（要先開開發者模式）
// 頻道 ID：對應頻道按右鍵「複製頻道 ID」
//
// 查目前登記了什麼：node scripts/list-guilds.js

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
  console.log("");
  console.log("編輯已登記的語音群時，只需要帶你想改的參數，沒帶的欄位會維持原值。");
  console.log("要清空某個選填欄位，該參數帶 none，例如：--announcement none");
}

// 決定某個欄位最後要寫入的值：
// - 這次有帶這個參數 → 用這次帶的值（帶 "none" 代表清空成 null）
// - 這次沒帶 → 沿用資料庫裡原本的值（新增時就是 null）
function resolveValue(flagValue, existingValue) {
  if (flagValue === undefined) return existingValue ?? null;
  if (flagValue.toLowerCase() === "none") return null;
  return flagValue;
}

if (!guildId) {
  printUsage();
  process.exit(1);
}

const flags = parseFlags(rest);
const existing = getGuildSettings(guildId);

if (!existing && !flags.booking) {
  console.log("這是新的語音群，第一次登記 --booking 是必填。\n");
  printUsage();
  process.exit(1);
}

const next = {
  bookingParentChannelId: resolveValue(flags.booking, existing?.booking_parent_channel_id),
  adminChannelId: resolveValue(flags.admin, existing?.admin_channel_id),
  managementChannelId: resolveValue(flags.management, existing?.management_channel_id),
  announcementChannelId: resolveValue(flags.announcement, existing?.announcement_channel_id),
};

upsertGuildSettings(guildId, next);

const saved = getGuildSettings(guildId);
console.log(existing ? `✅ 已更新語音群 ${guildId}：` : `✅ 已新增語音群 ${guildId}：`);
console.log(saved);
console.log("\n重啟機器人（pm2 restart booking-bot）後生效（大部分設定其實即時生效，重啟只是保險）。");
