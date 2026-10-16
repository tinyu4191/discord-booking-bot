// 「限定地點時段」的操作：新增、修改、解除。某天某時段內，只接受指定地點的預約。
// 跟鎖定一樣：不碰 Discord，公告／紀錄／更新班表都透過 deps 傳進來（跟 block-ops.js 同一組 deps）。
//   deps = { settings, sendAnnouncement(settings, text, files), logToAdmin(settings, text), refreshSummary(guildId, date), unlockImage() }
// 每個操作回傳 { ok, message }：message 是要回給操作者看的文字。
import {
  cancelBookingById,
  deleteLocationWindow,
  getBookingsByDate,
  getLocationWindowById,
  getLocationWindowsByDate,
  getSummaryMessage,
  insertLocationWindow,
  updateLocationWindow,
} from "./db.js";
import { formatDateLabel, getBookingDateToday, getWeekdayLabel, isWithinBlockedSlot, timeToMinutes } from "./format.js";
import { formatLocationKeys, isLocationAllowed, windowKeys } from "./location-rules.js";

const fail = (message) => ({ ok: false, message });
const dateText = (d) => `${formatDateLabel(d)} (${getWeekdayLabel(d)})`;
const noteLine = (notes) => (notes ? `\n📝 備註：${notes}` : "");

function validateRange(start, end) {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === null || e === null || s > e) return "時間格式錯誤：開始、結束都要是 HH:MM（24 小時制），而且開始不能比結束晚。";
  return null;
}

// 兩個時段（含頭尾）有沒有重疊
const overlaps = (a, b) => timeToMinutes(a.start_time) <= timeToMinutes(b.end_time) && timeToMinutes(b.start_time) <= timeToMinutes(a.end_time);

function findOverlap(guildId, date, start, end, exceptId = null) {
  const probe = { start_time: start, end_time: end };
  return getLocationWindowsByDate(guildId, date).find((w) => w.id !== exceptId && overlaps(w, probe));
}

// 這個時段內、地點不在允許清單的有效預約全部取消，回傳被取消的預約
function cancelDisallowedBookings(guildId, date, start, end, keys) {
  const range = { start_time: start, end_time: end };
  const affected = getBookingsByDate(guildId, date).filter((b) => {
    const m = timeToMinutes(b.scheduled_time);
    return m !== null && isWithinBlockedSlot(m, range) && !isLocationAllowed(b.location, keys);
  });
  affected.forEach((b) => cancelBookingById(b.id));
  return affected;
}

const cancelText = (affected) =>
  affected.length
    ? `\n\n以下預約因為地點不符合這個時段的限定，已被系統取消，請改選其他時段或地點重新登記，造成不便請見諒 🙏\n` +
      affected.map((b) => `<@${b.booker_id}>（${b.scheduled_time} / ${b.location}）`).join("\n")
    : "";

async function safeRefresh(deps, guildId, date) {
  try {
    await deps.refreshSummary(guildId, date);
  } catch (err) {
    console.warn(`更新班表失敗 (${date})：`, err.message);
  }
}

const cleanNotes = (v) => (v === undefined ? undefined : ["", "-"].includes(v.trim()) ? null : v.trim());

// ---------------------------------------------------------------------------
export async function addWindow(guildId, { date, start, end, keys, notes }, deps) {
  if (!keys?.length) return fail("請至少選一個開放預約的地點。");
  if (date < getBookingDateToday()) return fail(`${date} 已經過去了，不能設定。`);
  const invalid = validateRange(start, end);
  if (invalid) return fail(invalid);
  const clash = findOverlap(guildId, date, start, end);
  if (clash) return fail(`跟已有的限定時段 #${clash.id}（${clash.start_time}~${clash.end_time}，只開放 ${formatLocationKeys(windowKeys(clash))}）時間重疊了。請先修改或解除它，或換個時段。`);

  const note = cleanNotes(notes) ?? null;
  const id = insertLocationWindow({ guildId, bookingDate: date, startTime: start, endTime: end, locations: keys, notes: note });
  const affected = cancelDisallowedBookings(guildId, date, start, end, keys);
  const hasThread = !!getSummaryMessage(guildId, date);
  if (hasThread) {
    await safeRefresh(deps, guildId, date);
    await deps.sendAnnouncement(
      deps.settings,
      `@everyone 📢 公告：${dateText(date)} ${start} ~ ${end} 這個時段只開放預約：**${formatLocationKeys(keys)}**，其他地點暫停預約。${noteLine(note)}${cancelText(affected)}`,
      []
    );
  }
  await deps.logToAdmin(deps.settings, `🎯 已設定限定地點時段 #${id}（${date} ${start}~${end}，只開放 ${formatLocationKeys(keys)}${note ? `；備註：${note}` : ""}），取消 ${affected.length} 筆預約`);
  return {
    ok: true,
    message:
      `已設定限定地點時段 #${id}：${dateText(date)} ${start}~${end}，只開放 ${formatLocationKeys(keys)}。取消了 ${affected.length} 筆地點不符的預約。` +
      (hasThread ? "" : "\n（這天的討論串還沒建立，建立當下會一併公告。）"),
  };
}

// patch：{ start?, end?, keys?, notes? }；沒給的欄位維持原值，notes 給 "-" 代表清掉
export async function editWindow(guildId, id, patch, deps) {
  const win = getLocationWindowById(id);
  if (!win || win.guild_id !== guildId) return fail(`找不到編號 #${id} 的限定地點時段。`);
  if (win.booking_date < getBookingDateToday()) return fail(`#${id} 是 ${win.booking_date} 的設定，已經過去了，不能修改。`);

  const oldKeys = windowKeys(win);
  const start = patch.start ?? win.start_time;
  const end = patch.end ?? win.end_time;
  const keys = patch.keys ?? oldKeys;
  const notes = patch.notes === undefined ? win.notes : cleanNotes(patch.notes);
  const invalid = validateRange(start, end);
  if (invalid) return fail(invalid);
  if (!keys.length) return fail("請至少選一個開放預約的地點。");
  const sameKeys = keys.length === oldKeys.length && keys.every((k) => oldKeys.includes(k));
  if (start === win.start_time && end === win.end_time && sameKeys && (notes || null) === (win.notes || null)) {
    return fail("沒有任何變更（新的內容跟原本一樣）。");
  }
  const clash = findOverlap(guildId, win.booking_date, start, end, id);
  if (clash) return fail(`新的時段跟 #${clash.id}（${clash.start_time}~${clash.end_time}）重疊了。`);

  updateLocationWindow(id, { startTime: start, endTime: end, locations: keys, notes });
  const affected = cancelDisallowedBookings(guildId, win.booking_date, start, end, keys);
  const hasThread = !!getSummaryMessage(guildId, win.booking_date);
  if (hasThread) await safeRefresh(deps, guildId, win.booking_date);

  // 只改備註（時段、地點都沒動、也沒有預約被取消）不發公告，避免無謂打擾
  const scheduleChanged = start !== win.start_time || end !== win.end_time || !sameKeys;
  if (hasThread && (scheduleChanged || affected.length)) {
    await deps.sendAnnouncement(
      deps.settings,
      `@everyone 📢 公告：${dateText(win.booking_date)} 限定地點時段調整：${win.start_time} ~ ${win.end_time} 只開放 ${formatLocationKeys(oldKeys)} → **${start} ~ ${end} 只開放 ${formatLocationKeys(keys)}**。${noteLine(notes)}${cancelText(affected)}`,
      []
    );
  }
  await deps.logToAdmin(deps.settings, `✏️ 已修改限定地點時段 #${id}（${win.booking_date}）：${win.start_time}~${win.end_time} ${formatLocationKeys(oldKeys)} → ${start}~${end} ${formatLocationKeys(keys)}${notes ? `；備註：${notes}` : ""}，取消 ${affected.length} 筆預約`);
  return {
    ok: true,
    message: `已修改限定地點時段 #${id}（${dateText(win.booking_date)}）：${win.start_time}~${win.end_time} ${formatLocationKeys(oldKeys)} → ${start}~${end} ${formatLocationKeys(keys)}。取消了 ${affected.length} 筆地點不符的預約。`,
  };
}

export async function removeWindow(guildId, id, deps) {
  const win = getLocationWindowById(id);
  if (!win || win.guild_id !== guildId) return fail(`找不到編號 #${id} 的限定地點時段。`);

  deleteLocationWindow(id);
  const hasThread = !!getSummaryMessage(guildId, win.booking_date);
  if (hasThread) {
    await safeRefresh(deps, guildId, win.booking_date);
    const image = deps.unlockImage?.();
    await deps.sendAnnouncement(
      deps.settings,
      `@everyone 📢 公告：${dateText(win.booking_date)} ${win.start_time} ~ ${win.end_time} 取消地點限定，恢復開放所有地點預約囉！`,
      image ? [image] : []
    );
  }
  await deps.logToAdmin(deps.settings, `✅ 已解除限定地點時段 #${id}（${win.booking_date} ${win.start_time}~${win.end_time}，原本只開放 ${formatLocationKeys(windowKeys(win))}）`);
  return { ok: true, message: `已解除限定地點時段 #${id}（${dateText(win.booking_date)} ${win.start_time}~${win.end_time}）。` };
}

// 討論串建立當下要公告的限定時段文字（沒有就回傳空陣列）
export function describeWindowsForDate(guildId, date) {
  return getLocationWindowsByDate(guildId, date)
    .slice()
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))
    .map((w) => `🎯 ${w.start_time} ~ ${w.end_time} 只開放：${formatLocationKeys(windowKeys(w))}${w.notes ? `（${w.notes}）` : ""}`);
}
