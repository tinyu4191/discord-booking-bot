// 班表（每天討論串裡那則置頂的統計訊息）：單一訊息 + 翻頁
//
// 以前：預約多到一頁放不下時，多出來的頁面會另外發成好幾則訊息（各自置頂）。
// 現在：永遠只有一則班表訊息，下面有「下拉選單 + 上一頁／下一頁」按鈕，翻頁直接改這則訊息。
//
//   - 翻頁是所有人共用的：按鈕、下拉選單直接改這則公開訊息（最後操作的人決定看到哪一頁）
//   - 時段衝突時，機器人先把班表切到「想預約的時間所在的那一頁」，再回覆衝突說明 + 連回班表的連結
//   - 閒置自動復位：班表超過 PAGE_IDLE_MINUTES 分鐘沒人操作，就自動回到「現在時間之後」那一頁
//     （每 PAGE_IDLE_CHECK_SECONDS 秒檢查一次）
//   - 舊版遺留的多餘分頁訊息會被刪掉（機器人啟動時一次處理完所有還沒過期的討論串）
//
// 「目前停在第幾頁、最後操作時間」存在資料庫（daily_summary.current_page / last_touch），重啟不會忘。

import { Events, MessageFlags } from "discord.js";
import {
  getConfirmedBookingsByDate,
  getSummaryMessage,
  getSummaryByThreadId,
  getSummaryPages,
  deleteSummaryPage,
  setSummaryView,
  markSummaryLayout,
  getActiveSummaries,
  getLegacyLayoutSummaries,
  getAllGuildSettings,
} from "./db.js";
import {
  SUMMARY_PAGER_PREFIX,
  buildSummaryComponents,
  buildSummaryEmbed,
  chunkBookingsForSummary,
  clampPage,
  defaultPageIndex,
  getBookingDateToday,
  pageForMinutes,
} from "./format.js";

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 閒置幾分鐘沒人操作，就自動回到「現在時間之後」那一頁（.env: PAGE_IDLE_MINUTES，預設 10）
const idleMinutes = () => positiveNumber(process.env.PAGE_IDLE_MINUTES, 10);
// 多久檢查一次有沒有班表該復位（.env: PAGE_IDLE_CHECK_SECONDS，預設 300 秒 = 5 分鐘）
const idleCheckSeconds = () => positiveNumber(process.env.PAGE_IDLE_CHECK_SECONDS, 300);

let client = null; // 由 setupSummaryBoard 注入

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 渲染 / 編輯班表訊息
// ---------------------------------------------------------------------------

function buildBoardPayload(bookingDate, pages, pageIndex) {
  return {
    embeds: [buildSummaryEmbed(bookingDate, pages[pageIndex] || [], pageIndex, pages.length)],
    components: buildSummaryComponents(pages, pageIndex),
  };
}

async function fetchBoardMessage(row) {
  const thread = await client.channels.fetch(row.channel_id);
  const msg = await thread.messages.fetch(row.message_id);
  return { thread, msg };
}

async function editBoard(row, pages, pageIndex) {
  const { thread, msg } = await fetchBoardMessage(row);
  await msg.edit(buildBoardPayload(row.booking_date, pages, pageIndex));
  if (!msg.pinned) {
    await msg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));
  }
  return thread;
}

// 舊版遺留的多餘分頁訊息：把 Discord 上的訊息刪掉、資料庫紀錄也清掉。
// 訊息已經不存在（Unknown Message）就直接清紀錄；其他錯誤（例如缺權限）保留紀錄，下次更新再試
async function removeLegacyPages(row, thread) {
  for (const p of getSummaryPages(row.guild_id, row.booking_date)) {
    try {
      const old = await thread.messages.fetch(p.message_id);
      await old.delete();
    } catch (err) {
      if (err.code !== 10008 && !/Unknown Message/i.test(err.message || "")) {
        console.warn(`清除舊分頁訊息失敗 (${row.booking_date} 第 ${p.page_index + 1} 頁)，下次更新再試：`, err.message);
        continue;
      }
    }
    deleteSummaryPage(row.guild_id, row.booking_date, p.page_index);
  }
}

// 重新渲染指定語音群、指定日期的班表（預約有新增／修改／取消時呼叫）。
//   - 停在哪一頁：有人操作過就維持原本的頁（頁數變少時夾回合法範圍）；從來沒人操作過就停在「現在」那一頁
//   - 順便把舊版遺留的多餘分頁訊息清掉
export async function refreshSummaryMessage(guildId, bookingDate) {
  const row = getSummaryMessage(guildId, bookingDate);
  if (!row) return;

  const pages = chunkBookingsForSummary(getConfirmedBookingsByDate(guildId, bookingDate));
  const page = row.last_touch === 0 ? defaultPageIndex(bookingDate, pages) : clampPage(pages, row.current_page);

  const thread = await editBoard(row, pages, page);
  setSummaryView(guildId, bookingDate, page);
  markSummaryLayout(guildId, bookingDate, 1);
  await removeLegacyPages(row, thread);
}

// 把班表切到指定頁，並記錄「剛剛有人操作」（重新計算閒置時間）。成功回傳 true
export async function showSummaryPage(guildId, bookingDate, pageIndex, { now = Date.now() } = {}) {
  const row = getSummaryMessage(guildId, bookingDate);
  if (!row || row.locked) return false;

  const pages = chunkBookingsForSummary(getConfirmedBookingsByDate(guildId, bookingDate));
  const page = clampPage(pages, pageIndex);
  await editBoard(row, pages, page);
  setSummaryView(guildId, bookingDate, page, now);
  return true;
}

// 時段衝突時用：把班表切到「想預約的那個時間」所在的那一頁
export async function showSummaryPageForMinutes(guildId, bookingDate, minutes) {
  const pages = chunkBookingsForSummary(getConfirmedBookingsByDate(guildId, bookingDate));
  return showSummaryPage(guildId, bookingDate, pageForMinutes(pages, minutes));
}

// ---------------------------------------------------------------------------
// 閒置自動復位
// ---------------------------------------------------------------------------

// 超過 idleMs 沒人操作、而且目前停的頁不是「現在」那一頁 → 切回現在那一頁。回傳這輪復位的班表數量。
// 還是舊版版面的班表（layout_version = 0）不在這裡處理，啟動時的遷移會處理
export async function resetIdleSummaries({ now = Date.now(), idleMs = idleMinutes() * 60 * 1000, nowMinutes } = {}) {
  let count = 0;
  const today = getBookingDateToday();

  for (const settings of getAllGuildSettings()) {
    for (const row of getActiveSummaries(settings.guild_id, today)) {
      if (row.layout_version !== 1) continue;
      if (now - row.last_touch < idleMs) continue;

      try {
        const pages = chunkBookingsForSummary(getConfirmedBookingsByDate(row.guild_id, row.booking_date));
        const target = defaultPageIndex(row.booking_date, pages, nowMinutes);
        if (target === clampPage(pages, row.current_page)) continue; // 已經在該停的那一頁
        if (await showSummaryPage(row.guild_id, row.booking_date, target, { now })) count++;
      } catch (err) {
        console.warn(`[${row.guild_id}] 班表閒置復位失敗 (${row.booking_date})：`, err.message);
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 啟動時遷移：還沒過期（今天含以後）而且還是舊版版面的班表，換成新版面並刪掉多餘的分頁訊息
// ---------------------------------------------------------------------------
export async function migrateLegacySummaries({ delayMs = 500 } = {}) {
  let migrated = 0;
  const today = getBookingDateToday();

  for (const settings of getAllGuildSettings()) {
    for (const row of getLegacyLayoutSummaries(settings.guild_id, today)) {
      try {
        await refreshSummaryMessage(row.guild_id, row.booking_date);
        migrated++;
        console.log(`[${row.guild_id}] 班表已換成新版面：${row.booking_date}`);
      } catch (err) {
        console.warn(`[${row.guild_id}] 班表換新版面失敗 (${row.booking_date})，下次啟動再試：`, err.message);
      }
      if (delayMs) await sleep(delayMs); // 一則一則慢慢處理，避免碰到 Discord 速率限制
    }
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// 按鈕 / 下拉選單
// ---------------------------------------------------------------------------

const tellPrivate = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

export async function handlePagerInteraction(i) {
  const isComponent = (i.isButton?.() || i.isStringSelectMenu?.()) && i.customId?.startsWith(`${SUMMARY_PAGER_PREFIX}|`);
  if (!isComponent) return false;

  // 只認「這個討論串的班表訊息」上的元件，其他地方（或別的語音群）的一律忽略
  const row = getSummaryByThreadId(i.channelId);
  if (!row || row.guild_id !== i.guildId || row.message_id !== i.message?.id) {
    await tellPrivate(i, "找不到這個班表，可能已經被更新或清除了。");
    return true;
  }
  if (row.locked) {
    await tellPrivate(i, "這一天已經結束，班表不能再翻頁了。");
    return true;
  }

  const parts = i.customId.split("|");
  const kind = parts[1];
  if (kind !== "go" && kind !== "sel") {
    await tellPrivate(i, "未知的操作。");
    return true;
  }

  const pages = chunkBookingsForSummary(getConfirmedBookingsByDate(row.guild_id, row.booking_date));
  const page = clampPage(pages, kind === "sel" ? Number(i.values?.[0]) : Number(parts[2]));

  await i.update(buildBoardPayload(row.booking_date, pages, page)); // 直接改這則公開訊息，所有人看到同一頁
  setSummaryView(row.guild_id, row.booking_date, page, Date.now());
  return true;
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------

export function setupSummaryBoard(discordClient) {
  client = discordClient;

  client.on(Events.InteractionCreate, (i) => {
    handlePagerInteraction(i).catch((err) => console.error("處理班表翻頁時發生錯誤：", err));
  });

  const timer = setInterval(() => {
    if (!client.isReady()) return;
    resetIdleSummaries().catch((err) => console.error("班表閒置復位時發生錯誤：", err));
  }, idleCheckSeconds() * 1000);
  timer.unref?.();

  console.log(`班表翻頁已啟動：閒置 ${idleMinutes()} 分鐘沒人操作就回到現在時段，每 ${idleCheckSeconds()} 秒檢查一次`);
}
