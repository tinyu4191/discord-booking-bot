// 預約規則的共用檢查。
// 一般預約（討論串留言）跟「續約」都走同一份規則，避免兩邊判斷不一致。
import { getBlockedSlotsByDate, getBookingsByDate } from "./db.js";
import { isWithinBlockedSlot, timeToMinutes } from "./format.js";

// 檢查某個語音群、某一天的某個時間點（分鐘數）能不能預約。
//   - 落在鎖定時段（含頭尾）→ { type: "blocked", slot }
//   - 前後 5 分鐘內已有其他預約（不分地點/頻道）→ { type: "conflict", booking }
//   - 可以預約 → null
// excludeBookingId：編輯自己的預約時，要把自己排除，不然會跟自己衝突
//
// 注意：這個函式是同步的，呼叫端要在「檢查」跟「寫入」之間不要 await，才不會被別的預約插隊
export function checkBookingSlot(guildId, bookingDate, minutes, excludeBookingId = null) {
  const blocked = getBlockedSlotsByDate(guildId, bookingDate).find((slot) => isWithinBlockedSlot(minutes, slot));
  if (blocked) return { type: "blocked", slot: blocked };

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
export function computeNearestFreeTimes({ blockedSlots, takenMinutes }, minutes, { notBefore = 0 } = {}) {
  const lower = Math.max(0, notBefore);
  const isFree = (m) =>
    !blockedSlots.some((slot) => isWithinBlockedSlot(m, slot)) && takenMinutes.every((t) => Math.abs(t - m) >= 5);

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
export function findNearestFreeTimes(guildId, bookingDate, minutes, { notBefore = 0 } = {}) {
  const blockedSlots = getBlockedSlotsByDate(guildId, bookingDate);
  const takenMinutes = getBookingsByDate(guildId, bookingDate)
    .map((b) => timeToMinutes(b.scheduled_time))
    .filter((m) => m !== null);
  return computeNearestFreeTimes({ blockedSlots, takenMinutes }, minutes, { notBefore });
}
