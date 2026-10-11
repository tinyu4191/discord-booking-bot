// 每日預約日報的試作版（只用來看版面，不會自動發布任何東西）
//
// 啟用方式：在 .env 加上 DEMO_GUILD_ID=<測試伺服器ID>，重啟機器人（跟 /page-ui-demo 共用同一個設定）。
// 沒設定 DEMO_GUILD_ID 時，這個檔案什麼都不會做。
//
// 指令：
//   /daily-report-demo                         用假資料產生「昨天」的日報（版面預覽，標示「示範資料」）
//   /daily-report-demo date:2026-10-08         指定日期
//   /daily-report-demo source:真實資料          用這個伺服器資料庫裡真正的預約資料來產生（沒有預約的日子會顯示「這一天沒有預約」）
//
// 版面確認之後，正式版會在「鎖定過期討論串」的同時，把前一天的日報發到「日報頻道」。

import { Events, MessageFlags, SlashCommandBuilder } from "discord.js";
import { addDays, getBookingDateToday, minutesToTime } from "./format.js";
import { buildDailyReportEmbed, collectDailyStats, getDailyStats } from "./daily-report.js";
import { seededRandom } from "./page-ui-demo.js";

const NO_PING = { parse: [] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 假資料：用日期當亂數種子，同一天每次產生同樣的內容。尖峰落在晚上，凌晨很少
// ---------------------------------------------------------------------------
const HOUR_WEIGHT = [2, 1, 1, 0, 0, 0, 0, 1, 2, 3, 3, 4, 5, 5, 4, 4, 5, 6, 7, 9, 10, 9, 6, 4];
const LOCATIONS = [["烏魯莊園2", 40], ["莊園II", 25], ["蝴蝶谷", 15], ["龍王", 12], ["武陵道場", 8]];
export const FAKE_NAMES = ["無敵", "阿肥", "小明", "滷蛋", "蘇玉翔", "漢娜", "發發", "啵啵奶茶", "糯米兔", "蝦餃", "橘白", "98", "ottoke", "Hung"];

function weightedPick(rand, entries) {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r < 0) return value;
  }
  return entries[entries.length - 1][0];
}

export function fakeDayStats(date) {
  const rand = seededRandom(`report-${date}`);
  const hours = HOUR_WEIGHT.map((w, h) => [h, w]);
  const bookerPool = FAKE_NAMES.map((name, i) => [`fake-${i}`, Math.max(1, FAKE_NAMES.length - i)]); // 前面的人預約比較多
  const confirmed = [];
  const taken = [];
  const target = 45 + Math.floor(rand() * 30); // 45~74 筆

  for (let tries = 0; confirmed.length < target && tries < 2000; tries++) {
    const minutes = weightedPick(rand, hours) * 60 + Math.floor(rand() * 60);
    if (taken.some((t) => Math.abs(t - minutes) < 5)) continue; // 跟真實規則一樣：前後 5 分鐘不可重複
    taken.push(minutes);
    confirmed.push({
      scheduled_time: minutesToTime(minutes),
      location: weightedPick(rand, LOCATIONS),
      booker_id: weightedPick(rand, bookerPool),
      proxy_for: rand() < 0.25 ? "代約對象" : null,
      message_id: rand() < 0.15 ? `renew-${confirmed.length}` : String(confirmed.length),
    });
  }

  return collectDailyStats({
    confirmed,
    cancelled: new Array(Math.floor(rand() * 5)).fill({}),
    blockedSlots: [
      { start_time: "03:30", end_time: "08:00", reason: "打烊" },
      { start_time: "21:30", end_time: "22:00", reason: "出征蝴蝶王" },
    ],
  });
}

const fakeBookerName = (id) => {
  const n = Number(String(id).replace("fake-", ""));
  return FAKE_NAMES[n] ?? id;
};

// ---------------------------------------------------------------------------
// 指令處理（匯出，方便用假 interaction 測試）
// ---------------------------------------------------------------------------
function isRealDate(text) {
  if (!DATE_RE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export async function handleReportDemo(i) {
  if (!i.isChatInputCommand?.() || i.commandName !== "daily-report-demo") return false;

  const date = i.options.getString("date") ?? addDays(getBookingDateToday(), -1); // 預設是昨天
  if (!isRealDate(date)) {
    await i.reply({ content: "日期格式請用 YYYY-MM-DD，例如 2026-10-08。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const real = i.options.getString("source") === "real";
  const embed = real
    ? buildDailyReportEmbed(date, getDailyStats(i.guildId, date))
    : buildDailyReportEmbed(date, fakeDayStats(date), { formatBooker: fakeBookerName, demo: true });

  await i.reply({ embeds: [embed], allowedMentions: NO_PING });
  return true;
}

// ---------------------------------------------------------------------------
// 啟動：只在設定了 DEMO_GUILD_ID 時才註冊指令並監聽
// ---------------------------------------------------------------------------
export function setupDailyReportDemo(client) {
  const guildId = process.env.DEMO_GUILD_ID;
  if (!guildId) return;

  const command = new SlashCommandBuilder()
    .setName("daily-report-demo")
    .setDescription("每日預約日報的版面試作")
    .addStringOption((o) => o.setName("date").setDescription("日期 YYYY-MM-DD（預設是昨天）").setRequired(false))
    .addStringOption((o) =>
      o
        .setName("source")
        .setDescription("資料來源（預設是假資料）")
        .addChoices({ name: "假資料（版面預覽）", value: "fake" }, { name: "真實資料（這個伺服器的預約）", value: "real" })
        .setRequired(false)
    );

  client.guilds
    .fetch(guildId)
    .then((guild) => guild.commands.create(command))
    .then(() => console.log(`/daily-report-demo 已註冊到測試伺服器 ${guildId}`))
    .catch((err) => console.warn("註冊 /daily-report-demo 失敗：", err.message));

  client.on(Events.InteractionCreate, (i) => {
    if (i.guildId !== guildId) return;
    handleReportDemo(i).catch((err) => console.error("daily-report-demo 處理失敗：", err));
  });
}
