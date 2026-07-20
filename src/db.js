import Database from "better-sqlite3";

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

// 預約主表：每一筆預約對應到討論串裡的一則留言（message_id）
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    booking_date  TEXT NOT NULL,        -- YYYY-MM-DD（依 Asia/Ho_Chi_Minh 時區）
    message_id    TEXT UNIQUE,          -- 使用者留言的 Discord message id，用來追蹤編輯/刪除
    location      TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    channel       TEXT,                  -- 遊戲頻道，可能是「當日決定」或空字串
    booker_id     TEXT NOT NULL,         -- 留言者的 Discord user id
    proxy_for     TEXT,                  -- 若為代約，填代約對象（目前討論串格式尚未使用）
    status        TEXT NOT NULL DEFAULT 'confirmed',
    fee           INTEGER,               -- 之後結算費用用，先留空
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 記錄每天討論串 + 統計訊息(starter message)的 id，方便之後查找與編輯
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_summary (
    booking_date TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,  -- 討論串(thread) id
    message_id   TEXT NOT NULL,  -- 統計訊息(starter message) id
    locked       INTEGER NOT NULL DEFAULT 0  -- 是否已被自動鎖定/封存
  )
`);

// 記錄「某天某時段不開放預約」的設定。source_recurring_id 若不為空，代表這筆是
// 從某條週期鎖定樣板（recurring_blocked_slots）自動產生出來的，方便追蹤來源，
// 但解除時跟手動建立的一次性鎖定完全一樣，都是同一套「解除鎖定：編號：X」指令
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_date        TEXT NOT NULL,
    start_time          TEXT NOT NULL,  -- HH:MM
    end_time            TEXT NOT NULL,  -- HH:MM
    reason              TEXT,
    source_recurring_id INTEGER,        -- 由哪條週期鎖定樣板自動產生，手動建立的是 NULL
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 舊版資料庫沒有 source_recurring_id 欄位時，自動補上（安全、可重複執行）
const blockedSlotsColumns = db.prepare(`PRAGMA table_info(blocked_slots)`).all().map((c) => c.name);
if (!blockedSlotsColumns.includes("source_recurring_id")) {
  db.exec(`ALTER TABLE blocked_slots ADD COLUMN source_recurring_id INTEGER`);
}

// 週期鎖定「樣板」：每週固定星期幾的某個時段不開放（例如每週五晚上固定休息）。
// 這張表本身不會直接拿來擋預約——實際擋預約用的是 blocked_slots 裡自動產生出來的那些一次性紀錄，
// 樣板只在每天建立新討論串時，被拿來檢查「今天要不要自動產生一筆單次鎖定」
db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_blocked_slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    weekday    INTEGER NOT NULL,  -- 0=週日 ... 6=週六
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function insertBooking({ guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor }) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guild_id, booking_date, message_id, location, scheduled_time, channel, booker_id, proxy_for)
    VALUES (@guildId, @bookingDate, @messageId, @location, @time, @channel, @bookerId, @proxyFor)
  `);
  const result = stmt.run({
    guildId,
    bookingDate,
    messageId,
    location,
    time,
    channel,
    bookerId,
    proxyFor: proxyFor || null,
  });
  return result.lastInsertRowid;
}

export function getBookingByMessageId(messageId) {
  return db.prepare(`SELECT * FROM bookings WHERE message_id = ?`).get(messageId);
}

// 依內部 id 查詢/更新/刪除，給人工後台管理用（例如處理沒有對應真實留言的舊資料）
export function getBookingById(id) {
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
}

export function updateBookingById(id, { location, time, channel, proxyFor }) {
  db.prepare(`
    UPDATE bookings SET location = ?, scheduled_time = ?, channel = ?, proxy_for = ?
    WHERE id = ?
  `).run(location, time, channel, proxyFor || null, id);
}

export function deleteBookingById(id) {
  db.prepare(`DELETE FROM bookings WHERE id = ?`).run(id);
}

// 軟刪除：狀態改成 cancelled，資料還在、不會顯示在班表上，之後可以復原
export function cancelBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
}

// 復原：把 cancelled 的預約狀態改回 confirmed，重新出現在班表上
export function restoreBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?`).run(id);
}

// 查某天所有被取消（軟刪除）的預約，方便找出要復原的 id
export function getCancelledBookingsByDate(bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE booking_date = ? AND status = 'cancelled'
    ORDER BY scheduled_time ASC, id ASC
  `).all(bookingDate);
}

export function updateBookingFromMessage(messageId, { location, time, channel, proxyFor }) {
  db.prepare(`
    UPDATE bookings SET location = ?, scheduled_time = ?, channel = ?, proxy_for = ?
    WHERE message_id = ?
  `).run(location, time, channel, proxyFor || null, messageId);
}

export function deleteBookingByMessageId(messageId) {
  db.prepare(`DELETE FROM bookings WHERE message_id = ?`).run(messageId);
}

export function getBookingsByDate(bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE booking_date = ? AND status = 'confirmed'
  `).all(bookingDate);
}

export function getConfirmedBookingsByDate(bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE booking_date = ? AND status = 'confirmed'
    ORDER BY scheduled_time ASC, id ASC
  `).all(bookingDate);
}

export function getSummaryMessage(bookingDate) {
  return db.prepare(`SELECT * FROM daily_summary WHERE booking_date = ?`).get(bookingDate);
}

export function getSummaryByThreadId(threadId) {
  return db.prepare(`SELECT * FROM daily_summary WHERE channel_id = ?`).get(threadId);
}

export function setSummaryMessage(bookingDate, channelId, messageId) {
  db.prepare(`
    INSERT INTO daily_summary (booking_date, channel_id, message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(booking_date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `).run(bookingDate, channelId, messageId);
}

// 日期已過去、但還沒被鎖定的討論串（供每日排程鎖定用）
export function getUnlockedPastSummaries(todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE booking_date < ? AND locked = 0
  `).all(todayStr);
}

export function markSummaryLocked(bookingDate) {
  db.prepare(`UPDATE daily_summary SET locked = 1 WHERE booking_date = ?`).run(bookingDate);
}

// ---- 鎖定時段（不開放預約）相關 ----

export function insertBlockedSlot({ bookingDate, startTime, endTime, reason, sourceRecurringId }) {
  const stmt = db.prepare(`
    INSERT INTO blocked_slots (booking_date, start_time, end_time, reason, source_recurring_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(bookingDate, startTime, endTime, reason || null, sourceRecurringId || null);
  return result.lastInsertRowid;
}

export function getBlockedSlotsByDate(bookingDate) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE booking_date = ? ORDER BY start_time
  `).all(bookingDate);
}

// 查同一天、同時段有沒有已經存在的鎖定紀錄，用來避免週期鎖定重複產生同一筆
export function getBlockedSlotByDateTimeRange(bookingDate, startTime, endTime) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE booking_date = ? AND start_time = ? AND end_time = ?
  `).get(bookingDate, startTime, endTime);
}

// 查某條週期鎖定樣板，目前已經產生過哪些一次性鎖定（用於樣板刪除時一併清理）
export function getBlockedSlotsBySourceRecurringId(sourceRecurringId) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE source_recurring_id = ?
  `).all(sourceRecurringId);
}

// 查詢所有鎖定時段（不分日期），過期與否由呼叫端依「現在時間」判斷後過濾
export function getAllBlockedSlots() {
  return db.prepare(`
    SELECT * FROM blocked_slots ORDER BY booking_date, start_time
  `).all();
}

export function getBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM blocked_slots WHERE id = ?`).get(id);
}

export function deleteBlockedSlot(id) {
  db.prepare(`DELETE FROM blocked_slots WHERE id = ?`).run(id);
}

// ---- 週期鎖定樣板 ----

export function insertRecurringBlockedSlot({ weekday, startTime, endTime, reason }) {
  const stmt = db.prepare(`
    INSERT INTO recurring_blocked_slots (weekday, start_time, end_time, reason)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(weekday, startTime, endTime, reason || null);
  return result.lastInsertRowid;
}

export function getRecurringBlockedSlotsByWeekday(weekday) {
  return db.prepare(`
    SELECT * FROM recurring_blocked_slots WHERE weekday = ? ORDER BY start_time
  `).all(weekday);
}

export function getAllRecurringBlockedSlots() {
  return db.prepare(`
    SELECT * FROM recurring_blocked_slots ORDER BY weekday, start_time
  `).all();
}

export function getRecurringBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM recurring_blocked_slots WHERE id = ?`).get(id);
}

// 只刪樣板本身，不會動到已經產生出來的一次性鎖定（那些要清理由呼叫端另外處理）
export function deleteRecurringBlockedSlot(id) {
  db.prepare(`DELETE FROM recurring_blocked_slots WHERE id = ?`).run(id);
}

export default db;