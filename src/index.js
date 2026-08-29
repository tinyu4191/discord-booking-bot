import "dotenv/config";
import { Client, GatewayIntentBits, Partials, Events, ChannelType, AttachmentBuilder } from "discord.js";
import cron from "node-cron";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  insertBooking,
  getBookingByMessageId,
  updateBookingFromMessage,
  deleteBookingByMessageId,
  deleteBookingById,
  cancelBookingById,
  getBookingsByDate,
  getBlockedSlotsByDate,
  getBlockedSlotByDateTimeRange,
  getBlockedSlotsBySourceRecurringId,
  getBlockedSlotById,
  getAllBlockedSlots,
  insertBlockedSlot,
  deleteBlockedSlot,
  getRecurringBlockedSlotsByWeekday,
  getAllRecurringBlockedSlots,
  getRecurringBlockedSlotById,
  insertRecurringBlockedSlot,
  deleteRecurringBlockedSlot,
  getConfirmedBookingsByDate,
  getSummaryMessage,
  getSummaryByThreadId,
  setSummaryMessage,
  getSummaryPages,
  setSummaryPage,
  deleteSummaryPage,
  getUnlockedPastSummaries,
  markSummaryLocked,
  deleteSummaryMessage,
  deleteAllSummaryPages,
  deleteBookingsByDate,
  getGuildSettings,
  getAllGuildSettings,
} from "./db.js";
import {
  formatGuideText,
  formatThreadTitle,
  formatDateLabel,
  getWeekdayLabel,
  getWeekdayIndex,
  getBookingDateToday,
  getGameWeekRange,
  addDays,
  timeToMinutes,
  parseBookingMessage,
  isBookingAttempt,
  isWithinBlockedSlot,
  getAdminCommandType,
  parseBlockCommand,
  parseRecurringBlockCommand,
  parseWeekdayInput,
  parseUnblockCommand,
  parseTestThreadCommand,
  parseMMDDToFullDate,
  buildSummaryEmbed,
  chunkBookingsForSummary,
} from "./format.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// 0=週日 ... 6=週六 對應的星期圖片檔名，請把對應圖片放到 assets/weekday/ 底下
const WEEKDAY_IMAGE_FILES = ["sun.png", "mon.png", "tue.png", "wed.png", "thu.png", "fri.png", "sat.png"];

// 討論串建立時，預先保留幾頁班表訊息的位置。目前關閉（設成 1 = 不預留），
// 分頁機制本身還是完整保留：真的筆數多到超過長度上限時，還是會自動動態新增分頁
const RESERVED_SUMMARY_PAGES = 1;

client.once(Events.ClientReady, async () => {
  console.log(`已登入：${client.user.tag}`);
  await ensureUpcomingThreadsForAllGuilds();
  await lockPastThreadsForAllGuilds();
  // 每天固定時間：補開新的一天 + 鎖定已過期的討論串（所有已登記的語音群都會跑一次）
  cron.schedule(
    "5 0 * * *",
    async () => {
      await ensureUpcomingThreadsForAllGuilds();
      await lockPastThreadsForAllGuilds();
    },
    { timezone: "Asia/Ho_Chi_Minh" }
  );
});

async function ensureUpcomingThreadsForAllGuilds() {
  for (const settings of getAllGuildSettings()) {
    try {
      await ensureUpcomingThreads(settings);
    } catch (err) {
      console.error(`[${settings.guild_id}] 建立討論串時發生錯誤：`, err);
    }
  }
}

async function lockPastThreadsForAllGuilds() {
  for (const settings of getAllGuildSettings()) {
    try {
      await lockPastThreads(settings);
    } catch (err) {
      console.error(`[${settings.guild_id}] 鎖定討論串時發生錯誤：`, err);
    }
  }
}

// 確保某個語音群「今天 ~ 今天+6天」這 7 天的討論串都已經建立
async function ensureUpcomingThreads(guildSettings) {
  const guildId = guildSettings.guild_id;
  const parent = await client.channels.fetch(guildSettings.booking_parent_channel_id);
  const today = getBookingDateToday();

  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (getSummaryMessage(guildId, date)) continue;

    const title = formatThreadTitle(date);
    const existing = await findExistingThreadByName(parent, title);

    if (existing) {
      const linked = await reuseExistingThread(existing, guildId, date);
      if (linked) {
        console.log(`[${guildId}] 發現既有討論串，已重新連結：${date}`);
        await logToAdmin(guildSettings, `🔗 發現既有討論串，已重新連結：${title}`);
      } else {
        console.warn(`[${guildId}] 找到同名討論串「${title}」，但抓不到統計訊息，略過（可能要手動處理）`);
      }
      continue;
    }

    await createDailyThread(parent, guildId, date);
  }
}

// 在頻道底下（含活躍與已封存）找有沒有同名的討論串，避免重複建立
async function findExistingThreadByName(parent, name) {
  const active = await parent.threads.fetchActive();
  let found = active.threads.find((t) => t.name === name);
  if (found) return found;

  try {
    const archived = await parent.threads.fetchArchived();
    found = archived.threads.find((t) => t.name === name);
  } catch (err) {
    console.warn("查詢已封存討論串失敗：", err.message);
  }
  return found || null;
}

// 找到既有討論串時，從裡面已置頂的 embed 訊息重新連結，不重新建立新的統計訊息
async function reuseExistingThread(thread, guildId, bookingDate) {
  try {
    const pinned = await thread.messages.fetchPinned();
    const statsMsg = pinned.find((m) => m.embeds.length > 0);
    if (!statsMsg) return false;
    setSummaryMessage(guildId, bookingDate, thread.id, statsMsg.id);
    return true;
  } catch (err) {
    console.warn(`重新連結討論串失敗 (${bookingDate})：`, err.message);
    return false;
  }
}

// 把某個語音群「日期已經過去、還沒被鎖定」的討論串鎖定 + 封存（不刪除）
async function lockPastThreads(guildSettings) {
  const guildId = guildSettings.guild_id;
  const today = getBookingDateToday();
  const rows = getUnlockedPastSummaries(guildId, today);

  for (const row of rows) {
    try {
      const thread = await client.channels.fetch(row.channel_id);
      await thread.setLocked(true, "已過期，自動鎖定");
      await thread.setArchived(true, "已過期，自動封存");
      markSummaryLocked(guildId, row.booking_date);
      console.log(`[${guildId}] 已鎖定討論串：${row.booking_date}`);
      await logToAdmin(guildSettings, `🔒 已鎖定討論串：${formatThreadTitle(row.booking_date)}`);
    } catch (err) {
      console.warn(`[${guildId}] 鎖定討論串失敗 (${row.booking_date})：`, err.message);
    }
  }
}

function buildWeekdayAttachment(bookingDate) {
  const fileName = WEEKDAY_IMAGE_FILES[getWeekdayIndex(bookingDate)];
  const filePath = path.join(process.cwd(), "assets", "weekday", fileName);
  if (!existsSync(filePath)) {
    console.warn(`找不到星期圖片：${filePath}（可放進 assets/weekday/ 資料夾）`);
    return null;
  }
  return new AttachmentBuilder(filePath);
}

// 公告用的固定圖片（例如鎖定時段公告的示意圖），放在 assets/announcements/ 底下
function buildAnnouncementAttachment(fileName) {
  const filePath = path.join(process.cwd(), "assets", "announcements", fileName);
  if (!existsSync(filePath)) {
    console.warn(`找不到公告圖片：${filePath}（可放進 assets/announcements/ 資料夾，沒放的話公告照樣會發，只是不會附圖）`);
    return null;
  }
  return new AttachmentBuilder(filePath);
}

// 依鎖定原因挑選公告要附的圖片：原因裡有「出征蝴蝶王」就換成專屬圖，其他一律用預設的 lock.png
function pickLockAnnouncementImage(reasons) {
  const reasonList = Array.isArray(reasons) ? reasons : [reasons];
  const isButterflyKing = reasonList.some((r) => r && r.includes("出征蝴蝶王"));
  return buildAnnouncementAttachment(isButterflyKing ? "butterfly-king.png" : "lock.png");
}

async function createDailyThread(parent, guildId, bookingDate) {
  const guideText = formatGuideText(bookingDate);
  const attachment = buildWeekdayAttachment(bookingDate);
  const files = attachment ? [attachment] : [];
  const isForum = parent.type === ChannelType.GuildForum;

  let thread;
  let guideMsg;

  if (isForum) {
    thread = await parent.threads.create({
      name: formatThreadTitle(bookingDate),
      autoArchiveDuration: 10080,
      reason: "每日自動建立預約討論串",
      message: { content: guideText, files },
    });
    guideMsg = await thread.fetchStarterMessage();
  } else {
    thread = await parent.threads.create({
      name: formatThreadTitle(bookingDate),
      autoArchiveDuration: 10080,
      type: ChannelType.PublicThread,
      reason: "每日自動建立預約討論串",
    });
    guideMsg = await thread.send({ content: guideText, files });
  }
  await guideMsg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));

  const statsEmbed = buildSummaryEmbed(bookingDate, [], 0, RESERVED_SUMMARY_PAGES);
  const statsMsg = await thread.send({ embeds: [statsEmbed] });
  await statsMsg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));
  setSummaryMessage(guildId, bookingDate, thread.id, statsMsg.id);

  for (let i = 1; i < RESERVED_SUMMARY_PAGES; i++) {
    const pageEmbed = buildSummaryEmbed(bookingDate, [], i, RESERVED_SUMMARY_PAGES);
    const pageMsg = await thread.send({ embeds: [pageEmbed] });
    await pageMsg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));
    setSummaryPage(guildId, bookingDate, i, pageMsg.id);
  }

  console.log(`[${guildId}] 已建立討論串：${bookingDate}`);
  const guildSettings = getGuildSettings(guildId);
  await logToAdmin(guildSettings, `🧵 已建立討論串：${formatThreadTitle(bookingDate)}`);

  await materializeRecurringBlocksForDate(guildId, bookingDate);
  await announceBlockedSlotsForNewThread(guildSettings, bookingDate);
}

// 依週期鎖定樣板，把「今天符合星期幾的樣板」自動轉成一筆單次鎖定紀錄。
// 如果同一天同時段已經有人手動先設定過一次性鎖定，就不會重複產生。
async function materializeRecurringBlocksForDate(guildId, bookingDate) {
  const weekday = getWeekdayIndex(bookingDate);
  const templates = getRecurringBlockedSlotsByWeekday(guildId, weekday);

  for (const tpl of templates) {
    const existing = getBlockedSlotByDateTimeRange(guildId, bookingDate, tpl.start_time, tpl.end_time);
    if (existing) continue;
    insertBlockedSlot({
      guildId,
      bookingDate,
      startTime: tpl.start_time,
      endTime: tpl.end_time,
      reason: tpl.reason,
      sourceRecurringId: tpl.id,
    });
  }
}

// 討論串一建立，掃描當天有沒有鎖定時段（含週期樣板剛產生出來的），有的話同步公告
async function announceBlockedSlotsForNewThread(guildSettings, bookingDate) {
  const allSlots = getBlockedSlotsByDate(guildSettings.guild_id, bookingDate);
  if (!allSlots.length) return;

  const lines = allSlots
    .slice()
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))
    .map((s) => `🚫 ${s.start_time} ~ ${s.end_time}${s.reason ? `（原因：${s.reason}）` : ""}`);

  const announcement = `@everyone 📢 ${formatThreadTitle(bookingDate)} 已開放，以下時段目前不開放預約：\n${lines.join("\n")}`;
  const lockImage = pickLockAnnouncementImage(allSlots.map((s) => s.reason));
  await sendAnnouncement(guildSettings, announcement, lockImage ? [lockImage] : []);
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guildId) return; // 忽略私訊

  const guildSettings = getGuildSettings(message.guildId);
  if (!guildSettings) return; // 這個語音群還沒被登記，忽略

  if (guildSettings.management_channel_id && message.channelId === guildSettings.management_channel_id) {
    await handleAdminCommand(message, guildSettings);
    return;
  }

  if (!message.channel.isThread()) return;
  await handleBookingMessage(message, { isEdit: false });
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    const full = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (full.author.bot) return;
    if (!full.guildId) return;
    if (!full.channel.isThread()) return;
    await handleBookingMessage(full, { isEdit: true });
  } catch (err) {
    console.error("處理編輯訊息時發生錯誤：", err);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    const booking = getBookingByMessageId(message.id);
    if (!booking) return;
    deleteBookingByMessageId(message.id);
    await refreshSummaryMessage(booking.guild_id, booking.booking_date);
  } catch (err) {
    console.error("處理刪除訊息時發生錯誤：", err);
  }
});

async function handleBookingMessage(message, { isEdit }) {
  const summaryRow = getSummaryByThreadId(message.channelId);
  if (!summaryRow) return; // 不是預約討論串，忽略
  if (message.id === summaryRow.message_id) return; // 忽略統計訊息本身
  if (!isBookingAttempt(message.content)) return; // 不像預約格式（客服對話/閒聊），直接忽略

  const guildId = message.guildId;
  const guildSettings = getGuildSettings(guildId);

  const { location, time, channel, proxyFor } = parseBookingMessage(message.content);

  if (!location || !time) {
    await safeReact(message, "❌");
    await message
      .reply(
        "格式好像不太對，請確認有填「地點」跟「時間」，例如：\n```\n地點：龍王\n時間：21:30\n頻道：當日決定\n```"
      )
      .catch(() => {});
    return;
  }

  const newMinutes = timeToMinutes(time);
  if (newMinutes === null) {
    await safeReact(message, "❌");
    await message.reply("時間格式看起來不對，請用 24 小時制 HH:MM，例如 21:30。").catch(() => {});
    return;
  }

  const bookingDate = summaryRow.booking_date;
  const existingBooking = getBookingByMessageId(message.id);

  // 鎖定時段檢查：週期鎖定在討論串建立時就已經自動產生對應的單次鎖定紀錄，這裡只需要查單次鎖定表
  const blockedSlot = getBlockedSlotsByDate(guildId, bookingDate).find((slot) => isWithinBlockedSlot(newMinutes, slot));
  if (blockedSlot) {
    await safeReact(message, "🚫");
    await message
      .reply(
        `這個時段（${blockedSlot.start_time} ~ ${blockedSlot.end_time}）目前不開放預約${blockedSlot.reason ? `（原因：${blockedSlot.reason}）` : ""}，請選擇其他時間。`
      )
      .catch(() => {});
    return;
  }

  const conflict = getBookingsByDate(guildId, bookingDate).find((b) => {
    if (existingBooking && b.id === existingBooking.id) return false; // 排除自己（編輯情境）
    const mins = timeToMinutes(b.scheduled_time);
    return mins !== null && Math.abs(mins - newMinutes) < 5;
  });

  if (conflict) {
    await safeReact(message, "❌");
    await message
      .reply(
        `這個時段衝突了：${conflict.location} 在 ${conflict.scheduled_time} 已經有人預約（前後 5 分鐘內不可重複），請改個時間再留言一次。`
      )
      .catch(() => {});
    return;
  }

  if (existingBooking) {
    updateBookingFromMessage(message.id, { location, time, channel, proxyFor });
  } else {
    insertBooking({
      guildId,
      bookingDate,
      messageId: message.id,
      location,
      time,
      channel,
      bookerId: message.author.id,
      proxyFor,
    });
  }

  await safeReact(message, "✅");
  try {
    await refreshSummaryMessage(guildId, bookingDate);
  } catch (err) {
    console.error(`更新班表失敗 (${bookingDate})：`, err);
  }

  if (guildSettings) {
    await logToAdmin(
      guildSettings,
      `📋 ${isEdit ? "更新" : "新"}預約｜${bookingDate}｜${location} / ${time} / ${channel || "當日決定"}｜<@${message.author.id}>`
    );
  }
}

// 把公告推播到某個語音群的公告頻道，並確保 @everyone 真的會 ping 到人
async function sendAnnouncement(guildSettings, text, files = []) {
  if (!guildSettings?.announcement_channel_id) {
    console.warn("這個語音群沒有設定公告頻道，公告訊息略過推播：", text);
    return;
  }
  try {
    const channel = await client.channels.fetch(guildSettings.announcement_channel_id);
    await channel.send({ content: text, files, allowedMentions: { parse: ["everyone", "users"] } });
  } catch (err) {
    console.warn("公告推播失敗：", err.message);
  }
}

// 管理頻道指令：一次性鎖定、週期鎖定、查詢、功能說明
async function handleAdminCommand(message, guildSettings) {
  const commandType = getAdminCommandType(message.content);
  if (!commandType) return;

  if (commandType === "block") {
    await handleBlockCommand(message, guildSettings);
  } else if (commandType === "unblock") {
    await handleUnblockCommand(message, guildSettings);
  } else if (commandType === "list_week") {
    await handleWeekListCommand(message, guildSettings);
  } else if (commandType === "block_recurring") {
    await handleRecurringBlockCommand(message, guildSettings);
  } else if (commandType === "unblock_recurring") {
    await handleRecurringUnblockCommand(message, guildSettings);
  } else if (commandType === "list_recurring") {
    await handleRecurringListCommand(message, guildSettings);
  } else if (commandType === "create_test_thread") {
    await handleCreateTestThreadCommand(message, guildSettings);
  } else if (commandType === "delete_test_thread") {
    await handleDeleteTestThreadCommand(message, guildSettings);
  } else {
    await handleHelpCommand(message);
  }
}

// 「建立測試討論串」指令
async function handleCreateTestThreadCommand(message, guildSettings) {
  const guildId = guildSettings.guild_id;
  const { date } = parseTestThreadCommand(message.content);
  if (!date) {
    await message
      .reply("請附上完整日期（YYYY-MM-DD），例如：\n```\n建立測試討論串：\n日期：2027-03-15\n```")
      .catch(() => {});
    return;
  }

  if (getSummaryMessage(guildId, date)) {
    await message
      .reply(`${date} 已經有討論串了，不會重複建立。要重測請先用「刪除測試討論串」清掉。`)
      .catch(() => {});
    return;
  }

  try {
    const parent = await client.channels.fetch(guildSettings.booking_parent_channel_id);
    await createDailyThread(parent, guildId, date);
    await message.reply(`已建立測試討論串：${date}。測試完記得用「刪除測試討論串」清掉，不要留著。`).catch(() => {});
  } catch (err) {
    console.error(`建立測試討論串失敗 (${date})：`, err);
    await message.reply("建立失敗，請查看伺服器 log（pm2 logs booking-bot）。").catch(() => {});
  }
}

// 「刪除測試討論串」指令
async function handleDeleteTestThreadCommand(message, guildSettings) {
  const guildId = guildSettings.guild_id;
  const { date } = parseTestThreadCommand(message.content);
  if (!date) {
    await message
      .reply("請附上日期（YYYY-MM-DD），例如：\n```\n刪除測試討論串：\n日期：2027-03-15\n```")
      .catch(() => {});
    return;
  }

  const summaryRow = getSummaryMessage(guildId, date);
  if (!summaryRow) {
    await message.reply(`找不到 ${date} 的討論串紀錄。`).catch(() => {});
    return;
  }

  try {
    const thread = await client.channels.fetch(summaryRow.channel_id);
    await thread.delete();
  } catch (err) {
    console.warn(`刪除討論串失敗 (${date})，可能已經被手動刪除：`, err.message);
  }

  deleteAllSummaryPages(guildId, date);
  deleteSummaryMessage(guildId, date);
  deleteBookingsByDate(guildId, date);

  await message.reply(`已刪除 ${date} 的測試討論串與相關資料。`).catch(() => {});
}

// 「查詢本週鎖定」（也接受舊名「查詢鎖定」）：本週定義為週四~下週三
async function handleWeekListCommand(message, guildSettings) {
  const guildId = guildSettings.guild_id;
  const today = getBookingDateToday();
  const { start, end } = getGameWeekRange(today);

  const slots = getAllBlockedSlots(guildId).filter((s) => s.booking_date >= start && s.booking_date <= end);

  if (!slots.length) {
    await message
      .reply(`本週（${formatDateLabel(start)}~${formatDateLabel(end)}）目前沒有任何鎖定時段。`)
      .catch(() => {});
    return;
  }

  const lines = slots
    .slice()
    .sort((a, b) => {
      if (a.booking_date !== b.booking_date) return a.booking_date < b.booking_date ? -1 : 1;
      return timeToMinutes(a.start_time) - timeToMinutes(b.start_time);
    })
    .map((s) => {
      const tag = s.source_recurring_id ? `[週期#${s.source_recurring_id}]` : "[單次]";
      return `#${s.id}｜${tag}｜${formatDateLabel(s.booking_date)} (${getWeekdayLabel(s.booking_date)})｜${s.start_time}~${s.end_time}${s.reason ? `｜${s.reason}` : ""}`;
    });

  await message
    .reply(
      `📋 本週鎖定時段（${formatDateLabel(start)}~${formatDateLabel(end)}）：\n${lines.join("\n")}\n\n` +
        `・要移除任何一筆，都用「解除鎖定：編號：X」（單次跟週期產生的都一樣，用上面列出的 # 編號）\n` +
        `・[週期#N] 代表這筆是從週期鎖定規則 #N 自動產生的，只解除這一筆不影響規則本身，其他週還是照常鎖定`
    )
    .catch(() => {});
}

// 「查詢週期鎖定」指令：列出所有每週固定的鎖定設定
async function handleRecurringListCommand(message, guildSettings) {
  const slots = getAllRecurringBlockedSlots(guildSettings.guild_id);
  if (!slots.length) {
    await message.reply("目前沒有任何週期鎖定設定。").catch(() => {});
    return;
  }

  const weekdayChars = "日一二三四五六";
  const lines = slots.map((s) => {
    const reasonText = s.reason ? `｜${s.reason}` : "";
    return `#${s.id}｜每週${weekdayChars[s.weekday]}｜${s.start_time}~${s.end_time}${reasonText}`;
  });

  await message.reply(`📋 目前的週期鎖定設定：\n${lines.join("\n")}`).catch(() => {});
}

// 「週期鎖定」指令
async function handleRecurringBlockCommand(message, guildSettings) {
  const guildId = guildSettings.guild_id;
  const { weekdayInput, start, end, reason } = parseRecurringBlockCommand(message.content);

  const weekday = parseWeekdayInput(weekdayInput);
  if (weekday === null) {
    await message
      .reply("星期格式錯誤，請填「日一二三四五六」其中一個字（例如「五」代表星期五），或 0~6 的數字（0=週日）。")
      .catch(() => {});
    return;
  }

  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  if (startMin === null || endMin === null || startMin > endMin) {
    await message
      .reply("時間格式錯誤，請確認「開始」「結束」都是 HH:MM 24小時制，且開始時間要早於或等於結束時間。")
      .catch(() => {});
    return;
  }

  const templateId = insertRecurringBlockedSlot({ guildId, weekday, startTime: start, endTime: end, reason });

  const today = getBookingDateToday();
  const affectedGroups = [];
  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (getWeekdayIndex(date) !== weekday) continue;

    const existingBlock = getBlockedSlotByDateTimeRange(guildId, date, start, end);
    if (!existingBlock) {
      insertBlockedSlot({ guildId, bookingDate: date, startTime: start, endTime: end, reason, sourceRecurringId: templateId });
    }

    const affected = getBookingsByDate(guildId, date).filter((b) => {
      const mins = timeToMinutes(b.scheduled_time);
      return mins !== null && isWithinBlockedSlot(mins, { start_time: start, end_time: end });
    });

    for (const b of affected) {
      cancelBookingById(b.id);
    }

    if (affected.length) {
      await refreshSummaryMessage(guildId, date);
      affectedGroups.push({ date, bookings: affected });
    }
  }

  const weekdayLabel = "日一二三四五六"[weekday];
  const reasonText = reason ? `（原因：${reason}）` : "";
  const totalAffected = affectedGroups.reduce((sum, g) => sum + g.bookings.length, 0);

  if (totalAffected) {
    const lines = affectedGroups.flatMap((g) =>
      g.bookings.map((b) => `<@${b.booker_id}>（${formatDateLabel(g.date)} ${b.scheduled_time} / ${b.location}）`)
    );
    const announcement =
      `@everyone 📢 公告：每週${weekdayLabel} ${start} ~ ${end} 這個時段固定不開放預約${reasonText}。\n\n` +
      `以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${lines.join("\n")}`;
    const lockImage = pickLockAnnouncementImage(reason);
    await sendAnnouncement(guildSettings, announcement, lockImage ? [lockImage] : []);
  }

  await message
    .reply(`已設定每週${weekdayLabel} ${start}~${end} 固定鎖定（編號 #${templateId}），取消了 ${totalAffected} 筆衝突的預約。`)
    .catch(() => {});
  await logToAdmin(guildSettings, `🚫 已設定週期鎖定：每週${weekdayLabel} ${start}~${end}${reasonText}，取消 ${totalAffected} 筆預約`);
}

// 「解除週期鎖定」指令
async function handleRecurringUnblockCommand(message, guildSettings) {
  const { id } = parseUnblockCommand(message.content);
  if (!id) {
    await message.reply("請附上要解除的編號，例如：\n```\n解除週期鎖定：\n編號：3\n```").catch(() => {});
    return;
  }

  const slot = getRecurringBlockedSlotById(id);
  if (!slot || slot.guild_id !== guildSettings.guild_id) {
    await message.reply(`找不到編號 #${id} 的週期鎖定設定。`).catch(() => {});
    return;
  }

  deleteRecurringBlockedSlot(id);
  const weekdayLabel = "日一二三四五六"[slot.weekday];

  const today = getBookingDateToday();
  const materialized = getBlockedSlotsBySourceRecurringId(id).filter((s) => s.booking_date >= today);
  for (const m of materialized) {
    deleteBlockedSlot(m.id);
  }

  await message
    .reply(
      `已解除每週${weekdayLabel} ${slot.start_time}~${slot.end_time} 的固定鎖定（編號 #${id}），` +
        `同時清除了 ${materialized.length} 筆已經產生、還沒發生的鎖定。`
    )
    .catch(() => {});

  const unlockImage = buildAnnouncementAttachment("unlock.png");
  await sendAnnouncement(
    guildSettings,
    `@everyone 📢 公告：每週${weekdayLabel} ${slot.start_time} ~ ${slot.end_time} 恢復開放預約囉！`,
    unlockImage ? [unlockImage] : []
  );

  await logToAdmin(guildSettings, `✅ 已解除週期鎖定 #${id}（每週${weekdayLabel} ${slot.start_time}~${slot.end_time}）`);
}

// 「功能查詢」指令：列出管理頻道所有可用指令跟格式
async function handleHelpCommand(message) {
  const helpText = [
    "📖 管理頻道可用指令",
    "",
    "**鎖定** — 鎖定某一天的時段",
    "```\n鎖定：\n日期：MM/DD\n開始：HH:MM\n結束：HH:MM\n原因：(選填)\n```",
    "**解除鎖定** — 移除某筆鎖定（不管是手動設的，還是週期鎖定自動產生的，都用這個指令）",
    "```\n解除鎖定：\n編號：X\n```",
    "**週期鎖定** — 設定每週固定星期幾的時段，到了那天討論串建立時會自動產生對應的單次鎖定",
    "```\n週期鎖定：\n星期：日一二三四五六其中一字\n開始：HH:MM\n結束：HH:MM\n原因：(選填)\n```",
    "**解除週期鎖定** — 永久移除某條週期規則（連同已經產生、還沒發生的鎖定一起清除）",
    "```\n解除週期鎖定：\n編號：X\n```",
    "**查詢本週鎖定**（也可打「查詢鎖定」）— 列出本週（週四~下週三）所有鎖定，含來源標註",
    "**查詢週期鎖定** — 列出所有週期規則跟編號",
    "**建立測試討論串** — 指定任意日期（不受未來7天限制）建立獨立測試用討論串",
    "```\n建立測試討論串：\n日期：YYYY-MM-DD\n```",
    "**刪除測試討論串** — 整串刪除測試討論串跟相關資料",
    "```\n刪除測試討論串：\n日期：YYYY-MM-DD\n```",
    "**功能查詢** — 顯示這份說明",
  ].join("\n");

  await message.reply(helpText).catch(() => {});
}

// 「鎖定」指令
async function handleBlockCommand(message, guildSettings) {
  const guildId = guildSettings.guild_id;
  const { date, start, end, reason } = parseBlockCommand(message.content);

  const bookingDate = parseMMDDToFullDate(date);
  if (!bookingDate) {
    await message.reply("日期格式錯誤，請用 MM/DD，例如 07/20。").catch(() => {});
    return;
  }

  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  if (startMin === null || endMin === null || startMin > endMin) {
    await message
      .reply("時間格式錯誤，請確認「開始」「結束」都是 HH:MM 24小時制，且開始時間要早於或等於結束時間。")
      .catch(() => {});
    return;
  }

  const today = getBookingDateToday();
  if (bookingDate < today) {
    await message.reply(`${date} 已經是過去的日期了，沒辦法鎖定。`).catch(() => {});
    return;
  }

  const blockId = insertBlockedSlot({ guildId, bookingDate, startTime: start, endTime: end, reason });

  const affected = getBookingsByDate(guildId, bookingDate).filter((b) => {
    const mins = timeToMinutes(b.scheduled_time);
    return mins !== null && isWithinBlockedSlot(mins, { start_time: start, end_time: end });
  });

  for (const b of affected) {
    cancelBookingById(b.id);
  }

  await refreshSummaryMessage(guildId, bookingDate);

  const reasonText = reason ? `（原因：${reason}）` : "";
  if (affected.length) {
    const tags = affected.map((b) => `<@${b.booker_id}>（原本 ${b.scheduled_time} / ${b.location}）`).join("\n");
    const announcement =
      `@everyone 📢 公告：${date} ${start} ~ ${end} 這個時段目前不開放預約${reasonText}。\n\n` +
      `以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${tags}`;
    const lockImage = pickLockAnnouncementImage(reason);
    await sendAnnouncement(guildSettings, announcement, lockImage ? [lockImage] : []);
  }

  await message
    .reply(`已鎖定 ${date} ${start}~${end}（編號 #${blockId}），取消了 ${affected.length} 筆衝突的預約。`)
    .catch(() => {});
  await logToAdmin(guildSettings, `🚫 已鎖定 ${date} ${start}~${end}${reasonText}，取消 ${affected.length} 筆預約`);
}

// 「解除鎖定」指令
async function handleUnblockCommand(message, guildSettings) {
  const { id } = parseUnblockCommand(message.content);
  if (!id) {
    await message.reply("請附上要解除的編號，例如：\n```\n解除鎖定：\n編號：7\n```").catch(() => {});
    return;
  }

  const slot = getBlockedSlotById(id);
  if (!slot || slot.guild_id !== guildSettings.guild_id) {
    await message.reply(`找不到編號 #${id} 的鎖定設定。`).catch(() => {});
    return;
  }

  deleteBlockedSlot(id);
  await message
    .reply(`已解除鎖定 #${id}（${slot.booking_date} ${slot.start_time}~${slot.end_time}）。`)
    .catch(() => {});

  const summaryRow = getSummaryMessage(guildSettings.guild_id, slot.booking_date);
  if (summaryRow) {
    const unlockImage = buildAnnouncementAttachment("unlock.png");
    await sendAnnouncement(
      guildSettings,
      `@everyone 📢 公告：${slot.start_time} ~ ${slot.end_time} 這個時段恢復開放預約囉！`,
      unlockImage ? [unlockImage] : []
    );
  }

  await logToAdmin(guildSettings, `✅ 已解除鎖定 #${id}（${slot.booking_date} ${slot.start_time}~${slot.end_time}）`);
}

async function safeReact(message, emoji) {
  try {
    await message.react(emoji);
  } catch (err) {
    console.warn("加上反應失敗：", err.message);
  }
}

// 把訊息推播到某個語音群的機器人紀錄頻道（純紀錄用，沒設定的話跳過）
async function logToAdmin(guildSettings, text) {
  if (!guildSettings?.admin_channel_id) return;
  try {
    const adminChannel = await client.channels.fetch(guildSettings.admin_channel_id);
    await adminChannel.send(text);
  } catch (err) {
    console.warn("管理頻道紀錄推播失敗：", err.message);
  }
}

// 重新渲染 & 編輯（並確保置頂）指定語音群、指定日期的班表 embed
async function refreshSummaryMessage(guildId, bookingDate) {
  const summaryRow = getSummaryMessage(guildId, bookingDate);
  if (!summaryRow) return;

  const bookings = getConfirmedBookingsByDate(guildId, bookingDate);
  const pages = chunkBookingsForSummary(bookings);
  const totalPages = pages.length;
  const displayPages = Math.max(totalPages, RESERVED_SUMMARY_PAGES);

  const thread = await client.channels.fetch(summaryRow.channel_id);

  const embed0 = buildSummaryEmbed(bookingDate, pages[0] || [], 0, displayPages);
  const msg0 = await thread.messages.fetch(summaryRow.message_id);
  await msg0.edit({ embeds: [embed0] });
  if (!msg0.pinned) {
    await msg0.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));
  }

  const existingPages = getSummaryPages(guildId, bookingDate);

  for (let i = 1; i < displayPages; i++) {
    const embed = buildSummaryEmbed(bookingDate, pages[i] || [], i, displayPages);
    const existing = existingPages.find((p) => p.page_index === i);

    if (existing) {
      try {
        const msg = await thread.messages.fetch(existing.message_id);
        await msg.edit({ embeds: [embed] });
        continue;
      } catch (err) {
        console.warn(`分頁訊息抓不到，重新建立 (${bookingDate} 第 ${i + 1} 頁)：`, err.message);
      }
    }

    const newMsg = await thread.send({ embeds: [embed] });
    await newMsg.pin().catch((err) => console.warn("分頁訊息置頂失敗：", err.message));
    setSummaryPage(guildId, bookingDate, i, newMsg.id);
  }

  for (const p of existingPages) {
    if (p.page_index >= displayPages) {
      try {
        const oldMsg = await thread.messages.fetch(p.message_id);
        await oldMsg.delete();
      } catch (err) {
        console.warn(`清除多餘分頁訊息失敗 (${bookingDate} 第 ${p.page_index + 1} 頁)：`, err.message);
      }
      deleteSummaryPage(guildId, bookingDate, p.page_index);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
