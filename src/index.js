import "dotenv/config";
import { Client, GatewayIntentBits, Partials, Events, ChannelType, AttachmentBuilder } from "discord.js";
import cron from "node-cron";
import { existsSync } from "node:fs";
import fs from "node:fs";
import http from "node:http";
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
  getUnlockedPastSummaries,
  markSummaryLocked,
} from "./db.js";
import { generateWeeklyReport, saveReport } from "./report.js";
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
  parseMMDDToFullDate,
  buildSummaryEmbed,
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

client.once(Events.ClientReady, async () => {
  console.log(`已登入：${client.user.tag}`);
  await ensureUpcomingThreads();
  await lockPastThreads();
  // 每天固定時間：補開新的一天 + 鎖定已過期的討論串
  cron.schedule(
    "5 0 * * *",
    async () => {
      await ensureUpcomingThreads();
      await lockPastThreads();
    },
    { timezone: "Asia/Ho_Chi_Minh" }
  );

  // 每週四凌晨（新的一週剛開始時）自動產生「剛結束的上一週」統計報告
  cron.schedule(
    "15 0 * * 4",
    () => {
      try {
        const today = getBookingDateToday();
        const { start: currentWeekStart } = getGameWeekRange(today);
        const lastWeekStart = addDays(currentWeekStart, -7);
        const report = generateWeeklyReport(lastWeekStart);
        const filePath = saveReport(report);
        console.log(`已自動產生上週報告：${filePath}（${report.totalConfirmed} 場）`);
      } catch (err) {
        console.error("自動產生週報告失敗：", err);
      }
    },
    { timezone: "Asia/Ho_Chi_Minh" }
  );
});

// 確保「今天 ~ 今天+6天」這 7 天的討論串都已經建立
async function ensureUpcomingThreads() {
  const parent = await client.channels.fetch(process.env.BOOKING_PARENT_CHANNEL_ID);
  const today = getBookingDateToday();

  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (getSummaryMessage(date)) continue;

    const title = formatThreadTitle(date);
    const existing = await findExistingThreadByName(parent, title);

    if (existing) {
      const linked = await reuseExistingThread(existing, date);
      if (linked) {
        console.log(`發現既有討論串，已重新連結：${date}`);
        await logToAdmin(`🔗 發現既有討論串，已重新連結：${title}`);
      } else {
        console.warn(`找到同名討論串「${title}」，但抓不到統計訊息，略過（可能要手動處理）`);
      }
      continue;
    }

    await createDailyThread(parent, date);
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
async function reuseExistingThread(thread, bookingDate) {
  try {
    const pinned = await thread.messages.fetchPinned();
    const statsMsg = pinned.find((m) => m.embeds.length > 0);
    if (!statsMsg) return false;
    setSummaryMessage(bookingDate, thread.id, statsMsg.id);
    return true;
  } catch (err) {
    console.warn(`重新連結討論串失敗 (${bookingDate})：`, err.message);
    return false;
  }
}

// 把日期已經過去、還沒被鎖定的討論串鎖定 + 封存（不刪除）
async function lockPastThreads() {
  const today = getBookingDateToday();
  const rows = getUnlockedPastSummaries(today);

  for (const row of rows) {
    try {
      const thread = await client.channels.fetch(row.channel_id);
      await thread.setLocked(true, "已過期，自動鎖定");
      await thread.setArchived(true, "已過期，自動封存");
      markSummaryLocked(row.booking_date);
      console.log(`已鎖定討論串：${row.booking_date}`);
      await logToAdmin(`🔒 已鎖定討論串：${formatThreadTitle(row.booking_date)}`);
    } catch (err) {
      console.warn(`鎖定討論串失敗 (${row.booking_date})：`, err.message);
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
// reasons 可以是單一原因字串，也可以是一組原因（多筆鎖定同時公告時，只要其中一個符合就換圖）
function pickLockAnnouncementImage(reasons) {
  const reasonList = Array.isArray(reasons) ? reasons : [reasons];
  const isButterflyKing = reasonList.some((r) => r && r.includes("出征蝴蝶王"));
  return buildAnnouncementAttachment(isButterflyKing ? "butterfly-king.png" : "lock.png");
}

async function createDailyThread(parent, bookingDate) {
  const guideText = formatGuideText(bookingDate);
  const attachment = buildWeekdayAttachment(bookingDate);
  const files = attachment ? [attachment] : [];
  const isForum = parent.type === ChannelType.GuildForum;

  let thread;
  let guideMsg;

  if (isForum) {
    // 論壇頻道：建立討論串時「必須」同時附上第一則訊息
    thread = await parent.threads.create({
      name: formatThreadTitle(bookingDate),
      autoArchiveDuration: 10080,
      reason: "每日自動建立預約討論串",
      message: { content: guideText, files },
    });
    guideMsg = await thread.fetchStarterMessage();
  } else {
    // 一般文字頻道：先建立空討論串，再發第一則訊息
    thread = await parent.threads.create({
      name: formatThreadTitle(bookingDate),
      autoArchiveDuration: 10080,
      type: ChannelType.PublicThread,
      reason: "每日自動建立預約討論串",
    });
    guideMsg = await thread.send({ content: guideText, files });
  }
  await guideMsg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));

  // 班表用獨立的 embed 訊息呈現，跟上面的說明分開，比較顯眼
  const statsEmbed = buildSummaryEmbed(bookingDate, []);
  const statsMsg = await thread.send({ embeds: [statsEmbed] });
  await statsMsg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));

  setSummaryMessage(bookingDate, thread.id, statsMsg.id);
  console.log(`已建立討論串：${bookingDate}`);
  await logToAdmin(`🧵 已建立討論串：${formatThreadTitle(bookingDate)}`);

  await materializeRecurringBlocksForDate(bookingDate);
  await announceBlockedSlotsForNewThread(bookingDate);
}

// 依週期鎖定樣板，把「今天符合星期幾的樣板」自動轉成一筆單次鎖定紀錄。
// 如果同一天同時段已經有人手動先設定過一次性鎖定，就不會重複產生。
async function materializeRecurringBlocksForDate(bookingDate) {
  const weekday = getWeekdayIndex(bookingDate);
  const templates = getRecurringBlockedSlotsByWeekday(weekday);

  for (const tpl of templates) {
    const existing = getBlockedSlotByDateTimeRange(bookingDate, tpl.start_time, tpl.end_time);
    if (existing) continue;
    insertBlockedSlot({
      bookingDate,
      startTime: tpl.start_time,
      endTime: tpl.end_time,
      reason: tpl.reason,
      sourceRecurringId: tpl.id,
    });
  }
}

// 討論串一建立，掃描當天有沒有鎖定時段（含週期樣板剛產生出來的），有的話同步公告
async function announceBlockedSlotsForNewThread(bookingDate) {
  const allSlots = getBlockedSlotsByDate(bookingDate);
  if (!allSlots.length) return;

  const lines = allSlots
    .slice()
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))
    .map((s) => `🚫 ${s.start_time} ~ ${s.end_time}${s.reason ? `（原因：${s.reason}）` : ""}`);

  const announcement = `@everyone 📢 ${formatThreadTitle(bookingDate)} 已開放，以下時段目前不開放預約：\n${lines.join("\n")}`;
  const lockImage = pickLockAnnouncementImage(allSlots.map((s) => s.reason));
  await sendAnnouncement(announcement, lockImage ? [lockImage] : []);
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.channelId === process.env.MANAGEMENT_CHANNEL_ID) {
    await handleAdminCommand(message);
    return;
  }

  if (!message.channel.isThread()) return;
  await handleBookingMessage(message, { isEdit: false });
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    const full = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (full.author.bot) return;
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
    await refreshSummaryMessage(booking.booking_date);
  } catch (err) {
    console.error("處理刪除訊息時發生錯誤：", err);
  }
});

async function handleBookingMessage(message, { isEdit }) {
  const summaryRow = getSummaryByThreadId(message.channelId);
  if (!summaryRow) return; // 不是預約討論串，忽略
  if (message.id === summaryRow.message_id) return; // 忽略統計訊息本身
  if (!isBookingAttempt(message.content)) return; // 不像預約格式（客服對話/閒聊），直接忽略

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
  const blockedSlot = getBlockedSlotsByDate(bookingDate).find((slot) => isWithinBlockedSlot(newMinutes, slot));
  if (blockedSlot) {
    await safeReact(message, "🚫");
    await message
      .reply(
        `這個時段（${blockedSlot.start_time} ~ ${blockedSlot.end_time}）目前不開放預約${blockedSlot.reason ? `（原因：${blockedSlot.reason}）` : ""}，請選擇其他時間。`
      )
      .catch(() => {});
    return;
  }

  const conflict = getBookingsByDate(bookingDate).find((b) => {
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
      guildId: message.guildId,
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
  await refreshSummaryMessage(bookingDate);
  await logToAdmin(
    `📋 ${isEdit ? "更新" : "新"}預約｜${bookingDate}｜${location} / ${time} / ${channel || "當日決定"}｜<@${message.author.id}>`
  );
}

// 把公告推播到獨立的公告頻道（跟討論串分開），並確保 @everyone 真的會 ping 到人
async function sendAnnouncement(text, files = []) {
  if (!process.env.ANNOUNCEMENT_CHANNEL_ID) {
    console.warn("沒有設定 ANNOUNCEMENT_CHANNEL_ID，公告訊息略過推播：", text);
    return;
  }
  try {
    const channel = await client.channels.fetch(process.env.ANNOUNCEMENT_CHANNEL_ID);
    await channel.send({ content: text, files, allowedMentions: { parse: ["everyone", "users"] } });
  } catch (err) {
    console.warn("公告推播失敗：", err.message);
  }
}

// 管理頻道指令：一次性鎖定、週期鎖定、查詢、功能說明
// 其他訊息當一般聊天忽略，不處理也不回覆
async function handleAdminCommand(message) {
  const commandType = getAdminCommandType(message.content);
  if (!commandType) return;

  if (commandType === "block") {
    await handleBlockCommand(message);
  } else if (commandType === "unblock") {
    await handleUnblockCommand(message);
  } else if (commandType === "list_week") {
    await handleWeekListCommand(message);
  } else if (commandType === "block_recurring") {
    await handleRecurringBlockCommand(message);
  } else if (commandType === "unblock_recurring") {
    await handleRecurringUnblockCommand(message);
  } else if (commandType === "list_recurring") {
    await handleRecurringListCommand(message);
  } else {
    await handleHelpCommand(message);
  }
}

// 「查詢本週鎖定」（也接受舊名「查詢鎖定」）：本週定義為週四~下週三。
// 一次性鎖定跟週期樣板產生出來的鎖定，本質上都是同一張表的紀錄，直接查、統一用 [單次]/[週期#N] 標註來源
async function handleWeekListCommand(message) {
  const today = getBookingDateToday();
  const { start, end } = getGameWeekRange(today);

  const slots = getAllBlockedSlots().filter((s) => s.booking_date >= start && s.booking_date <= end);

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
async function handleRecurringListCommand(message) {
  const slots = getAllRecurringBlockedSlots();
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

// 「週期鎖定」指令：寫入每週固定鎖定 → 掃描未來7天內已存在且符合星期的預約，取消衝突的 → 公告 → 回覆管理頻道
async function handleRecurringBlockCommand(message) {
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

  const templateId = insertRecurringBlockedSlot({ weekday, startTime: start, endTime: end, reason });

  // 掃描目前已存在討論串的未來 7 天內，符合這個星期幾的日期：
  // 先產生對應的單次鎖定紀錄（已經有的話不重複），再取消時間衝突的預約
  const today = getBookingDateToday();
  const affectedGroups = [];
  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (getWeekdayIndex(date) !== weekday) continue;

    const existingBlock = getBlockedSlotByDateTimeRange(date, start, end);
    if (!existingBlock) {
      insertBlockedSlot({ bookingDate: date, startTime: start, endTime: end, reason, sourceRecurringId: templateId });
    }

    const affected = getBookingsByDate(date).filter((b) => {
      const mins = timeToMinutes(b.scheduled_time);
      return mins !== null && isWithinBlockedSlot(mins, { start_time: start, end_time: end });
    });

    for (const b of affected) {
      cancelBookingById(b.id);
    }

    if (affected.length) {
      await refreshSummaryMessage(date);
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
    await sendAnnouncement(announcement, lockImage ? [lockImage] : []);
  }
  // 沒有任何預約受影響時不主動公告，等對應日期的討論串建立時再一併公告（見 announceBlockedSlotsForNewThread）

  await message
    .reply(`已設定每週${weekdayLabel} ${start}~${end} 固定鎖定（編號 #${templateId}），取消了 ${totalAffected} 筆衝突的預約。`)
    .catch(() => {});
  await logToAdmin(`🚫 已設定週期鎖定：每週${weekdayLabel} ${start}~${end}${reasonText}，取消 ${totalAffected} 筆預約`);
}

// 「解除週期鎖定」指令：依編號刪除週期鎖定，並公告恢復開放
async function handleRecurringUnblockCommand(message) {
  const { id } = parseUnblockCommand(message.content);
  if (!id) {
    await message.reply("請附上要解除的編號，例如：\n```\n解除週期鎖定：\n編號：3\n```").catch(() => {});
    return;
  }

  const slot = getRecurringBlockedSlotById(id);
  if (!slot) {
    await message.reply(`找不到編號 #${id} 的週期鎖定設定。`).catch(() => {});
    return;
  }

  deleteRecurringBlockedSlot(id);
  const weekdayLabel = "日一二三四五六"[slot.weekday];

  // 同步清掉這條樣板已經產生出來、還沒過期的單次鎖定，讓「解除」立刻生效，不用等到下週
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
    `@everyone 📢 公告：每週${weekdayLabel} ${slot.start_time} ~ ${slot.end_time} 恢復開放預約囉！`,
    unlockImage ? [unlockImage] : []
  );

  await logToAdmin(`✅ 已解除週期鎖定 #${id}（每週${weekdayLabel} ${slot.start_time}~${slot.end_time}）`);
}

// 「跳過週期鎖定」指令：某條週期規則，這一次（指定日期）先不套用，其他週照常鎖定
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
    "**功能查詢** — 顯示這份說明",
  ].join("\n");

  await message.reply(helpText).catch(() => {});
}

// 「鎖定」指令：寫入鎖定時段 → 刪除已衝突的預約 → 討論串發公告 tag 受影響的人 → 回覆管理頻道
async function handleBlockCommand(message) {
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

  // 討論串還沒建立也沒關係（例如提早鎖定下週五）：鎖定資料本身跟討論串是否存在無關，
  // 等討論串之後自動建立時，這個時段自然就會是不開放狀態，refreshSummaryMessage 內部
  // 找不到討論串時本來就會安全地不做任何事

  const blockId = insertBlockedSlot({ bookingDate, startTime: start, endTime: end, reason });

  // 找出這個時段內已經存在的預約，刪除並記錄下來準備通知
  const affected = getBookingsByDate(bookingDate).filter((b) => {
    const mins = timeToMinutes(b.scheduled_time);
    return mins !== null && isWithinBlockedSlot(mins, { start_time: start, end_time: end });
  });

  for (const b of affected) {
    cancelBookingById(b.id);
  }

  await refreshSummaryMessage(bookingDate);

  const reasonText = reason ? `（原因：${reason}）` : "";
  if (affected.length) {
    const tags = affected.map((b) => `<@${b.booker_id}>（原本 ${b.scheduled_time} / ${b.location}）`).join("\n");
    const announcement =
      `@everyone 📢 公告：${date} ${start} ~ ${end} 這個時段目前不開放預約${reasonText}。\n\n` +
      `以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${tags}`;
    const lockImage = pickLockAnnouncementImage(reason);
    await sendAnnouncement(announcement, lockImage ? [lockImage] : []);
  }
  // 沒有任何預約受影響時不主動公告，等這一天的討論串建立時再一併公告（見 announceBlockedSlotsForNewThread）

  await message
    .reply(`已鎖定 ${date} ${start}~${end}（編號 #${blockId}），取消了 ${affected.length} 筆衝突的預約。`)
    .catch(() => {});
  await logToAdmin(`🚫 已鎖定 ${date} ${start}~${end}${reasonText}，取消 ${affected.length} 筆預約`);
}

// 「解除鎖定」指令：依編號刪除鎖定設定，並在討論串公告恢復開放
async function handleUnblockCommand(message) {
  const { id } = parseUnblockCommand(message.content);
  if (!id) {
    await message.reply("請附上要解除的編號，例如：\n```\n解除鎖定：\n編號：7\n```").catch(() => {});
    return;
  }

  const slot = getBlockedSlotById(id);
  if (!slot) {
    await message.reply(`找不到編號 #${id} 的鎖定設定。`).catch(() => {});
    return;
  }

  deleteBlockedSlot(id);
  await message
    .reply(`已解除鎖定 #${id}（${slot.booking_date} ${slot.start_time}~${slot.end_time}）。`)
    .catch(() => {});

  const summaryRow = getSummaryMessage(slot.booking_date);
  if (summaryRow) {
    const unlockImage = buildAnnouncementAttachment("unlock.png");
    await sendAnnouncement(
      `@everyone 📢 公告：${slot.start_time} ~ ${slot.end_time} 這個時段恢復開放預約囉！`,
      unlockImage ? [unlockImage] : []
    );
  }

  await logToAdmin(`✅ 已解除鎖定 #${id}（${slot.booking_date} ${slot.start_time}~${slot.end_time}）`);
}

async function safeReact(message, emoji) {
  try {
    await message.react(emoji);
  } catch (err) {
    console.warn("加上反應失敗：", err.message);
  }
}

// 把訊息推播到管理頻道（純紀錄用，沒設定 ADMIN_CHANNEL_ID 就跳過）
async function logToAdmin(text) {
  if (!process.env.ADMIN_CHANNEL_ID) return;
  try {
    const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    await adminChannel.send(text);
  } catch (err) {
    console.warn("管理頻道紀錄推播失敗：", err.message);
  }
}

// 重新渲染 & 編輯（並確保置頂）指定日期的班表 embed
async function refreshSummaryMessage(bookingDate) {
  const summaryRow = getSummaryMessage(bookingDate);
  if (!summaryRow) return;

  const bookings = getConfirmedBookingsByDate(bookingDate);
  const embed = buildSummaryEmbed(bookingDate, bookings);

  const thread = await client.channels.fetch(summaryRow.channel_id);
  const msg = await thread.messages.fetch(summaryRow.message_id);
  await msg.edit({ embeds: [embed] });
  if (!msg.pinned) {
    await msg.pin().catch((err) => console.warn("置頂失敗（可能缺少 Manage Messages 權限）：", err.message));
  }
}

// 輕量靜態檔案伺服器：讓 reports/report.html 可以直接用瀏覽器連線查看，不用每次下載
// 只服務 reports/ 資料夾底下的檔案，不會暴露專案其他部分
function startReportsServer() {
  const port = Number(process.env.REPORTS_SERVER_PORT) || 8080;
  const reportsDir = path.join(process.cwd(), "reports");

  const mimeTypes = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8" };

  http
    .createServer((req, res) => {
      const urlPath = req.url === "/" ? "/report.html" : req.url;
      const filePath = path.join(reportsDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));

      if (!filePath.startsWith(reportsDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
        res.end(data);
      });
    })
    .listen(port, () => {
      console.log(`週報告網頁伺服器已啟動：http://<VM對外IP>:${port}/report.html`);
    });
}

startReportsServer();

client.login(process.env.DISCORD_TOKEN);