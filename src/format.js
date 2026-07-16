// 產生固定格式的【預約統計】訊息（含格式教學 + 目前預約清單）
import { EmbedBuilder } from "discord.js";

// 固定不變的格式教學（討論串建立時發一次，不會再被編輯）
export function formatGuideText(bookingDate) {
  const header = `【${formatDateLabel(bookingDate)} (${getWeekdayLabel(bookingDate)}) 預約說明】`;
  return (
    `${header}\n` +
    "請直接在這個討論串留言預約，格式如下（可複製後修改）：\n" +
    "```\n地點：\n時間：\n頻道：(不確定可寫當日決定)\n代約：(如有代約請填寫遊戲ID)\n```\n" +
    "・日後要修改頻道等資訊，直接編輯這則留言即可，機器人會自動同步\n" +
    "・要取消預約，直接刪除這則留言即可"
  );
}

// 討論串標題，例如：【07/14 (一) 預約討論串】
export function formatThreadTitle(bookingDate) {
  return `【${formatDateLabel(bookingDate)} (${getWeekdayLabel(bookingDate)}) 預約討論串】`;
}

export function formatDateLabel(bookingDate) {
  const [, m, d] = bookingDate.split("-");
  return `${m}/${d}`;
}

// 0=週日 ... 6=週六，用 UTC 計算避免時區位移影響「日期」本身的星期判斷
export function getWeekdayIndex(bookingDate) {
  const [y, m, d] = bookingDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// 中文星期簡稱：日一二三四五六
export function getWeekdayLabel(bookingDate) {
  const chars = "日一二三四五六";
  return chars[getWeekdayIndex(bookingDate)];
}

// 依 Asia/Ho_Chi_Minh 時區取得今天日期字串 YYYY-MM-DD
// 測試用：如果有設定 TEST_TODAY_OVERRIDE 環境變數（格式 YYYY-MM-DD），直接回傳那個日期
export function getBookingDateToday() {
  if (process.env.TEST_TODAY_OVERRIDE) {
    return process.env.TEST_TODAY_OVERRIDE;
  }

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

// 把 YYYY-MM-DD 往後推 N 天，回傳新的 YYYY-MM-DD
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// 把 "HH:MM" 轉成分鐘數，格式錯誤回傳 null
export function timeToMinutes(timeStr) {
  const match = (timeStr || "").trim().match(/^([0-1]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 判斷某個時間（分鐘數）是否落在鎖定時段（含頭尾）之內
export function isWithinBlockedSlot(minutes, slot) {
  const startMin = timeToMinutes(slot.start_time);
  const endMin = timeToMinutes(slot.end_time);
  if (startMin === null || endMin === null) return false;
  return minutes >= startMin && minutes <= endMin;
}

// 把當天預約清單做成 embed 卡片，index.js 跟一次性遷移腳本共用這個函式
export function buildSummaryEmbed(bookingDate, bookings) {
  const title = `📅 ${formatDateLabel(bookingDate)} (${getWeekdayLabel(bookingDate)}) 預約統計`;
  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2);

  if (!bookings.length) {
    embed.setDescription("目前尚無預約 🌙");
    return embed;
  }

  const sorted = bookings
    .slice()
    .sort((a, b) => timeToMinutes(a.scheduled_time) - timeToMinutes(b.scheduled_time));

  const description = sorted
    .map((b) => {
      const proxyLine = b.proxy_for ? `　(代約: ${b.proxy_for})` : "";
      return `🕒 **${b.scheduled_time}**　📍 ${b.location}　🔀 ${b.channel || "當日決定"}\n👤 <@${b.booker_id}>${proxyLine}`;
    })
    .join("\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n");

  embed.setDescription(description);
  return embed;
}

// 依 Asia/Ho_Chi_Minh 時區取得「現在」的分鐘數（0:00 起算），用來判斷鎖定時段是否已過期
export function getCurrentTimeMinutes() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

// 判斷這則留言看起來像不像是要預約（有沒有出現「地點：」或「時間：」關鍵字）
// 用來過濾掉客服對話、閒聊等一般留言，避免機器人誤判成格式錯誤而亂回覆
export function isBookingAttempt(content) {
  return /地點[:：]|時間[:：]/.test(content || "");
}

// 判斷管理頻道的留言是「鎖定」還是「解除鎖定」指令，第一行不是這兩種開頭就當作一般聊天忽略
export function getAdminCommandType(content) {
  const firstLine = (content || "").trim().split("\n")[0].trim();
  if (/^解除鎖定/.test(firstLine)) return "unblock";
  if (/^查詢鎖定/.test(firstLine)) return "list";
  if (/^鎖定/.test(firstLine)) return "block";
  return null;
}

// 解析「鎖定」指令：日期／開始／結束／原因
export function parseBlockCommand(content) {
  const get = (label) => {
    const re = new RegExp(`${label}[:：]\\s*(.*)`);
    const m = (content || "").match(re);
    return m ? m[1].trim() : "";
  };
  return {
    date: get("日期"),
    start: get("開始"),
    end: get("結束"),
    reason: get("原因"),
  };
}

// 解析「解除鎖定」指令：編號
export function parseUnblockCommand(content) {
  const m = (content || "").match(/編號[:：]\s*(\d+)/);
  return { id: m ? Number(m[1]) : null };
}

// 把 "MM/DD" 轉成完整的 YYYY-MM-DD（用今年的年份），格式錯誤回傳 null
export function parseMMDDToFullDate(input) {
  const trimmed = (input || "").trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;

  const todayStr = getBookingDateToday();
  const year = Number(todayStr.slice(0, 4));
  const month = String(Number(match[1])).padStart(2, "0");
  const day = String(Number(match[2])).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 解析使用者在討論串留的固定格式留言
// 支援全形/半形冒號，並且會自動去掉像「(不確定可寫當日決定)」這種提示文字
export function parseBookingMessage(content) {
  const get = (label) => {
    const re = new RegExp(`${label}[:：]\\s*(.*)`);
    const m = (content || "").match(re);
    if (!m) return "";
    return m[1].replace(/[（(].*?[)）]/g, "").trim();
  };

  return {
    location: get("地點"),
    time: get("時間"),
    channel: get("頻道"),
    proxyFor: get("代約"),
  };
}