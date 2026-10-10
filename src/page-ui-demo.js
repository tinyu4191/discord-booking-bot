// 班表「單一訊息 + 翻頁」的試作版（假資料，不碰資料庫，不影響正式功能）
//
// 啟用方式：在 .env 加上 DEMO_GUILD_ID=<測試伺服器ID>，重啟機器人。
// 沒設定 DEMO_GUILD_ID 時，這個檔案什麼都不會做（正式群完全看不到 /page-ui-demo）。
//
// 設計重點（班表是所有人共用的一則公開訊息，沒有私人訊息）：
//   1. 翻頁按鈕、下拉選單都直接改這則公開訊息，所有人看到的是同一頁（最後操作的人決定）
//   2. 時段衝突時：機器人先把班表切到「衝突時段所在的那一頁」，再回覆衝突說明 + 連回班表的連結，
//      使用者點過去看到的就已經是對的那一頁
//   3. 閒置自動復位：班表超過一段時間沒人操作，自動回到「現在時間之後」那一頁（最實用的畫面）
//
// 指令：
//   /page-ui-demo                      在目前頻道發一則班表（假資料）
//   /page-ui-demo conflict_time:13:30  模擬衝突：班表切到 13:30 所在頁，並回覆衝突說明 + 連結
//
// 可調整的環境變數：DEMO_IDLE_MINUTES（閒置幾分鐘後自動復位，預設 10，測試時可以設 1）
//
// 備註：試作的「目前頁 / 最後操作時間」存在記憶體裡，重啟會清掉（正式版會存資料庫）

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
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;

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

const getPages = (date) => chunkBookingsForSummary(fakeBookings(date));

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

// 「最實用的頁」：今天 = 現在時間之後的那一頁；其他日期 = 第 1 頁
export function defaultPageIndex(date, pages, nowMinutes = getCurrentTimeMinutes()) {
  return date === getBookingDateToday() ? pageForMinutes(pages, nowMinutes) : 0;
}

// ---------------------------------------------------------------------------
// 畫面
// ---------------------------------------------------------------------------
export function buildView(date, pages, pageIndex) {
  const total = pages.length;
  const page = pages[pageIndex];
  const embed = buildSummaryEmbed(date, page, pageIndex, total);

  const id = (target, tag) => `${PREFIX}|go|${target}|${date}|${tag}`;
  const hasPrev = pageIndex > 0;
  const hasNext = pageIndex < total - 1;

  const select = new ActionRowBuilder().addComponents(
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
  );

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

  return { content: "", embeds: [embed], components: [select, buttons], allowedMentions: NO_PING };
}

// ---------------------------------------------------------------------------
// 班表狀態（記憶體）：messageId → { guildId, channelId, messageId, date, page, lastTouch }
// ---------------------------------------------------------------------------
const boards = new Map();

function touchBoard(info, page, now = Date.now()) {
  const existing = boards.get(info.messageId);
  const board = existing ?? { ...info };
  board.page = page;
  board.lastTouch = now;
  boards.set(board.messageId, board);
  return board;
}

const findBoardByChannel = (channelId) => [...boards.values()].filter((b) => b.channelId === channelId).at(-1);

export const __boards = boards; // 給測試用

// ---------------------------------------------------------------------------
// 閒置自動復位：超過 idleMs 沒人操作、而且目前停的頁不是「現在」那一頁 → 切回現在那一頁
// 回傳這輪復位的班表數量
// ---------------------------------------------------------------------------
export async function resetIdleBoards(client, { now = Date.now(), idleMs = idleMinutes() * 60 * 1000, nowMinutes } = {}) {
  let count = 0;
  for (const board of [...boards.values()]) {
    if (now - board.lastTouch < idleMs) continue;
    const pages = getPages(board.date);
    const target = defaultPageIndex(board.date, pages, nowMinutes);
    if (target === board.page) continue;
    try {
      const channel = await client.channels.fetch(board.channelId);
      await channel.messages.edit(board.messageId, buildView(board.date, pages, target));
      board.page = target;
      board.lastTouch = now;
      count++;
    } catch (err) {
      console.warn(`班表復位失敗，移除追蹤（訊息可能已被刪除）：${err.message}`);
      boards.delete(board.messageId);
    }
  }
  return count;
}

function idleMinutes() {
  const n = Number(process.env.DEMO_IDLE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

// ---------------------------------------------------------------------------
// 互動處理（匯出成函式，方便用假 interaction 測試）
// ---------------------------------------------------------------------------
const tellPrivate = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

export async function handleDemoInteraction(i) {
  const date = getBookingDateToday();

  // ---- /page-ui-demo ----
  if (i.isChatInputCommand?.() && i.commandName === "page-ui-demo") {
    const conflictTime = i.options.getString("conflict_time");
    const pages = getPages(date);

    if (!conflictTime) {
      const start = defaultPageIndex(date, pages);
      await i.reply(buildView(date, pages, start));
      const msg = await i.fetchReply();
      touchBoard({ guildId: i.guildId, channelId: i.channelId, messageId: msg.id, date }, start);
      return;
    }

    const minutes = timeToMinutes(conflictTime);
    if (minutes === null) return tellPrivate(i, "時間格式請用 HH:MM，例如 13:30。");

    await i.deferReply();
    const target = pageForMinutes(pages, minutes);
    let board = findBoardByChannel(i.channelId);
    try {
      const channel = await i.client.channels.fetch(i.channelId);
      if (board) {
        // 已經有班表 → 先切到衝突時段所在的那一頁
        await channel.messages.edit(board.messageId, buildView(date, pages, target));
        board = touchBoard(board, target);
      } else {
        const sent = await channel.send(buildView(date, pages, target));
        board = touchBoard({ guildId: i.guildId, channelId: i.channelId, messageId: sent.id, date }, target);
      }
    } catch (err) {
      console.warn("切換班表頁面失敗：", err.message);
    }

    const url = board ? `https://discord.com/channels/${board.guildId}/${board.channelId}/${board.messageId}` : null;
    const reply = {
      content:
        `這個時段衝突了：烏魯莊園2 在 ${minutesToTime(minutes)} 已經有人預約（前後 5 分鐘內不可重複），請改個時間再留言一次。\n` +
        `💡 最近的空檔：${minutesToTime(Math.max(minutes - 5, 0))}、${minutesToTime(Math.min(minutes + 5, 1439))}（示範用，不是真的計算結果）`,
      allowedMentions: NO_PING,
    };
    if (url) {
      reply.components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`查看 ${minutesToTime(minutes)} 附近的行程`).setURL(url)
        ),
      ];
    }
    return i.editReply(reply);
  }

  // ---- 班表上的按鈕 / 下拉選單 ----
  const isComponent = (i.isButton?.() || i.isStringSelectMenu?.()) && i.customId?.startsWith(`${PREFIX}|`);
  if (!isComponent) return;

  const parts = i.customId.split("|");
  const kind = parts[1];
  const boardDate = kind === "sel" ? parts[2] : parts[3];
  if ((kind !== "go" && kind !== "sel") || !DATE_RE.test(boardDate)) return tellPrivate(i, "按鈕資料有誤。");

  const pages = getPages(boardDate);
  const target = clampPage(pages, kind === "sel" ? Number(i.values[0]) : Number(parts[2]));

  // 重啟後記憶體是空的：從這則訊息本身重新建立追蹤
  touchBoard({ guildId: i.guildId, channelId: i.channelId, messageId: i.message.id, date: boardDate }, target);
  return i.update(buildView(boardDate, pages, target)); // 直接改這則公開訊息，所有人看到同一頁
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
    .then(() => console.log(`/page-ui-demo 已註冊到測試伺服器 ${guildId}（閒置 ${idleMinutes()} 分鐘自動復位）`))
    .catch((err) => console.warn("註冊 /page-ui-demo 失敗：", err.message));

  client.on(Events.InteractionCreate, (i) => {
    if (i.guildId !== guildId) return; // 只回應測試伺服器
    handleDemoInteraction(i).catch((err) => console.error("page-ui-demo 處理失敗：", err));
  });

  const timer = setInterval(() => {
    resetIdleBoards(client).catch((err) => console.error("班表閒置復位時發生錯誤：", err));
  }, IDLE_CHECK_INTERVAL_MS);
  timer.unref?.();
}
