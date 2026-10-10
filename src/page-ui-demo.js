// 班表「單一訊息 + 翻頁」的試作版（假資料，不碰資料庫，不影響正式功能）
//
// 啟用方式：在 .env 加上 DEMO_GUILD_ID=<測試伺服器ID>，重啟機器人。
// 沒設定 DEMO_GUILD_ID 時，這個檔案什麼都不會做（正式群完全看不到 /page-ui-demo）。
//
// 試作重點：
//   1. 公開訊息固定顯示一頁（今天 = 現在時間之後的那一頁），按鈕標示時間範圍
//   2. 按任何翻頁按鈕，會用「只有按的人看得到」的私人訊息顯示那一頁，
//      私人訊息裡的翻頁只影響自己，不會改到公開訊息，也不會影響別人
//   3. 模擬「時段衝突」回覆：按「查看 13:30 附近的行程」，在原地彈出該時間所在那一頁的私人訊息
//
// 指令：
//   /page-ui-demo                      發一則公開班表（假資料）
//   /page-ui-demo conflict_time:13:30  發一則模擬的衝突回覆（帶「查看附近行程」按鈕）

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { buildSummaryEmbed, chunkBookingsForSummary, getBookingDateToday, getCurrentTimeMinutes, minutesToTime, timeToMinutes } from "./format.js";

const PREFIX = "pgd";
const NO_PING = { parse: [] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 假資料：同一天永遠產生同樣的內容（用日期當亂數種子），所以重啟、重複按都一致
// ---------------------------------------------------------------------------
function seededRandom(seedText) {
  let h = 1779033703;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCATIONS = ["烏魯莊園2", "莊園II", "蝴蝶谷", "龍王", "武陵道場"];
const PROXY_NAMES = ["滷蛋", "蘇玉翔", "小明", "阿肥"];

export function fakeBookings(date, userId = "0") {
  const rand = seededRandom(date);
  const list = [];
  let minutes = 10;
  let n = 0;
  while (minutes < 1440) {
    n++;
    list.push({
      id: n,
      scheduled_time: minutesToTime(minutes),
      location: LOCATIONS[Math.floor(rand() * LOCATIONS.length)],
      channel: String(100 + Math.floor(rand() * 900)),
      booker_id: userId,
      proxy_for: rand() < 0.4 ? PROXY_NAMES[Math.floor(rand() * PROXY_NAMES.length)] : null,
      message_id: rand() < 0.15 ? `renew-${n}` : String(n), // 一部分模擬成續約，看 🔁 圖示
    });
    minutes += 7 + Math.floor(rand() * 7); // 間隔 7~13 分鐘（至少 5 分鐘，不會互相衝突），讓一天湊出約 4 頁
  }
  return list;
}

// ---------------------------------------------------------------------------
// 分頁計算
// ---------------------------------------------------------------------------
const firstTime = (page) => page[0]?.scheduled_time ?? "--:--";
const lastTime = (page) => page[page.length - 1]?.scheduled_time ?? "--:--";

// 第一個「最後一筆預約時間 >= minutes」的頁；都沒有就是最後一頁
export function pageForMinutes(pages, minutes) {
  const idx = pages.findIndex((p) => p.length > 0 && timeToMinutes(lastTime(p)) >= minutes);
  return idx < 0 ? pages.length - 1 : idx;
}

const clampPage = (pages, n) => Math.min(Math.max(Number.isInteger(n) ? n : 0, 0), pages.length - 1);

// ---------------------------------------------------------------------------
// 畫面
// ---------------------------------------------------------------------------

// mode: "pub" = 公開訊息（按了會開私人訊息）；"prv" = 私人訊息（按了直接換頁，只影響自己）
export function buildView(date, pages, pageIndex, mode, { note } = {}) {
  const total = pages.length;
  const page = pages[pageIndex];
  const embed = buildSummaryEmbed(date, page, pageIndex, total);

  const id = (target, tag) => `${PREFIX}|go|${mode}|${target}|${date}|${tag}`;
  const hasPrev = pageIndex > 0;
  const hasNext = pageIndex < total - 1;

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id(Math.max(pageIndex - 1, 0), "p"))
      .setLabel(hasPrev ? `◀ ${lastTime(pages[pageIndex - 1])} 前` : "◀ 最前面")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId(id(pageIndex, "c"))
      .setLabel(`${firstTime(page)}–${lastTime(page)}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true), // 只是顯示目前這頁的時間範圍
    new ButtonBuilder()
      .setCustomId(id(Math.min(pageIndex + 1, total - 1), "n"))
      .setLabel(hasNext ? `${firstTime(pages[pageIndex + 1])} 後 ▶` : "最後面 ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext)
  );

  const components = [buttons];
  if (mode === "prv") {
    // 私人訊息多一個下拉選單，直接跳到想看的時段
    components.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}|sel|${date}`)
          .setPlaceholder("跳到其他時段")
          .addOptions(
            pages.slice(0, 25).map((p, i) => ({
              label: `${firstTime(p)} – ${lastTime(p)}`,
              description: `${p.length} 筆`,
              value: String(i),
              default: i === pageIndex,
            }))
          )
      )
    );
  }

  const view = { embeds: [embed], components, allowedMentions: NO_PING };
  view.content = note || (mode === "prv" ? "🔎 只有你看得到這一頁，翻頁不會影響別人" : "");
  return view;
}

function jumpRow(minutes, date) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}|jump|${minutes}|${date}`)
      .setLabel(`查看 ${minutesToTime(minutes)} 附近的行程`)
      .setEmoji("📅")
      .setStyle(ButtonStyle.Primary)
  );
}

// ---------------------------------------------------------------------------
// 互動處理（匯出成純函式，方便用假 interaction 測試）
// ---------------------------------------------------------------------------
export async function handleDemoInteraction(i) {
  const date = getBookingDateToday();

  if (i.isChatInputCommand?.() && i.commandName === "page-ui-demo") {
    const conflictTime = i.options.getString("conflict_time");
    if (conflictTime) {
      const minutes = timeToMinutes(conflictTime);
      if (minutes === null) {
        return i.reply({ content: "時間格式請用 HH:MM，例如 13:30。", flags: MessageFlags.Ephemeral });
      }
      return i.reply({
        content:
          `這個時段衝突了：烏魯莊園2 在 ${minutesToTime(minutes)} 已經有人預約（前後 5 分鐘內不可重複），請改個時間再留言一次。\n` +
          `💡 最近的空檔：${minutesToTime(Math.max(minutes - 5, 0))}、${minutesToTime(Math.min(minutes + 5, 1439))}（示範用，不是真的計算結果）`,
        components: [jumpRow(minutes, date)],
        allowedMentions: NO_PING,
      });
    }

    const pages = chunkBookingsForSummary(fakeBookings(date, i.user.id));
    // 今天 → 現在時間之後的那一頁；其他情況（這個試作只有今天）→ 第 1 頁
    const start = pageForMinutes(pages, getCurrentTimeMinutes());
    return i.reply(buildView(date, pages, start, "pub"));
  }

  const isComponent = (i.isButton?.() || i.isStringSelectMenu?.()) && i.customId?.startsWith(`${PREFIX}|`);
  if (!isComponent) return;

  const parts = i.customId.split("|");
  const kind = parts[1];

  // 衝突回覆上的「查看附近行程」：原地彈出那個時間所在頁的私人訊息
  if (kind === "jump") {
    const minutes = Number(parts[2]);
    const jumpDate = parts[3];
    if (!Number.isInteger(minutes) || !DATE_RE.test(jumpDate)) return i.reply({ content: "按鈕資料有誤。", flags: MessageFlags.Ephemeral });
    const pages = chunkBookingsForSummary(fakeBookings(jumpDate, i.user.id));
    const idx = pageForMinutes(pages, minutes);
    return i.reply({
      ...buildView(jumpDate, pages, idx, "prv", { note: `📍 你想預約的 ${minutesToTime(minutes)} 在這一頁，翻頁只影響你自己` }),
      flags: MessageFlags.Ephemeral,
    });
  }

  // 私人訊息的下拉選單：換頁
  if (kind === "sel") {
    const selDate = parts[2];
    if (!DATE_RE.test(selDate)) return i.reply({ content: "按鈕資料有誤。", flags: MessageFlags.Ephemeral });
    const pages = chunkBookingsForSummary(fakeBookings(selDate, i.user.id));
    return i.update(buildView(selDate, pages, clampPage(pages, Number(i.values[0])), "prv"));
  }

  // 翻頁按鈕
  if (kind === "go") {
    const mode = parts[2];
    const target = Number(parts[3]);
    const goDate = parts[4];
    if ((mode !== "pub" && mode !== "prv") || !DATE_RE.test(goDate)) {
      return i.reply({ content: "按鈕資料有誤。", flags: MessageFlags.Ephemeral });
    }
    const pages = chunkBookingsForSummary(fakeBookings(goDate, i.user.id));
    const idx = clampPage(pages, target);
    if (mode === "pub") {
      // 公開訊息：不改動它，另外開一則只有按的人看得到的私人訊息
      return i.reply({ ...buildView(goDate, pages, idx, "prv"), flags: MessageFlags.Ephemeral });
    }
    // 私人訊息：直接換頁（只影響自己）
    return i.update(buildView(goDate, pages, idx, "prv"));
  }
}

// ---------------------------------------------------------------------------
// 啟動：只在設定了 DEMO_GUILD_ID 時才註冊指令並監聽
// ---------------------------------------------------------------------------
export function setupPageUiDemo(client) {
  const guildId = process.env.DEMO_GUILD_ID;
  if (!guildId) return;

  const command = new SlashCommandBuilder()
    .setName("page-ui-demo")
    .setDescription("班表單一訊息＋翻頁的試作（假資料）")
    .addStringOption((o) => o.setName("conflict_time").setDescription("模擬衝突回覆，例如 13:30").setRequired(false));

  client.guilds
    .fetch(guildId)
    .then((guild) => guild.commands.create(command))
    .then(() => console.log(`/page-ui-demo 已註冊到測試伺服器 ${guildId}`))
    .catch((err) => console.warn("註冊 /page-ui-demo 失敗：", err.message));

  client.on(Events.InteractionCreate, (i) => {
    if (i.guildId !== guildId) return; // 只回應測試伺服器
    handleDemoInteraction(i).catch((err) => console.error("page-ui-demo 處理失敗：", err));
  });
}
