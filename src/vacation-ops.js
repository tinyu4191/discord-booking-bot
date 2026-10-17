// 休假：一段日期（含頭尾）整天不開放預約，只發一則公告，期間不會每天重複 @everyone，結束後自動公告恢復。
// 不碰 Discord：公告／紀錄／更新班表都透過 deps 傳進來（跟 block-ops.js 同一組 deps）。
// 每個操作回傳 { ok, message }。
import {
  cancelBookingById,
  deleteVacation,
  getBookingsByDate,
  getEndedVacations,
  getSummaryMessage,
  getUpcomingVacations,
  getVacationById,
  insertVacation,
  updateVacation,
} from "./db.js";
import { addDays, diffDays, formatDateLabel, getBookingDateToday, getWeekdayLabel, timeToMinutes } from "./format.js";
import { isPastBookingTime } from "./booking-rules.js";

export const MAX_VACATION_DAYS = 90;
const fail = (message) => ({ ok: false, message });
const dateText = (d) => `${formatDateLabel(d)} (${getWeekdayLabel(d)})`;
const rangeText = (a, b) => (a === b ? dateText(a) : `${dateText(a)} ~ ${dateText(b)}`);
const reasonLine = (r) => (r ? `\n📝 原因：${r}` : "");
const cleanReason = (v) => (v === undefined ? undefined : ["", "-"].includes(v.trim()) ? null : v.trim());

// 把 from~to（含）每一天還有效、時間還沒過的預約取消，回傳 [{date, bookings}]
function cancelBookingsBetween(guildId, from, to) {
  const groups = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const hit = getBookingsByDate(guildId, d).filter((b) => {
      const m = timeToMinutes(b.scheduled_time);
      return m === null || !isPastBookingTime(d, m); // 今天已經過去的時段是歷史紀錄，不動
    });
    hit.forEach((b) => cancelBookingById(b.id));
    if (hit.length) groups.push({ date: d, bookings: hit });
  }
  return groups;
}

// 太長的 @ 名單分段發（Discord 單則上限 2000 字）
function chunkLines(lines, max = 1700) {
  const out = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > max) { out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) out.push(cur);
  return out;
}

async function announceWithCancellations(deps, headline, groups) {
  const lines = groups.flatMap((g) => g.bookings.map((b) => `<@${b.booker_id}>（${formatDateLabel(g.date)} ${b.scheduled_time} / ${b.location}）`));
  if (!lines.length) return deps.sendAnnouncement(deps.settings, headline, []);
  const intro = "\n\n以下預約因為這段期間不開放，已被系統取消，請等恢復開放後重新登記，造成不便請見諒 🙏\n";
  const parts = chunkLines(lines);
  await deps.sendAnnouncement(deps.settings, headline + intro + parts[0], []);
  for (const rest of parts.slice(1)) await deps.sendAnnouncement(deps.settings, rest, []);
}

async function refreshDates(deps, guildId, groups) {
  for (const g of groups) {
    if (!getSummaryMessage(guildId, g.date)) continue;
    try { await deps.refreshSummary(guildId, g.date); } catch (err) { console.warn(`更新班表失敗 (${g.date})：`, err.message); }
  }
}

const overlapping = (guildId, start, end, exceptId = null) =>
  getUpcomingVacations(guildId, "0000-00-00").find((v) => v.id !== exceptId && v.start_date <= end && v.end_date >= start);

export async function addVacation(guildId, { start, end, reason }, deps) {
  const today = getBookingDateToday();
  if (start < today) return fail(`開始日 ${start} 已經過去了，最早從今天（${formatDateLabel(today)}）開始。`);
  if (end < start) return fail("結束日不能比開始日早。");
  if (diffDays(start, end) + 1 > MAX_VACATION_DAYS) return fail(`休假最長 ${MAX_VACATION_DAYS} 天，請確認日期。`);
  const clash = overlapping(guildId, start, end);
  if (clash) return fail(`跟休假 #${clash.id}（${rangeText(clash.start_date, clash.end_date)}）重疊了，請先用 /vacation edit 調整它。`);

  const note = cleanReason(reason) ?? null;
  const id = insertVacation({ guildId, startDate: start, endDate: end, reason: note });
  const groups = cancelBookingsBetween(guildId, start, end);
  await refreshDates(deps, guildId, groups);
  const total = groups.reduce((n, g) => n + g.bookings.length, 0);
  await announceWithCancellations(
    deps,
    `@everyone 📢 公告：${rangeText(start, end)} 休假中，這段期間整天不開放預約，${dateText(addDays(end, 1))} 起恢復預約。${reasonLine(note)}`,
    groups
  );
  await deps.logToAdmin(deps.settings, `🏖️ 已設定休假 #${id}：${start} ~ ${end}${note ? `（${note}）` : ""}，取消 ${total} 筆預約`);
  return { ok: true, message: `已設定休假 #${id}：${rangeText(start, end)}，取消了 ${total} 筆預約。${dateText(addDays(end, 1))} 00:00 起自動恢復並發公告。` };
}

// patch：{ end?, reason? }（reason 給 "-" 代表清掉）。想改開始日請解除後重建
export async function editVacation(guildId, id, patch, deps) {
  const v = getVacationById(id);
  if (!v || v.guild_id !== guildId) return fail(`找不到編號 #${id} 的休假。`);
  const today = getBookingDateToday();
  if (v.end_date < today) return fail(`休假 #${id} 已經結束了。`);

  const end = patch.end ?? v.end_date;
  const reason = patch.reason === undefined ? v.reason : cleanReason(patch.reason);
  if (end < v.start_date) return fail("結束日不能比開始日早。");
  if (end < today) return fail("新的結束日已經過去了，要提早結束請用 /vacation end。");
  if (diffDays(v.start_date, end) + 1 > MAX_VACATION_DAYS) return fail(`休假最長 ${MAX_VACATION_DAYS} 天。`);
  if (end === v.end_date && (reason || null) === (v.reason || null)) return fail("沒有任何變更（新的內容跟原本一樣）。");
  const clash = overlapping(guildId, v.start_date, end, id);
  if (clash) return fail(`新的日期跟休假 #${clash.id}（${rangeText(clash.start_date, clash.end_date)}）重疊了。`);

  updateVacation(id, { endDate: end, reason });
  // 延長：新增涵蓋的日子要取消預約；縮短：不動（那幾天恢復可預約）
  const groups = end > v.end_date ? cancelBookingsBetween(guildId, addDays(v.end_date, 1), end) : [];
  await refreshDates(deps, guildId, groups);
  const total = groups.reduce((n, g) => n + g.bookings.length, 0);
  if (end !== v.end_date) {
    await announceWithCancellations(
      deps,
      `@everyone 📢 公告：休假時間調整：${rangeText(v.start_date, v.end_date)} → **${rangeText(v.start_date, end)}**，${dateText(addDays(end, 1))} 起恢復預約。${reasonLine(reason)}`,
      groups
    );
  }
  await deps.logToAdmin(deps.settings, `✏️ 已修改休假 #${id}：${v.end_date} → ${end}${reason ? `（${reason}）` : ""}，取消 ${total} 筆預約`);
  return { ok: true, message: `已修改休假 #${id}：${rangeText(v.start_date, end)}，取消了 ${total} 筆預約。` + (end === v.end_date ? "（只改原因，不發公告）" : "") };
}

// 提前結束（或休假還沒開始就取消）：立刻恢復開放並發公告
export async function endVacation(guildId, id, deps) {
  const v = getVacationById(id);
  if (!v || v.guild_id !== guildId) return fail(`找不到編號 #${id} 的休假。`);
  deleteVacation(id);
  const today = getBookingDateToday();
  if (v.end_date >= today) {
    const started = v.start_date <= today;
    const image = deps.unlockImage?.();
    await deps.sendAnnouncement(
      deps.settings,
      started
        ? `@everyone 📢 公告：休假提前結束，恢復開放預約囉！`
        : `@everyone 📢 公告：原訂 ${rangeText(v.start_date, v.end_date)} 的休假取消，照常開放預約。`,
      image ? [image] : []
    );
  }
  await deps.logToAdmin(deps.settings, `✅ 已結束休假 #${id}（${v.start_date} ~ ${v.end_date}）`);
  return { ok: true, message: `已結束休假 #${id}（${rangeText(v.start_date, v.end_date)}），預約已恢復開放。` };
}

// 休假期間每天一建立討論串就公告會洗版，所以休假中的日期不發「已開放」公告
export { getVacationForDate as isVacationDate } from "./db.js";

// 休假結束日已過 → 發一則「恢復開放」公告並清掉紀錄。啟動與每天 00:05 都會呼叫，沒有就什麼都不做
export async function announceEndedVacations(guildId, deps) {
  const today = getBookingDateToday();
  for (const v of getEndedVacations(guildId, today)) {
    deleteVacation(v.id); // 先刪再發，萬一發送途中重啟也不會重複公告
    const image = deps.unlockImage?.();
    await deps.sendAnnouncement(deps.settings, `@everyone 📢 公告：休假結束，今天起恢復開放預約囉！`, image ? [image] : []);
    await deps.logToAdmin(deps.settings, `🏖️ 休假 #${v.id}（${v.start_date} ~ ${v.end_date}）已結束，已公告恢復開放`);
  }
}
