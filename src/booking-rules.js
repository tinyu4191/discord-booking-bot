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

// 找出某個時間點「前後最近一個可以預約的時間」，給衝突／鎖定的回覆當作改約參考（只是建議，不會自動預約）。
// 判斷規則跟 checkBookingSlot 一致：不在鎖定時段（含頭尾）、跟其他預約相差至少 5 分鐘。
// notBefore：往前找的下限（今天的話傳入現在的分鐘數，避免建議已經過去的時間）
// 回傳 { before: 分鐘數|null, after: 分鐘數|null }
export function findNearestFreeTimes(guildId, bookingDate, minutes, { notBefore = 0 } = {}) {
  const blocked = getBlockedSlotsByDate(guildId, bookingDate);
  const taken = getBookingsByDate(guildId, bookingDate)
    .map((b) => timeToMinutes(b.scheduled_time))
    .filter((m) => m !== null);

  const isFree = (m) => !blocked.some((slot) => isWithinBlockedSlot(m, slot)) && taken.every((t) => Math.abs(t - m) >= 5);

  let before = null;
  for (let m = minutes - 1; m >= Math.max(0, notBefore); m--) {
    if (isFree(m)) {
      before = m;
      break;
    }
  }
  let after = null;
  for (let m = minutes + 1; m <= 1439; m++) {
    if (isFree(m)) {
      after = m;
      break;
    }
  }
  return { before, after };
}
