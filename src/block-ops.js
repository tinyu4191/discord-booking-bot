// 鎖定時段的操作邏輯：修改單次鎖定、修改／新增／解除週期鎖定（支援一條規則涵蓋多個星期）。
// 不碰 Discord：公告、更新班表、寫紀錄都透過 deps 傳進來，方便測試。
//   deps = { settings, sendAnnouncement(settings, text, files), logToAdmin(settings, text), refreshSummary(guildId, date),
//            unlockImage(): 解除公告用的圖（可回傳 null） }
// 每個操作回傳 { ok, message }：message 是要回給操作者看的文字。
import {
  addRecurringException,
  cancelBookingById,
  deleteBlockedSlot,
  deleteRecurringBlockedSlot,
  deleteRecurringExceptions,
  getBlockedSlotById,
  getBlockedSlotByDateTimeRange,
  getBlockedSlotsBySourceRecurringId,
  getBookingsByDate,
  getRecurringBlockedSlotById,
  getRecurringBlockedSlotsByWeekday,
  getSummaryMessage,
  hasRecurringException,
  insertBlockedSlot,
  insertRecurringBlockedSlot,
  ruleWeekdayMask,
  updateBlockedSlot,
  updateRecurringBlockedSlot,
} from "./db.js";
import { addDays, formatDateLabel, formatWeekdayMask, getBookingDateToday, getWeekdayIndex, isWithinBlockedSlot, timeToMinutes } from "./format.js";

const fail = (message) => ({ ok: false, message });
const fmtReason = (reason) => (reason ? `（原因：${reason}）` : "");

function validateRange(start, end) {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === null || e === null || s > e) return "時間格式錯誤：開始、結束都要是 HH:MM（24 小時制），而且開始不能比結束晚。";
  return null;
}

// 這一天落在 [start, end] 內的有效預約全部取消，回傳被取消的預約
function cancelBookingsInRange(guildId, date, start, end) {
  const affected = getBookingsByDate(guildId, date).filter((b) => {
    const m = timeToMinutes(b.scheduled_time);
    return m !== null && isWithinBlockedSlot(m, { start_time: start, end_time: end });
  });
  affected.forEach((b) => cancelBookingById(b.id));
  return affected;
}

const tagLines = (groups) =>
  groups.flatMap((g) => g.bookings.map((b) => `<@${b.booker_id}>（${formatDateLabel(g.date)} ${b.scheduled_time} / ${b.location}）`));

async function safeRefresh(deps, guildId, date) {
  try {
    await deps.refreshSummary(guildId, date);
  } catch (err) {
    console.warn(`更新班表失敗 (${date})：`, err.message);
  }
}

// 新增週期鎖定在「今天起 7 天內、有討論串的日子」產生單日鎖定；討論串還沒建立的日子，建立當下才會產生
function instanceExists(guildId, ruleId, date, start, end) {
  return getBlockedSlotsBySourceRecurringId(ruleId).some((s) => s.guild_id === guildId && s.booking_date === date) ||
    !!getBlockedSlotByDateTimeRange(guildId, date, start, end);
}

// ---------------------------------------------------------------------------
// 討論串建立時：把符合星期的週期規則轉成單日鎖定（尊重「被解除的日子」例外）
// ---------------------------------------------------------------------------
export function materializeRecurringBlocksForDate(guildId, bookingDate) {
  const weekday = getWeekdayIndex(bookingDate);
  for (const tpl of getRecurringBlockedSlotsByWeekday(guildId, weekday)) {
    if (hasRecurringException(tpl.id, bookingDate)) continue;
    if (getBlockedSlotByDateTimeRange(guildId, bookingDate, tpl.start_time, tpl.end_time)) continue;
    insertBlockedSlot({ guildId, bookingDate, startTime: tpl.start_time, endTime: tpl.end_time, reason: tpl.reason, sourceRecurringId: tpl.id });
  }
}

// ---------------------------------------------------------------------------
// 修改單日鎖定（單次或週期產生的都可以）。只發一則「調整」公告，不會有「解除又鎖定」兩則
// patch：{ start?, end?, reason? }，沒給的欄位維持原值；reason 給空字串或 "-" 代表清掉原因
// ---------------------------------------------------------------------------
export async function editBlock(guildId, id, patch, deps) {
  const slot = getBlockedSlotById(id);
  if (!slot || slot.guild_id !== guildId) return fail(`找不到編號 #${id} 的鎖定。`);
  if (slot.booking_date < getBookingDateToday()) return fail(`#${id} 是 ${slot.booking_date} 的鎖定，已經過去了，不能修改。`);

  const start = patch.start ?? slot.start_time;
  const end = patch.end ?? slot.end_time;
  const reason = patch.reason === undefined ? slot.reason : ["", "-"].includes(patch.reason.trim()) ? null : patch.reason.trim();
  const invalid = validateRange(start, end);
  if (invalid) return fail(invalid);
  if (start === slot.start_time && end === slot.end_time && (reason || null) === (slot.reason || null)) {
    return fail("沒有任何變更（新的內容跟原本一樣）。");
  }

  updateBlockedSlot(id, { startTime: start, endTime: end, reason, detached: slot.source_recurring_id ? true : slot.detached });
  const affected = cancelBookingsInRange(guildId, slot.booking_date, start, end);
  const hasThread = !!getSummaryMessage(guildId, slot.booking_date);
  if (hasThread) await safeRefresh(deps, guildId, slot.booking_date);

  const label = formatDateLabel(slot.booking_date);
  const rangeChanged = start !== slot.start_time || end !== slot.end_time;
  // 只改原因（時間沒動、也沒有預約被取消）不發公告，避免無謂打擾
  if (hasThread && (rangeChanged || affected.length)) {
    let text = `@everyone 📢 公告：${label} 鎖定時段調整：${slot.start_time} ~ ${slot.end_time} → ${start} ~ ${end}${fmtReason(reason)}。`;
    if (affected.length) {
      text += `\n\n以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${tagLines([{ date: slot.booking_date, bookings: affected }]).join("\n")}`;
    }
    await deps.sendAnnouncement(deps.settings, text, []);
  }

  const detachedNote = slot.source_recurring_id ? `\n（這一天是週期鎖定 #${slot.source_recurring_id} 產生的，只改這一天；之後修改週期規則不會覆蓋它）` : "";
  await deps.logToAdmin(deps.settings, `✏️ 已修改鎖定 #${id}（${slot.booking_date}）：${slot.start_time}~${slot.end_time} → ${start}~${end}${fmtReason(reason)}，取消 ${affected.length} 筆預約`);
  return { ok: true, message: `已修改鎖定 #${id}（${label}）：${slot.start_time}~${slot.end_time} → ${start}~${end}，取消了 ${affected.length} 筆衝突的預約。${detachedNote}` };
}

// ---------------------------------------------------------------------------
// 新增週期鎖定（可一次涵蓋多個星期）
// ---------------------------------------------------------------------------
export async function addWeekly(guildId, { mask, start, end, reason }, deps) {
  if (!mask) return fail("請選擇要鎖定的星期。");
  const invalid = validateRange(start, end);
  if (invalid) return fail(invalid);

  const ruleId = insertRecurringBlockedSlot({ guildId, weekdayMask: mask, startTime: start, endTime: end, reason });
  const today = getBookingDateToday();
  const groups = [];
  let announceNeeded = false;

  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (!(mask & (1 << getWeekdayIndex(date)))) continue;
    if (!getBlockedSlotByDateTimeRange(guildId, date, start, end)) {
      insertBlockedSlot({ guildId, bookingDate: date, startTime: start, endTime: end, reason, sourceRecurringId: ruleId });
    }
    const affected = cancelBookingsInRange(guildId, date, start, end);
    if (affected.length) {
      groups.push({ date, bookings: affected });
      await safeRefresh(deps, guildId, date);
    } else if (getSummaryMessage(guildId, date)) {
      announceNeeded = true;
    }
  }

  const label = formatWeekdayMask(mask);
  const total = groups.reduce((n, g) => n + g.bookings.length, 0);
  if (total > 0 || announceNeeded) {
    let text = `@everyone 📢 公告：${label} ${start} ~ ${end} 這個時段固定不開放預約${fmtReason(reason)}。`;
    if (total > 0) text += `\n\n以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${tagLines(groups).join("\n")}`;
    await deps.sendAnnouncement(deps.settings, text, []);
  }
  await deps.logToAdmin(deps.settings, `🚫 已設定週期鎖定 #${ruleId}：${label} ${start}~${end}${fmtReason(reason)}，取消 ${total} 筆預約`);
  return { ok: true, message: `已設定 ${label} ${start}~${end} 固定鎖定（編號 #${ruleId}），取消了 ${total} 筆衝突的預約。` };
}

// ---------------------------------------------------------------------------
// 修改週期鎖定：更新規則本身 + 已經產生、還沒發生的單日鎖定（手動改過的日子保留、被解除的日子不復活）
// patch：{ mask?, start?, end?, reason? }
// ---------------------------------------------------------------------------
export async function editWeekly(guildId, id, patch, deps) {
  const rule = getRecurringBlockedSlotById(id);
  if (!rule || rule.guild_id !== guildId) return fail(`找不到編號 #${id} 的週期鎖定。`);

  const oldMask = ruleWeekdayMask(rule);
  const mask = patch.mask ?? oldMask;
  const start = patch.start ?? rule.start_time;
  const end = patch.end ?? rule.end_time;
  const reason = patch.reason === undefined ? rule.reason : ["", "-"].includes(patch.reason.trim()) ? null : patch.reason.trim();
  const invalid = validateRange(start, end);
  if (invalid) return fail(invalid);
  if (mask === oldMask && start === rule.start_time && end === rule.end_time && (reason || null) === (rule.reason || null)) {
    return fail("沒有任何變更（新的內容跟原本一樣）。");
  }

  updateRecurringBlockedSlot(id, { weekdayMask: mask, startTime: start, endTime: end, reason });
  const today = getBookingDateToday();
  const groups = [];
  const stat = { updated: 0, added: 0, removed: 0, kept: 0 };

  // 1) 已經產生的單日鎖定（今天含以後）
  for (const inst of getBlockedSlotsBySourceRecurringId(id).filter((s) => s.guild_id === guildId && s.booking_date >= today)) {
    if (inst.detached) { stat.kept++; continue; }
    if (!(mask & (1 << getWeekdayIndex(inst.booking_date)))) {
      deleteBlockedSlot(inst.id);
      stat.removed++;
      await safeRefresh(deps, guildId, inst.booking_date);
      continue;
    }
    updateBlockedSlot(inst.id, { startTime: start, endTime: end, reason, detached: false });
    stat.updated++;
    const affected = cancelBookingsInRange(guildId, inst.booking_date, start, end);
    if (affected.length) groups.push({ date: inst.booking_date, bookings: affected });
    await safeRefresh(deps, guildId, inst.booking_date);
  }

  // 2) 新增的星期：今天起 7 天內、討論串已經存在、沒被解除過、還沒有鎖定的日子
  for (let i = 0; i <= 6; i++) {
    const date = addDays(today, i);
    if (!(mask & (1 << getWeekdayIndex(date)))) continue;
    if (!getSummaryMessage(guildId, date) || hasRecurringException(id, date)) continue;
    if (instanceExists(guildId, id, date, start, end)) continue;
    insertBlockedSlot({ guildId, bookingDate: date, startTime: start, endTime: end, reason, sourceRecurringId: id });
    stat.added++;
    const affected = cancelBookingsInRange(guildId, date, start, end);
    if (affected.length) groups.push({ date, bookings: affected });
    await safeRefresh(deps, guildId, date);
  }

  const oldLabel = `${formatWeekdayMask(oldMask)} ${rule.start_time}~${rule.end_time}`;
  const newLabel = `${formatWeekdayMask(mask)} ${start}~${end}`;
  const total = groups.reduce((n, g) => n + g.bookings.length, 0);
  const scheduleChanged = mask !== oldMask || start !== rule.start_time || end !== rule.end_time;

  if (scheduleChanged || total > 0) {
    let text = `@everyone 📢 公告：週期鎖定調整：${oldLabel} → ${newLabel}${fmtReason(reason)}。`;
    if (total > 0) text += `\n\n以下預約因為時段衝突已被系統取消，請重新選擇其他時間登記，造成不便請見諒 🙏\n${tagLines(groups).join("\n")}`;
    await deps.sendAnnouncement(deps.settings, text, []);
  }
  await deps.logToAdmin(deps.settings, `✏️ 已修改週期鎖定 #${id}：${oldLabel} → ${newLabel}${fmtReason(reason)}，更新 ${stat.updated}、新增 ${stat.added}、移除 ${stat.removed}、保留（手動改過）${stat.kept}，取消 ${total} 筆預約`);
  return {
    ok: true,
    message:
      `已修改週期鎖定 #${id}：${oldLabel} → ${newLabel}。\n` +
      `已產生的單日鎖定：更新 ${stat.updated} 筆、新增 ${stat.added} 筆、移除 ${stat.removed} 筆、保留 ${stat.kept} 筆（手動改過的日子不會被覆蓋），取消了 ${total} 筆衝突的預約。`,
  };
}

// ---------------------------------------------------------------------------
// 解除週期鎖定：刪規則 + 還沒發生的單日鎖定 + 例外紀錄
// ---------------------------------------------------------------------------
export async function removeWeekly(guildId, id, deps) {
  const rule = getRecurringBlockedSlotById(id);
  if (!rule || rule.guild_id !== guildId) return fail(`找不到編號 #${id} 的週期鎖定。`);

  const label = `${formatWeekdayMask(ruleWeekdayMask(rule))} ${rule.start_time}~${rule.end_time}`;
  deleteRecurringBlockedSlot(id);
  deleteRecurringExceptions(id);

  const today = getBookingDateToday();
  const materialized = getBlockedSlotsBySourceRecurringId(id).filter((s) => s.guild_id === guildId && s.booking_date >= today);
  for (const m of materialized) {
    deleteBlockedSlot(m.id);
    await safeRefresh(deps, guildId, m.booking_date);
  }

  const image = deps.unlockImage?.();
  await deps.sendAnnouncement(deps.settings, `@everyone 📢 公告：${label.replace(/ \d\d:\d\d~\d\d:\d\d$/, "")} ${rule.start_time} ~ ${rule.end_time} 恢復開放預約囉！`, image ? [image] : []);
  await deps.logToAdmin(deps.settings, `✅ 已解除週期鎖定 #${id}（${label}）`);
  return { ok: true, message: `已解除 ${label} 的固定鎖定（編號 #${id}），同時清除了 ${materialized.length} 筆已經產生、還沒發生的鎖定。` };
}
