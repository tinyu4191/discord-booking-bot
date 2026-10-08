// 預約提醒 + 續約
//
// 流程：
//   1. 每分鐘掃描一次：找出「還有 1 ~ REMINDER_LEAD_MINUTES 分鐘開始」、已確認、還沒提醒過的預約
//      （用範圍判斷，不是剛好 5 分鐘，所以機器人重啟的空窗期、或臨時才登記的預約也不會漏提醒）
//   2. 發提醒前先「預檢」續約時段（原預約時間 +50 分鐘）：
//        沒衝突 → 提醒訊息附「續約／不續約」兩個按鈕
//        有衝突 → 只發提醒並寫明原因，不附按鈕
//   3. 按「續約」：再檢查一次（提醒發出到按下之間可能有人登記），沒衝突才複製預約；有衝突就回報原因、不新增
//      按「不續約」：移除按鈕、標記已處理
//   4. 超過原預約的開始時間，或預約被改時間／取消／刪除：移除按鈕、整則內容劃刪除線
//
// 只有設定了 reminder_channel_id 的語音群會啟用，沒設定的語音群完全不受影響。

import cron from "node-cron";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags } from "discord.js";
import {
  insertBooking,
  getBookingById,
  getGuildSettings,
  getAllGuildSettings,
  getConfirmedBookingsByDate,
  getSummaryMessage,
  insertReminder,
  getReminderById,
  setReminderMessage,
  deleteReminder,
  getOpenReminders,
  claimReminder,
  releaseReminder,
  finishReminder,
  expireReminder,
  purgeOldReminders,
} from "./db.js";
import { checkBookingSlot } from "./booking-rules.js";
import {
  addDays,
  diffDays,
  formatDateLabel,
  getBookingDateToday,
  getCurrentTimeMinutes,
  getLocationEmoji,
  getWeekdayLabel,
  minutesToTime,
  timeToMinutes,
} from "./format.js";

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// 預約開始前幾分鐘提醒。測試時可以在 .env 設 REMINDER_LEAD_MINUTES=600 之類的大數字，不用乾等
const REMINDER_LEAD_MINUTES = positiveInt(process.env.REMINDER_LEAD_MINUTES, 5);
// 續約 = 原預約時間再往後幾分鐘
const RENEW_OFFSET_MINUTES = positiveInt(process.env.RENEW_OFFSET_MINUTES, 50);
// 提醒訊息裡會有 <@使用者> 的 mention，但這是管理者頻道的紀錄，不需要真的 ping 到人
const NO_PING = { parse: [] };

let deps = null; // { client, refreshSummaryMessage, logToAdmin }，由 setupReminders 注入
let ticking = false;

// ---------------------------------------------------------------------------
// 時間計算
// ---------------------------------------------------------------------------

// 距離某筆預約開始還有幾分鐘（已經過了會是負數）。時間格式異常回傳 null
function minutesUntilStart(bookingDate, scheduledTime) {
  const mins = timeToMinutes(scheduledTime);
  if (mins === null) return null;
  return diffDays(getBookingDateToday(), bookingDate) * 1440 + mins - getCurrentTimeMinutes();
}

// ---------------------------------------------------------------------------
// 續約預檢：算出續約時段，並用跟一般預約相同的規則檢查（鎖定時段 + 前後 5 分鐘衝突）
// 回傳 { slot, problem }：problem 是 null 代表可以續約，否則是給管理者看的原因
// 這個函式是同步的，「檢查」跟「新增預約」之間不能 await，才不會被別人插隊
// ---------------------------------------------------------------------------
function evaluateRenewal(guildId, bookingDate, scheduledTime) {
  const start = timeToMinutes(scheduledTime);
  if (start === null) return { slot: null, problem: "原預約時間格式異常，沒辦法計算續約時段" };

  const total = start + RENEW_OFFSET_MINUTES;
  const slot = {
    date: addDays(bookingDate, Math.floor(total / 1440)), // 跨午夜會變成隔天
    time: minutesToTime(total % 1440),
    minutes: total % 1440,
  };
  const label = slot.date === bookingDate ? slot.time : `${formatDateLabel(slot.date)} ${slot.time}`;

  if (!getSummaryMessage(guildId, slot.date)) {
    return { slot, problem: `找不到 ${formatDateLabel(slot.date)} 的預約討論串，沒辦法新增預約` };
  }

  const issue = checkBookingSlot(guildId, slot.date, slot.minutes);
  if (issue?.type === "blocked") {
    const s = issue.slot;
    return {
      slot,
      problem: `續約時段 ${label} 落在鎖定時段 ${s.start_time}~${s.end_time}${s.reason ? `（${s.reason}）` : ""}`,
    };
  }
  if (issue?.type === "conflict") {
    const b = issue.booking;
    return {
      slot,
      problem: `續約時段 ${label} 跟 ${b.scheduled_time} 的預約（${b.location}）太近，前後 5 分鐘內不可重複`,
    };
  }
  return { slot, problem: null };
}

// ---------------------------------------------------------------------------
// 訊息內容
// ---------------------------------------------------------------------------

function buildBaseContent(booking, bookingDate) {
  const header = `⏰ 預約即將開始｜${formatDateLabel(bookingDate)} (${getWeekdayLabel(bookingDate)}) ${booking.scheduled_time}`;
  const proxy = booking.proxy_for ? `（代約：${booking.proxy_for}）` : "";
  const detail =
    `${getLocationEmoji(booking.location)} ${booking.location}　🚩 ${booking.channel || "當日決定"}　` +
    `👤 <@${booking.booker_id}>${proxy}`;
  return `${header}\n${detail}`;
}

function renewLabel(r) {
  if (!r.renew_time) return "（無法計算）";
  return r.renew_date === r.booking_date ? r.renew_time : `${formatDateLabel(r.renew_date)} ${r.renew_time}`;
}

// 還沒處理時，訊息最後一行（有按鈕：問要不要續約；沒按鈕：說明為什麼不能續約）
function openLine(r) {
  return r.can_renew
    ? `🔁 要續約嗎？續約後會新增 ${renewLabel(r)} 的預約`
    : `⚠️ 無法續約：${r.precheck_note}`;
}

// 每一行都各自包上刪除線（Discord 的刪除線跨行不穩定，逐行包最保險）
function strike(text) {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `~~${line.trim()}~~` : line))
    .join("\n");
}

// 依提醒目前的狀態產生整則訊息內容
export function renderReminderContent(r) {
  const who = r.handled_by ? `<@${r.handled_by}>` : "";
  switch (r.status) {
    case "pending":
    case "no_renew":
      return `${r.base_content}\n${openLine(r)}`;
    case "processing":
      return `${r.base_content}\n⏳ 處理中⋯`;
    case "renewed":
      return `${r.base_content}\n✅ 已續約 → 新預約 ${renewLabel(r)}（${who}）`;
    case "declined":
      return `${r.base_content}\n❌ 不續約（${who}）`;
    case "failed":
      return `${r.base_content}\n⚠️ 續約失敗：${r.result_note}（${who}）`;
    case "expired": {
      const struck = strike(`${r.base_content}\n${openLine(r)}`);
      return r.result_note ? `${struck}\n-# ${r.result_note}` : struck;
    }
    default:
      return r.base_content;
  }
}

function buildButtons(reminderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`renew:yes:${reminderId}`).setLabel("續約").setEmoji("🔁").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`renew:no:${reminderId}`).setLabel("不續約").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function editReminderMessage(channelId, messageId, content) {
  try {
    const channel = await deps.client.channels.fetch(channelId);
    await channel.messages.edit(messageId, { content, components: [], allowedMentions: NO_PING });
  } catch (err) {
    console.warn(`更新提醒訊息失敗（訊息可能已被刪除）：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 每分鐘排程
// ---------------------------------------------------------------------------

// 這筆提醒還有沒有效？無效的話回傳 { note }（note 是要顯示的原因，單純過期就是 null），有效回傳 null
function getStaleReason(r) {
  const booking = getBookingById(r.booking_id);
  if (
    !booking ||
    booking.status !== "confirmed" ||
    booking.booking_date !== r.booking_date ||
    booking.scheduled_time !== r.booking_time
  ) {
    return { note: "預約已被修改、取消或刪除" };
  }
  const until = minutesUntilStart(r.booking_date, r.booking_time);
  if (until === null || until < 0) return { note: null }; // 過了預約開始時間
  return null;
}

// 把已經失效的提醒：移除按鈕 + 整則劃刪除線
async function sweepReminders(settings) {
  for (const r of getOpenReminders(settings.guild_id)) {
    if (!r.message_id) {
      // 建立提醒到發出訊息的途中被中斷（例如機器人剛好重啟）留下的殘列，刪掉讓它重新判斷
      deleteReminder(r.id);
      continue;
    }
    const stale = getStaleReason(r);
    if (!stale) continue;
    if (!expireReminder(r.id, stale.note)) continue; // 剛好被按下去處理了，就不要動它
    await editReminderMessage(r.channel_id, r.message_id, renderReminderContent(getReminderById(r.id)));
  }
}

async function createReminder(settings, booking, bookingDate) {
  const { slot, problem } = evaluateRenewal(settings.guild_id, bookingDate, booking.scheduled_time);

  const id = insertReminder({
    guildId: settings.guild_id,
    bookingId: booking.id,
    bookingDate,
    bookingTime: booking.scheduled_time,
    renewDate: slot?.date,
    renewTime: slot?.time,
    canRenew: !problem,
    baseContent: buildBaseContent(booking, bookingDate),
    precheckNote: problem,
  });
  if (id === null) return; // 這筆預約已經提醒過了

  try {
    const r = getReminderById(id);
    const channel = await deps.client.channels.fetch(settings.reminder_channel_id);
    const msg = await channel.send({
      content: renderReminderContent(r),
      components: r.can_renew ? buildButtons(id) : [],
      allowedMentions: NO_PING,
    });
    setReminderMessage(id, channel.id, msg.id);
  } catch (err) {
    // 發送失敗就把紀錄刪掉，下一分鐘（還在提醒範圍內的話）會自動重試
    console.warn(`[${settings.guild_id}] 預約提醒發送失敗：${err.message}`);
    deleteReminder(id);
  }
}

async function sendDueReminders(settings) {
  const guildId = settings.guild_id;
  const today = getBookingDateToday();
  // 快午夜時，要連隔天 00:0x 的預約一起看
  const maxOffset = Math.floor((getCurrentTimeMinutes() + REMINDER_LEAD_MINUTES) / 1440);

  for (let offset = 0; offset <= maxOffset; offset++) {
    const date = addDays(today, offset);
    for (const booking of getConfirmedBookingsByDate(guildId, date)) {
      const until = minutesUntilStart(date, booking.scheduled_time);
      if (until === null || until < 1 || until > REMINDER_LEAD_MINUTES) continue;
      await createReminder(settings, booking, date);
    }
  }
}

async function runTick() {
  if (ticking) return; // 上一輪還沒跑完（Discord 回應慢），這輪先跳過
  ticking = true;
  try {
    for (const settings of getAllGuildSettings()) {
      if (!settings.reminder_channel_id) continue;
      try {
        await sweepReminders(settings);
        await sendDueReminders(settings);
      } catch (err) {
        console.error(`[${settings.guild_id}] 預約提醒處理時發生錯誤：`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// 按鈕處理
// ---------------------------------------------------------------------------

// 這則提醒已經是最終狀態（或剛過期）：把訊息整理成正確的樣子，再私下告訴按的人
async function settleMessage(interaction, reminder, text) {
  try {
    await interaction.deferUpdate();
    await interaction.editReply({
      content: renderReminderContent(reminder),
      components: [],
      allowedMentions: NO_PING,
    });
    await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.warn("整理提醒訊息失敗：", err.message);
  }
}

// 同步完成「再檢查一次 + 新增預約 + 結案」，中間不可以 await
function renewBooking(reminder, userId) {
  const booking = getBookingById(reminder.booking_id);
  const { slot, problem } = evaluateRenewal(reminder.guild_id, booking.booking_date, booking.scheduled_time);

  if (problem) {
    finishReminder(reminder.id, "failed", { handledBy: userId, note: problem });
    return { ok: false, problem, booking };
  }

  const newBookingId = insertBooking({
    guildId: reminder.guild_id,
    bookingDate: slot.date,
    messageId: `renew-${reminder.id}`, // 沒有對應的真實留言，用假 id（只能由管理者用 admin-manage-booking.js 修改）
    location: booking.location,
    time: slot.time,
    channel: booking.channel,
    bookerId: booking.booker_id,
    proxyFor: booking.proxy_for,
  });
  finishReminder(reminder.id, "renewed", { handledBy: userId, newBookingId });
  return { ok: true, slot, newBookingId, booking };
}

export async function handleRenewButton(interaction) {
  const [, action, idText] = interaction.customId.split(":");
  const id = Number(idText);
  const reminder = Number.isInteger(id) ? getReminderById(id) : null;
  const tell = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (!reminder || reminder.guild_id !== interaction.guildId || reminder.message_id !== interaction.message?.id) {
    return tell("找不到這筆提醒，可能已經被清除了。");
  }
  const settings = getGuildSettings(reminder.guild_id);
  if (!settings || settings.reminder_channel_id !== interaction.channelId) {
    return tell("這個按鈕不在提醒頻道裡，已忽略。");
  }
  if (action !== "yes" && action !== "no") return tell("未知的操作。");

  // ---- 以下到 claimReminder 為止都是同步的，所以兩個人同時按只會有一個搶到 ----
  if (reminder.status === "processing") return tell("正在處理中，請稍候。");
  if (reminder.status !== "pending") {
    return settleMessage(interaction, reminder, "這則提醒已經處理過了。");
  }

  const stale = getStaleReason(reminder);
  if (stale) {
    expireReminder(reminder.id, stale.note);
    return settleMessage(
      interaction,
      getReminderById(id),
      stale.note ? "這筆預約已經被修改、取消或刪除，沒辦法續約了。" : "這則提醒已經過期，沒辦法再續約了。"
    );
  }

  if (!claimReminder(reminder.id)) return tell("正在處理中，請稍候。");

  try {
    await interaction.deferUpdate(); // Discord 要求 3 秒內回應，先確認收到，後面再慢慢改訊息
  } catch (err) {
    releaseReminder(reminder.id); // 沒回應成功，放回待處理讓管理者可以重按
    console.warn("回應按鈕互動失敗：", err.message);
    return;
  }

  const userId = interaction.user.id;
  let renewed = null;
  try {
    if (action === "no") {
      finishReminder(reminder.id, "declined", { handledBy: userId });
    } else {
      renewed = renewBooking(reminder, userId);
    }
    await interaction.editReply({
      content: renderReminderContent(getReminderById(reminder.id)),
      components: [],
      allowedMentions: NO_PING,
    });
  } catch (err) {
    console.error("處理續約按鈕時發生錯誤：", err);
    if (getReminderById(reminder.id)?.status === "processing") {
      finishReminder(reminder.id, "failed", { handledBy: userId, note: "系統錯誤，請查看伺服器 log" });
    }
    try {
      await interaction.editReply({
        content: renderReminderContent(getReminderById(reminder.id)),
        components: [],
        allowedMentions: NO_PING,
      });
    } catch {
      // 連改訊息都失敗就算了，狀態已經寫進資料庫
    }
    return;
  }

  if (!renewed) return; // 不續約，不需要後續動作

  // 預約已經新增好了，接著更新班表跟紀錄（失敗只記 log，不影響已經完成的續約）
  const { booking } = renewed;
  if (renewed.ok) {
    try {
      await deps.refreshSummaryMessage(reminder.guild_id, renewed.slot.date);
    } catch (err) {
      console.error(`續約後更新班表失敗 (${renewed.slot.date})：`, err);
    }
    await deps.logToAdmin(
      settings,
      `🔁 預約續約｜${formatDateLabel(booking.booking_date)} ${booking.scheduled_time} → ` +
        `${formatDateLabel(renewed.slot.date)} ${renewed.slot.time}｜${booking.location} / ${booking.channel || "當日決定"}｜` +
        `<@${booking.booker_id}>｜由 <@${userId}> 操作`
    );
  } else {
    await deps.logToAdmin(
      settings,
      `⚠️ 預約續約失敗｜${formatDateLabel(booking.booking_date)} ${booking.scheduled_time}｜${booking.location}｜${renewed.problem}`
    );
  }
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------

export function setupReminders({ client, refreshSummaryMessage, logToAdmin }) {
  deps = { client, refreshSummaryMessage, logToAdmin };

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("renew:")) return;
    handleRenewButton(interaction).catch((err) => console.error("處理續約按鈕時發生錯誤：", err));
  });

  cron.schedule(
    "* * * * *",
    () => {
      runTick().catch((err) => console.error("預約提醒排程發生錯誤：", err));
    },
    { timezone: "Asia/Ho_Chi_Minh" }
  );

  // 每天 00:10 清掉 30 天前已經結案的提醒紀錄
  cron.schedule(
    "10 0 * * *",
    () => {
      try {
        purgeOldReminders(30);
      } catch (err) {
        console.error("清理舊提醒紀錄失敗：", err);
      }
    },
    { timezone: "Asia/Ho_Chi_Minh" }
  );

  console.log(`預約提醒已啟動：開始前 ${REMINDER_LEAD_MINUTES} 分鐘提醒，續約 +${RENEW_OFFSET_MINUTES} 分鐘`);
}

// 給測試用
export { runTick as runReminderTick };
