// 預約規則的共用檢查。
// 一般預約（討論串留言）跟「續約」都走同一份規則，避免兩邊判斷不一致。
import { getBlockedSlotsByDate, getBookingsByDate, getLocationWindowsByDate, getVacationForDate } from "./db.js";
import { getBookingDateToday, getCurrentTimeMinutes, isWithinBlockedSlot, timeToMinutes } from "./format.js";
import { isLocationAllowed, windowKeys } from "./location-rules.js";

// 這個時間點、這個地點，被哪個「限定地點時段」擋住（沒擋住回傳 undefined）。
// 沒給地點（undefined）就不檢查，給空字串會當成「不在任何允許清單內」
export function findLocationRestriction(windows, minutes, location) {
  if (location === undefined) return undefined;
  return windows.find((w) => isWithinBlockedSlot(minutes, w) && !isLocationAllowed(location, windowKeys(w)));
}

// 這個時間點是不是已經過去了：日期早於今天一定算過去；今天的話，時間小於或等於「現在這一分鐘」算過去
// （預約的目的是「預先」登記，同一分鐘也不行）。日期在今天之後的永遠不算過去
export function isPastBookingTime(bookingDate, minutes, { today = getBookingDateToday(), nowMinutes = getCurrentTimeMinutes() } = {}) {
  if (bookingDate < today) return true;
  if (bookingDate > today) return false;
  return minutes <= nowMinutes;
}

// 新增／編輯預約時要不要因為「時間已經過去」而擋下。
// 編輯舊預約時，只有「把時間改成過去」才擋：時間沒動（只改地點、頻道、代約）仍然允許
export function shouldRejectPastBooking(bookingDate, newMinutes, existingBooking = null, opts) {
  if (existingBooking && timeToMinutes(existingBooking.scheduled_time) === newMinutes) return false;
  return isPastBookingTime(bookingDate, newMinutes, opts);
}

// 檢查某個語音群、某一天的某個時間點（分鐘數）能不能預約。
//   - 落在鎖定時段（含頭尾）→ { type: "blocked", slot }
//   - 落在「限定地點時段」且地點不在允許清單 → { type: "location_restricted", window }（要傳 location 才會檢查）
//   - 前後 5 分鐘內已有其他預約（不分地點/頻道）→ { type: "conflict", booking }
//   - 可以預約 → null
// excludeBookingId：編輯自己的預約時，要把自己排除，不然會跟自己衝突
//
// 注意：這個函式是同步的，呼叫端要在「檢查」跟「寫入」之間不要 await，才不會被別的預約插隊
// 某天「實際生效」的鎖定：一般鎖定 + 休假（整天，當成一筆 00:00~23:59 的鎖定，帶 vacation 標記）
export function getEffectiveBlockedSlots(guildId, bookingDate) {
  const slots = getBlockedSlotsByDate(guildId, bookingDate);
  const vacation = getVacationForDate(guildId, bookingDate);
  if (!vacation) return slots;
  return [{ id: null, guild_id: guildId, booking_date: bookingDate, start_time: "00:00", end_time: "23:59", reason: vacation.reason, vacation }, ...slots];
}

export function checkBookingSlot(guildId, bookingDate, minutes, excludeBookingId = null, location = undefined) {
  const blocked = getEffectiveBlockedSlots(guildId, bookingDate).find((slot) => isWithinBlockedSlot(minutes, slot));
  if (blocked) return { type: "blocked", slot: blocked };

  const restricted = findLocationRestriction(getLocationWindowsByDate(guildId, bookingDate), minutes, location);
  if (restricted) return { type: "location_restricted", window: restricted };

  const conflict = getBookingsByDate(guildId, bookingDate).find((b) => {
    if (excludeBookingId && b.id === excludeBookingId) return false;
    const mins = timeToMinutes(b.scheduled_time);
    return mins !== null && Math.abs(mins - minutes) < 5;
  });
  if (conflict) return { type: "conflict", booking: conflict };

  return null;
}

// 建議空檔至少要比「現在」晚幾分鐘。預約提醒是開始前 1~5 分鐘才發，建議一個 1 分鐘後就開始的時間沒有意義
// 可以在 .env 設定 SUGGEST_MIN_LEAD_MINUTES 調整，沒設定就是 5
function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && value !== undefined && value !== "" ? n : fallback;
}
export const SUGGEST_MIN_LEAD_MINUTES = nonNegativeInt(process.env.SUGGEST_MIN_LEAD_MINUTES, 5);

// 找出某個時間點「前後最近一個可以預約的時間」（純計算，不碰資料庫，方便測試）。
// 判斷規則跟 checkBookingSlot 一致：不在鎖定時段（含頭尾）、跟其他預約相差至少 5 分鐘。
//   blockedSlots：鎖定時段陣列（含 start_time / end_time）
//   takenMinutes：已被預約的時間（分鐘數）陣列
//   notBefore：建議時間的下限（含）。今天的話傳入「現在 + 緩衝」，往前、往後兩側都不會建議比它早的時間
// 回傳 { before: 分鐘數|null, after: 分鐘數|null }
export function computeNearestFreeTimes({ blockedSlots, takenMinutes, locationWindows = [], location }, minutes, { notBefore = 0 } = {}) {
  const lower = Math.max(0, notBefore);
  const isFree = (m) =>
    !blockedSlots.some((slot) => isWithinBlockedSlot(m, slot)) &&
    !findLocationRestriction(locationWindows, m, location) &&
    takenMinutes.every((t) => Math.abs(t - m) >= 5);

  let before = null;
  for (let m = minutes - 1; m >= lower; m--) {
    if (isFree(m)) {
      before = m;
      break;
    }
  }

  // 往後找也要套用下限：想約的時間如果已經過去，往後第一個空檔也可能還在過去
  let after = null;
  for (let m = Math.max(minutes + 1, lower); m <= 1439; m++) {
    if (isFree(m)) {
      after = m;
      break;
    }
  }
  return { before, after };
}

// 從資料庫讀出某天的鎖定時段與預約，再找前後最近的空檔
export function findNearestFreeTimes(guildId, bookingDate, minutes, { notBefore = 0, location } = {}) {
  const blockedSlots = getEffectiveBlockedSlots(guildId, bookingDate);
  const takenMinutes = getBookingsByDate(guildId, bookingDate)
    .map((b) => timeToMinutes(b.scheduled_time))
    .filter((m) => m !== null);
  const locationWindows = getLocationWindowsByDate(guildId, bookingDate);
  return computeNearestFreeTimes({ blockedSlots, takenMinutes, locationWindows, location }, minutes, { notBefore });
}
