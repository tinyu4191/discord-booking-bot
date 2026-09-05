// 列出目前登記的所有語音群，並即時查詢 Discord 上實際的伺服器名稱、頻道名稱
// （用一般 HTTP API 查詢，不會建立 Gateway 連線，可以在機器人正在運行時安全執行）
//
// 用法：node scripts/list-guilds.js

import "dotenv/config";
import { getAllGuildSettings } from "../src/db.js";

const TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = "https://discord.com/api/v10";

async function fetchName(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    if (!res.ok) return `(查不到，HTTP ${res.status})`;
    const data = await res.json();
    return data.name || "(無名稱)";
  } catch (err) {
    return `(查詢失敗：${err.message})`;
  }
}

async function main() {
  const settingsList = getAllGuildSettings();

  if (!settingsList.length) {
    console.log("目前沒有任何已登記的語音群。");
    return;
  }

  for (const settings of settingsList) {
    const guildName = await fetchName(`/guilds/${settings.guild_id}`);

    console.log("──────────────────────────────");
    console.log(`語音群：${guildName}（guild_id: ${settings.guild_id}）`);

    const channelLabels = [
      ["預約區 (booking_parent_channel_id)", settings.booking_parent_channel_id],
      ["機器人紀錄 (admin_channel_id)", settings.admin_channel_id],
      ["管理頻道 (management_channel_id)", settings.management_channel_id],
      ["公告頻道 (announcement_channel_id)", settings.announcement_channel_id],
    ];

    for (const [label, channelId] of channelLabels) {
      if (!channelId) {
        console.log(`  ${label}：未設定`);
        continue;
      }
      const channelName = await fetchName(`/channels/${channelId}`);
      console.log(`  ${label}：#${channelName}（${channelId}）`);
    }
  }
  console.log("──────────────────────────────");
}

main();