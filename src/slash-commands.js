// 管理用斜線指令（英文指令名稱，說明文字用中文）。
//   /lock add | edit | remove | list      單次鎖定
//   /weekly add | edit | remove | list    週期鎖定（一條規則可以涵蓋「每天／平日／假日」或單一星期）
//   /restrict add | edit | remove | list  限定地點時段（某時段只接受指定地點的預約）
//   /report subscribe | unsubscribe       日報訂閱
//   /testthread create | delete           測試討論串
//   /help                                 功能說明
// 規則：
//   - 只能在「管理頻道」使用（其他頻道會被拒絕）；指令預設只有擁有「管理貼文」權限的人看得到
//   - 回覆都是「只有操作者看得到」，不會塞滿管理頻道；真正的變更仍然會寫進機器人紀錄頻道、發公告
//   - 舊的文字指令（鎖定：…）仍然可用，兩邊共用同一份邏輯
import { Events, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { addDays, formatDateLabel, formatWeekdayMask, getBookingDateToday, getWeekdayLabel, minutesToTime, parseDaysOption, parseMMDDToFullDate, timeToMinutes } from "./format.js";
import { getAllRecurringBlockedSlots, getGuildSettings, getAllGuildSettings, getUpcomingBlockedSlots, getUpcomingLocationWindows, getUpcomingVacations, ruleWeekdayMask } from "./db.js";
import { addWeekly, editBlock, editWeekly, removeWeekly } from "./block-ops.js";
import { handleReportSubscriptionCommand } from "./daily-report-publisher.js";
import { addWindow, editWindow, removeWindow } from "./location-ops.js";
import { addVacation, editVacation, endVacation } from "./vacation-ops.js";
import { formatLocationKeys, parseLocationOption, suggestLocations, windowKeys } from "./location-rules.js";

export const SLASH_COMMAND_NAMES = ["lock", "weekly", "restrict", "vacation", "report", "testthread", "help"];
const EPHEMERAL = MessageFlags.Ephemeral;

// ---------------------------------------------------------------------------
// 指令定義
// ---------------------------------------------------------------------------
const DAY_CHOICES = [
  { name: "每天", value: "everyday" }, { name: "平日（一~五）", value: "weekdays" }, { name: "假日（六日）", value: "weekends" },
  { name: "週一", value: "mon" }, { name: "週二", value: "tue" }, { name: "週三", value: "wed" }, { name: "週四", value: "thu" },
  { name: "週五", value: "fri" }, { name: "週六", value: "sat" }, { name: "週日", value: "sun" },
];

const timeOpt = (o, name, desc, required) => o.setName(name).setDescription(desc).setRequired(required).setAutocomplete(true);

export function buildCommandDefs() {
  const mk = (name, desc) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(desc)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads) // 預設只有有「管理貼文」權限的人看得到（伺服器可在整合設定裡另外調整）
      .setContexts(InteractionContextType.Guild); // 只能在伺服器裡用，私訊不行

  const lock = mk("lock", "鎖定時段（單次）：新增、修改、解除、查詢")
    .addSubcommand((s) => s.setName("add").setDescription("新增一筆鎖定（不開放預約的時段）")
      .addStringOption((o) => o.setName("date").setDescription("日期（可選下拉，或輸入 MM/DD）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => timeOpt(o, "start", "開始時間 HH:MM", true))
      .addStringOption((o) => timeOpt(o, "end", "結束時間 HH:MM", true))
      .addStringOption((o) => o.setName("reason").setDescription("原因（選填）").setRequired(false)))
    .addSubcommand((s) => s.setName("edit").setDescription("修改某一筆鎖定（只發一則「調整」公告）")
      .addIntegerOption((o) => o.setName("id").setDescription("要修改的鎖定（從選單挑）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => timeOpt(o, "start", "新的開始時間（不改就不填）", false))
      .addStringOption((o) => timeOpt(o, "end", "新的結束時間（不改就不填）", false))
      .addStringOption((o) => o.setName("reason").setDescription("新的原因（填 - 代表清掉原因）").setRequired(false)))
    .addSubcommand((s) => s.setName("remove").setDescription("解除某一筆鎖定（週期產生的只解除那一天）")
      .addIntegerOption((o) => o.setName("id").setDescription("要解除的鎖定（從選單挑）").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("查詢本週（週二~下週一）的所有鎖定"));

  const weekly = mk("weekly", "週期鎖定：每週固定時段，新增、修改、解除、查詢")
    .addSubcommand((s) => s.setName("add").setDescription("新增週期鎖定（可選每天／平日／假日／單一星期）")
      .addStringOption((o) => o.setName("days").setDescription("要鎖定的星期").setRequired(true).addChoices(...DAY_CHOICES))
      .addStringOption((o) => timeOpt(o, "start", "開始時間 HH:MM", true))
      .addStringOption((o) => timeOpt(o, "end", "結束時間 HH:MM", true))
      .addStringOption((o) => o.setName("reason").setDescription("原因（選填）").setRequired(false)))
    .addSubcommand((s) => s.setName("edit").setDescription("修改週期鎖定（已產生、還沒發生的日子會跟著改）")
      .addIntegerOption((o) => o.setName("id").setDescription("要修改的週期規則（從選單挑）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("days").setDescription("新的星期（不改就不填）").setRequired(false).addChoices(...DAY_CHOICES))
      .addStringOption((o) => timeOpt(o, "start", "新的開始時間（不改就不填）", false))
      .addStringOption((o) => timeOpt(o, "end", "新的結束時間（不改就不填）", false))
      .addStringOption((o) => o.setName("reason").setDescription("新的原因（填 - 代表清掉原因）").setRequired(false)))
    .addSubcommand((s) => s.setName("remove").setDescription("永久解除某條週期鎖定（連同還沒發生的鎖定）")
      .addIntegerOption((o) => o.setName("id").setDescription("要解除的週期規則（從選單挑）").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("列出所有週期鎖定規則"));

  const restrict = mk("restrict", "限定地點時段：某時段只接受指定地點的預約")
    .addSubcommand((s) => s.setName("add").setDescription("新增限定地點時段（時段內只接受指定地點，會發公告）")
      .addStringOption((o) => o.setName("date").setDescription("日期（可選下拉，或輸入 MM/DD）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => timeOpt(o, "start", "開始時間 HH:MM", true))
      .addStringOption((o) => timeOpt(o, "end", "結束時間 HH:MM", true))
      .addStringOption((o) => o.setName("location").setDescription("開放的地點（可多選：選一個後再選下一個，或用逗號隔開）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("notes").setDescription("備註（選填，會一起公告）").setRequired(false)))
    .addSubcommand((s) => s.setName("edit").setDescription("修改限定地點時段（只發一則「調整」公告）")
      .addIntegerOption((o) => o.setName("id").setDescription("要修改的限定時段（從選單挑）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => timeOpt(o, "start", "新的開始時間（不改就不填）", false))
      .addStringOption((o) => timeOpt(o, "end", "新的結束時間（不改就不填）", false))
      .addStringOption((o) => o.setName("location").setDescription("新的開放地點（整組重選；不改就不填）").setRequired(false).setAutocomplete(true))
      .addStringOption((o) => o.setName("notes").setDescription("新的備註（填 - 代表清掉）").setRequired(false)))
    .addSubcommand((s) => s.setName("remove").setDescription("解除限定地點時段（恢復開放所有地點）")
      .addIntegerOption((o) => o.setName("id").setDescription("要解除的限定時段（從選單挑）").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("列出今天起所有限定地點時段"));

  const vacation = mk("vacation", "休假：一段日期整天不開放預約，只發一則公告，到期自動恢復")
    .addSubcommand((s) => s.setName("add").setDescription("設定休假（含開始日與結束日，既有預約會取消並通知）")
      .addStringOption((o) => o.setName("start").setDescription("開始日（可選下拉，或輸入 MM/DD）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("end").setDescription("結束日，含這一天（可選下拉，或輸入 MM/DD）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("reason").setDescription("原因（選填，會一起公告）").setRequired(false)))
    .addSubcommand((s) => s.setName("edit").setDescription("延長或縮短休假、修改原因")
      .addIntegerOption((o) => o.setName("id").setDescription("要修改的休假（從選單挑）").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("end").setDescription("新的結束日（不改就不填）").setRequired(false).setAutocomplete(true))
      .addStringOption((o) => o.setName("reason").setDescription("新的原因（填 - 代表清掉）").setRequired(false)))
    .addSubcommand((s) => s.setName("end").setDescription("提前結束休假，立刻恢復開放並公告")
      .addIntegerOption((o) => o.setName("id").setDescription("要結束的休假（從選單挑）").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("列出目前與未來的休假"));

  const report = mk("report", "每日預約日報：訂閱或取消訂閱")
    .addSubcommand((s) => s.setName("subscribe").setDescription("恢復訂閱日報"))
    .addSubcommand((s) => s.setName("unsubscribe").setDescription("取消訂閱日報"));

  const testthread = mk("testthread", "測試用討論串：建立或刪除")
    .addSubcommand((s) => s.setName("create").setDescription("建立指定日期的測試討論串")
      .addStringOption((o) => o.setName("date").setDescription("完整日期 YYYY-MM-DD").setRequired(true)))
    .addSubcommand((s) => s.setName("delete").setDescription("刪除指定日期的測試討論串與相關資料")
      .addStringOption((o) => o.setName("date").setDescription("完整日期 YYYY-MM-DD").setRequired(true)));

  const help = mk("help", "顯示管理指令說明");
  return [lock, weekly, restrict, vacation, report, testthread, help].map((b) => b.toJSON());
}

// ---------------------------------------------------------------------------
// 自動完成（純函式，方便測試）
// ---------------------------------------------------------------------------
const clip = (s, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function normalizeTime(input) {
  const m = timeToMinutes(input);
  return m === null ? null : minutesToTime(m);
}

// 今天起 14 天的日期選單；value 是完整日期 YYYY-MM-DD
export function suggestDates(today, typed = "", span = 14) {
  const q = typed.trim();
  return Array.from({ length: span }, (_, i) => addDays(today, i))
    .map((date, i) => ({ name: `${formatDateLabel(date)} (${getWeekdayLabel(date)})${i === 0 ? " 今天" : i === 1 ? " 明天" : ""}`, value: date }))
    .filter((c) => !q || c.name.includes(q) || c.value.includes(q))
    .slice(0, 25);
}

// 時間選單：沒輸入時給整點；有輸入就找開頭符合的，優先整點／半點／15 分
export function suggestTimes(typed = "") {
  const q = typed.trim();
  const exact = normalizeTime(q);
  const all = Array.from({ length: 288 }, (_, i) => minutesToTime(i * 5));
  const pool = q ? all.filter((t) => t.startsWith(q) || t.startsWith(q.padStart(2, "0")) || t.replace(/^0/, "").startsWith(q)) : all;
  const rank = (t) => (Number(t.slice(3)) === 0 ? 0 : Number(t.slice(3)) % 30 === 0 ? 1 : Number(t.slice(3)) % 15 === 0 ? 2 : 3);
  // 輸入「2」時，打頭是 2 的（20:00、21:00…）排在「02:00」前面；同一類裡優先整點、半點、15 分
  const literal = (t) => (t.startsWith(q) ? 0 : 1);
  const sorted = q ? pool.slice().sort((a, b) => literal(a) - literal(b) || rank(a) - rank(b) || a.localeCompare(b)) : pool.filter((t) => rank(t) === 0);
  const list = exact ? [exact, ...sorted.filter((t) => t !== exact)] : sorted;
  return list.slice(0, 25).map((t) => ({ name: t, value: t }));
}

export function suggestBlocks(guildId, today, typed = "") {
  const q = typed.trim();
  return getUpcomingBlockedSlots(guildId, today)
    .map((s) => ({
      name: clip(`#${s.id}｜${formatDateLabel(s.booking_date)} (${getWeekdayLabel(s.booking_date)}) ${s.start_time}~${s.end_time}${s.reason ? `｜${s.reason}` : ""}${s.source_recurring_id ? "｜週期" : ""}`),
      value: s.id,
    }))
    .filter((c) => !q || c.name.includes(q))
    .slice(0, 25);
}

export function suggestRules(guildId, typed = "") {
  const q = typed.trim();
  return getAllRecurringBlockedSlots(guildId)
    .map((r) => ({ name: clip(`#${r.id}｜${formatWeekdayMask(ruleWeekdayMask(r))} ${r.start_time}~${r.end_time}${r.reason ? `｜${r.reason}` : ""}`), value: r.id }))
    .filter((c) => !q || c.name.includes(q))
    .slice(0, 25);
}

export function suggestVacations(guildId, today, typed = "") {
  const q = typed.trim();
  return getUpcomingVacations(guildId, today)
    .map((v) => ({
      name: clip(`#${v.id}｜${formatDateLabel(v.start_date)} ~ ${formatDateLabel(v.end_date)}${v.reason ? `｜${v.reason}` : ""}`),
      value: v.id,
    }))
    .filter((c) => !q || c.name.includes(q))
    .slice(0, 25);
}

export function suggestWindows(guildId, today, typed = "") {
  const q = typed.trim();
  return getUpcomingLocationWindows(guildId, today)
    .map((w) => ({
      name: clip(`#${w.id}｜${formatDateLabel(w.booking_date)} (${getWeekdayLabel(w.booking_date)}) ${w.start_time}~${w.end_time}｜只開放 ${formatLocationKeys(windowKeys(w))}`),
      value: w.id,
    }))
    .filter((c) => !q || c.name.includes(q))
    .slice(0, 25);
}

// ---------------------------------------------------------------------------
// 說明文字
// ---------------------------------------------------------------------------
export const SLASH_HELP_TEXT = [
  "📖 管理指令說明（只能在管理頻道使用，回覆只有你看得到）",
  "",
  "**/lock add** 日期、開始、結束、原因 — 鎖定某一天的時段",
  "**/lock edit** 編號、開始、結束、原因 — 修改鎖定，只發一則「時段調整」公告（週期產生的只改那一天）",
  "**/lock remove** 編號 — 解除某一筆鎖定",
  "**/lock list** — 本週（週二~下週一）的所有鎖定",
  "",
  "**/weekly add** 星期、開始、結束、原因 — 每週固定鎖定，星期可選「每天／平日／假日／單一星期」",
  "**/weekly edit** 編號、星期、開始、結束、原因 — 修改週期規則，已產生、還沒發生的日子會跟著改（手動改過的日子保留）",
  "**/weekly remove** 編號 — 永久解除週期鎖定",
  "**/weekly list** — 所有週期鎖定規則",
  "",
  "**/restrict add** 日期、開始、結束、地點、備註 — 這段時間只接受指定地點（龍王／蝴蝶王／樹王／阿卡伊農，可多選）的預約，會發公告",
  "**/restrict edit** 編號、開始、結束、地點、備註 — 修改，只發一則「調整」公告",
  "**/restrict remove** 編號 / **/restrict list** — 解除／查詢",
  "",
  "**/vacation add** 開始日、結束日、原因 — 一段日期整天不開放預約（含結束日），只發一則公告，既有預約取消並通知，結束後自動公告恢復",
  "**/vacation edit** 編號、結束日、原因 — 延長或縮短 / **/vacation end** 編號 — 提前結束 / **/vacation list** — 查詢",
  "",
  "**/report subscribe** / **/report unsubscribe** — 恢復／取消每天的預約日報",
  "**/testthread create** / **delete** 日期 — 測試討論串",
  "",
  "編號、日期、時間都可以從下拉選單挑，不用自己查編號。舊的文字指令（鎖定：…）暫時仍然可以使用。",
].join("\n");

// ---------------------------------------------------------------------------
// 執行
// ---------------------------------------------------------------------------
// 把舊的文字指令處理函式（只會呼叫 message.reply）包成假訊息，收集回覆再統一回給操作者
function adapter(content, guildId) {
  const replies = [];
  return {
    replies,
    message: { content, guildId, reply: async (o) => { replies.push(typeof o === "string" ? o : o?.content ?? ""); return {}; } },
  };
}

const toMMDD = (fullDate) => `${fullDate.slice(5, 7)}/${fullDate.slice(8, 10)}`;
const cleanReason = (v) => (v ?? "").replace(/\r?\n/g, " ").trim();

// deps.legacy：舊文字指令處理函式 { block, unblock, weekList, recurringList, createTestThread, deleteTestThread }
// deps.opsDeps(settings)：block-ops.js 要用的外部動作
export async function runSlashCommand(i, settings, deps) {
  const sub = i.options.getSubcommand(false);
  const guildId = settings.guild_id;
  const viaLegacy = async (handler, content) => {
    const a = adapter(content, guildId);
    await handler(a.message, settings);
    return a.replies.join("\n\n") || "完成。";
  };
  const time = (name) => {
    const v = i.options.getString(name);
    if (v === null) return undefined;
    return normalizeTime(v) ?? { invalid: v };
  };
  const badTime = (...ts) => ts.find((t) => t && typeof t === "object");

  switch (`${i.commandName}.${sub ?? ""}`) {
    case "lock.add": {
      const date = parseMMDDToFullDate(i.options.getString("date"));
      if (!date) return "日期格式不對，請從選單挑，或輸入 MM/DD（例如 10/14）。";
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${(badTime(start, end)).invalid}。請用 HH:MM（24 小時制），例如 20:30。`;
      return viaLegacy(deps.legacy.block, `鎖定：\n日期：${toMMDD(date)}\n開始：${start}\n結束：${end}\n原因：${cleanReason(i.options.getString("reason"))}`);
    }
    case "lock.edit": {
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${badTime(start, end).invalid}。請用 HH:MM（24 小時制）。`;
      const reason = i.options.getString("reason");
      return (await editBlock(guildId, i.options.getInteger("id"), { start, end, reason: reason === null ? undefined : cleanReason(reason) }, deps.opsDeps(settings))).message;
    }
    case "lock.remove":
      return viaLegacy(deps.legacy.unblock, `解除鎖定：\n編號：${i.options.getInteger("id")}`);
    case "lock.list":
      return viaLegacy(deps.legacy.weekList, "查詢本週鎖定");
    case "weekly.add": {
      const mask = parseDaysOption(i.options.getString("days"));
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${badTime(start, end).invalid}。請用 HH:MM（24 小時制）。`;
      return (await addWeekly(guildId, { mask, start, end, reason: cleanReason(i.options.getString("reason")) }, deps.opsDeps(settings))).message;
    }
    case "weekly.edit": {
      const days = i.options.getString("days");
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${badTime(start, end).invalid}。請用 HH:MM（24 小時制）。`;
      const reason = i.options.getString("reason");
      return (await editWeekly(guildId, i.options.getInteger("id"), { mask: days === null ? undefined : parseDaysOption(days), start, end, reason: reason === null ? undefined : cleanReason(reason) }, deps.opsDeps(settings))).message;
    }
    case "weekly.remove":
      return (await removeWeekly(guildId, i.options.getInteger("id"), deps.opsDeps(settings))).message;
    case "weekly.list":
      return viaLegacy(deps.legacy.recurringList, "查詢週期鎖定");
    case "restrict.add": {
      const date = parseMMDDToFullDate(i.options.getString("date"));
      if (!date) return "日期格式不對，請從選單挑，或輸入 MM/DD（例如 10/14）。";
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${badTime(start, end).invalid}。請用 HH:MM（24 小時制），例如 20:30。`;
      const loc = parseLocationOption(i.options.getString("location"));
      if (loc.unknown.length) return `認不出這些地點：${loc.unknown.join("、")}。可選：龍王（闇黑龍王）、蝴蝶王（蝴蝶、艾畢奈亞）、樹王、阿卡伊農（阿卡）。`;
      return (await addWindow(guildId, { date, start, end, keys: loc.keys, notes: cleanReason(i.options.getString("notes")) }, deps.opsDeps(settings))).message;
    }
    case "restrict.edit": {
      const start = time("start"), end = time("end");
      if (badTime(start, end)) return `時間格式不對：${badTime(start, end).invalid}。請用 HH:MM（24 小時制）。`;
      const rawLoc = i.options.getString("location");
      let keys;
      if (rawLoc !== null) {
        const loc = parseLocationOption(rawLoc);
        if (loc.unknown.length || !loc.keys.length) return `認不出這些地點：${(loc.unknown.length ? loc.unknown : [rawLoc]).join("、")}。可選：龍王、蝴蝶王、樹王、阿卡伊農。`;
        keys = loc.keys;
      }
      const notes = i.options.getString("notes");
      return (await editWindow(guildId, i.options.getInteger("id"), { start, end, keys, notes: notes === null ? undefined : cleanReason(notes) }, deps.opsDeps(settings))).message;
    }
    case "restrict.remove":
      return (await removeWindow(guildId, i.options.getInteger("id"), deps.opsDeps(settings))).message;
    case "restrict.list": {
      const rows = getUpcomingLocationWindows(guildId, getBookingDateToday());
      if (!rows.length) return "今天起沒有任何限定地點時段。";
      return "🎯 限定地點時段：\n" + rows.map((w) => `#${w.id}｜${formatDateLabel(w.booking_date)} (${getWeekdayLabel(w.booking_date)})｜${w.start_time}~${w.end_time}｜只開放 ${formatLocationKeys(windowKeys(w))}${w.notes ? `｜${w.notes}` : ""}`).join("\n");
    }
    case "vacation.add": {
      const start = parseMMDDToFullDate(i.options.getString("start")), end = parseMMDDToFullDate(i.options.getString("end"));
      if (!start || !end) return "日期格式不對，請從選單挑，或輸入 MM/DD（例如 11/01）。";
      return (await addVacation(guildId, { start, end, reason: cleanReason(i.options.getString("reason")) }, deps.opsDeps(settings))).message;
    }
    case "vacation.edit": {
      const rawEnd = i.options.getString("end");
      const end = rawEnd === null ? undefined : parseMMDDToFullDate(rawEnd);
      if (end === null) return "日期格式不對，請從選單挑，或輸入 MM/DD（例如 11/01）。";
      const reason = i.options.getString("reason");
      return (await editVacation(guildId, i.options.getInteger("id"), { end, reason: reason === null ? undefined : cleanReason(reason) }, deps.opsDeps(settings))).message;
    }
    case "vacation.end":
      return (await endVacation(guildId, i.options.getInteger("id"), deps.opsDeps(settings))).message;
    case "vacation.list": {
      const rows = getUpcomingVacations(guildId, getBookingDateToday());
      if (!rows.length) return "目前沒有休假設定。";
      return "🏖️ 休假：\n" + rows.map((v) => `#${v.id}｜${formatDateLabel(v.start_date)} (${getWeekdayLabel(v.start_date)}) ~ ${formatDateLabel(v.end_date)} (${getWeekdayLabel(v.end_date)})（含結束日，隔天恢復）${v.reason ? `｜${v.reason}` : ""}`).join("\n");
    }
    case "report.subscribe":
    case "report.unsubscribe": {
      const a = adapter("", guildId);
      await handleReportSubscriptionCommand(a.message, getGuildSettings(guildId), sub === "subscribe");
      return a.replies.join("\n\n") || "完成。";
    }
    case "testthread.create":
    case "testthread.delete": {
      const date = i.options.getString("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseMMDDToFullDate(date)) return "日期格式不對，請用完整日期 YYYY-MM-DD，例如 2027-03-15。";
      return viaLegacy(sub === "create" ? deps.legacy.createTestThread : deps.legacy.deleteTestThread, `${sub === "create" ? "建立" : "刪除"}測試討論串：\n日期：${date}`);
    }
    case "help.":
      return SLASH_HELP_TEXT;
    default:
      return "不認得這個指令。";
  }
}

export async function handleSlashInteraction(i, deps) {
  const isCommand = i.isChatInputCommand?.();
  const isAuto = i.isAutocomplete?.();
  if (!(isCommand || isAuto) || !SLASH_COMMAND_NAMES.includes(i.commandName)) return false;

  const settings = i.guildId ? getGuildSettings(i.guildId) : null;
  const inManagement = !!settings?.management_channel_id && i.channelId === settings.management_channel_id;

  if (isAuto) {
    let choices = [];
    if (inManagement) {
      const focused = i.options.getFocused(true);
      const today = getBookingDateToday();
      if (i.commandName === "vacation" && ["start", "end"].includes(focused.name)) choices = suggestDates(today, String(focused.value), 60);
      else if (focused.name === "date") choices = suggestDates(today, String(focused.value));
      else if (focused.name === "start" || focused.name === "end") choices = suggestTimes(String(focused.value));
      else if (focused.name === "location") choices = suggestLocations(String(focused.value));
      else if (focused.name === "id" && i.commandName === "vacation") choices = suggestVacations(settings.guild_id, today, String(focused.value));
      else if (focused.name === "id" && i.commandName === "restrict") choices = suggestWindows(settings.guild_id, today, String(focused.value));
      else if (focused.name === "id") choices = i.commandName === "weekly" ? suggestRules(settings.guild_id, String(focused.value)) : suggestBlocks(settings.guild_id, today, String(focused.value));
    }
    await i.respond(choices).catch(() => {});
    return true;
  }

  if (!settings) {
    await i.reply({ content: "這個伺服器還沒有登記，請先用 scripts/add-guild.js 登記。", flags: EPHEMERAL });
    return true;
  }
  if (!inManagement) {
    await i.reply({ content: `這個指令只能在管理頻道使用${settings.management_channel_id ? `：<#${settings.management_channel_id}>` : "（這個伺服器還沒設定管理頻道）"}。`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    return true;
  }

  await i.deferReply({ flags: EPHEMERAL });
  let text;
  try {
    text = await runSlashCommand(i, settings, deps);
  } catch (err) {
    console.error(`[${settings.guild_id}] 斜線指令 /${i.commandName} 執行失敗：`, err);
    text = "執行時發生錯誤，請稍後再試，或查看伺服器 log（pm2 logs booking-bot）。";
  }
  await i.editReply({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// 註冊 + 監聽
// ---------------------------------------------------------------------------
// 每個已登記的語音群各自註冊（伺服器指令，立刻生效）。用 create 一個一個建（同名會更新），不會洗掉其他指令（例如測試用的 demo 指令）
export async function registerSlashCommands(client) {
  const defs = buildCommandDefs();
  const result = { ok: [], failed: [] };
  for (const settings of getAllGuildSettings()) {
    try {
      const guild = await client.guilds.fetch(settings.guild_id);
      for (const def of defs) await guild.commands.create(def);
      result.ok.push(settings.guild_id);
      console.log(`[${settings.guild_id}] 管理斜線指令已註冊（${defs.map((d) => "/" + d.name).join(" ")}）`);
    } catch (err) {
      result.failed.push(settings.guild_id);
      console.warn(`[${settings.guild_id}] 註冊斜線指令失敗：${err.message}。請確認機器人的邀請連結有勾選 applications.commands（需要重新授權一次）。`);
    }
  }
  return result;
}

export function setupSlashCommands(client, deps) {
  client.on(Events.InteractionCreate, (i) => {
    handleSlashInteraction(i, deps).catch((err) => console.error("處理斜線指令時發生錯誤：", err));
  });
}
