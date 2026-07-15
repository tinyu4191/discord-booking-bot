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
  getBookingsByDate,
  getConfirmedBookingsByDate,
  getSummaryMessage,
  getSummaryByThreadId,
  setSummaryMessage,
  getUnlockedPastSummaries,
  markSummaryLocked,
} from "./db.js";
import {
  formatGuideText,
  formatThreadTitle,
  getWeekdayIndex,
  getBookingDateToday,
  addDays,
  timeToMinutes,
  parseBookingMessage,
  isBookingAttempt,
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
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
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

client.login(process.env.DISCORD_TOKEN);