import Database from "better-sqlite3";

const db = new Database("bookings.db");
db.pragma("journal_mode = WAL");

// 每個語音群各自的頻道設定（取代原本寫死在 .env 的四個頻道 ID）
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id                   TEXT PRIMARY KEY,
    booking_parent_channel_id  TEXT NOT NULL,  -- 預約區，機器人在這裡開每日討論串
    admin_channel_id           TEXT,           -- 選填，機器人紀錄用
    management_channel_id      TEXT,           -- 管理員下鎖定指令的頻道
    announcement_channel_id    TEXT,           -- 選填，@everyone 公告頻道
    created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 預約主表：每一筆預約對應到討論串裡的一則留言（message_id），guild_id 區分是哪個語音群的資料
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
    proxy_for     TEXT,                  -- 若為代約，填代約對象
    status        TEXT NOT NULL DEFAULT 'confirmed',
    fee           INTEGER,               -- 之後結算費用用，先留空
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 記錄每個語音群、每天討論串 + 統計訊息(starter message，第 0 頁) 的 id
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_summary (
    guild_id     TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    channel_id   TEXT NOT NULL,  -- 討論串(thread) id
    message_id   TEXT NOT NULL,  -- 統計訊息(starter message，第 0 頁) id
    locked       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, booking_date)
  )
`);

// 當某天預約筆數多到讓班表 embed 超過長度上限時，多出來的部分會拆到額外分頁訊息
db.exec(`
  CREATE TABLE IF NOT EXISTS summary_pages (
    guild_id     TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    page_index   INTEGER NOT NULL,
    message_id   TEXT NOT NULL,
    PRIMARY KEY (guild_id, booking_date, page_index)
  )
`);

// 記錄「某語音群、某天某時段不開放預約」的設定
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id            TEXT NOT NULL,
    booking_date        TEXT NOT NULL,
    start_time          TEXT NOT NULL,  -- HH:MM
    end_time            TEXT NOT NULL,  -- HH:MM
    reason              TEXT,
    source_recurring_id INTEGER,        -- 由哪條週期鎖定樣板自動產生，手動建立的是 NULL
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// 週期鎖定「樣板」：每個語音群各自的每週固定星期幾時段設定，互不影響
db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_blocked_slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    weekday    INTEGER NOT NULL,  -- 0=週日 ... 6=週六
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---- 語音群設定 ----

export function upsertGuildSettings(guildId, { bookingParentChannelId, adminChannelId, managementChannelId, announcementChannelId }) {
  db.prepare(`
    INSERT INTO guild_settings (guild_id, booking_parent_channel_id, admin_channel_id, management_channel_id, announcement_channel_id)
    VALUES (@guildId, @bookingParentChannelId, @adminChannelId, @managementChannelId, @announcementChannelId)
    ON CONFLICT(guild_id) DO UPDATE SET
      booking_parent_channel_id = excluded.booking_parent_channel_id,
      admin_channel_id = excluded.admin_channel_id,
      management_channel_id = excluded.management_channel_id,
      announcement_channel_id = excluded.announcement_channel_id
  `).run({
    guildId,
    bookingParentChannelId,
    adminChannelId: adminChannelId || null,
    managementChannelId: managementChannelId || null,
    announcementChannelId: announcementChannelId || null,
  });
}

export function getGuildSettings(guildId) {
  return db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`).get(guildId);
}

export function getAllGuildSettings() {
  return db.prepare(`SELECT * FROM guild_settings`).all();
}

export function deleteGuildSettings(guildId) {
  db.prepare(`DELETE FROM guild_settings WHERE guild_id = ?`).run(guildId);
}

// ---- 預約 ----

export function insertBooking({ guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor }) {
  const stmt = db.prepare(`
    INSERT INTO bookings (guild_id, booking_date, message_id, location, scheduled_time, channel, booker_id, proxy_for)
    VALUES (@guildId, @bookingDate, @messageId, @location, @time, @channel, @bookerId, @proxyFor)
  `);
  const result = stmt.run({
    guildId, bookingDate, messageId, location, time, channel, bookerId, proxyFor: proxyFor || null,
  });
  return result.lastInsertRowid;
}

export function getBookingByMessageId(messageId) {
  return db.prepare(`SELECT * FROM bookings WHERE message_id = ?`).get(messageId);
}

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

export function cancelBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
}

export function restoreBookingById(id) {
  db.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?`).run(id);
}

export function getCancelledBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'cancelled'
    ORDER BY scheduled_time ASC, id ASC
  `).all(guildId, bookingDate);
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

export function getBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'confirmed'
  `).all(guildId, bookingDate);
}

export function getConfirmedBookingsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM bookings
    WHERE guild_id = ? AND booking_date = ? AND status = 'confirmed'
    ORDER BY scheduled_time ASC, id ASC
  `).all(guildId, bookingDate);
}

export function getSummaryMessage(guildId, bookingDate) {
  return db.prepare(`SELECT * FROM daily_summary WHERE guild_id = ? AND booking_date = ?`).get(guildId, bookingDate);
}

// thread id 在整個 Discord 是全域唯一的，不需要另外帶 guildId 也能查到正確的一筆
export function getSummaryByThreadId(threadId) {
  return db.prepare(`SELECT * FROM daily_summary WHERE channel_id = ?`).get(threadId);
}

export function setSummaryMessage(guildId, bookingDate, channelId, messageId) {
  db.prepare(`
    INSERT INTO daily_summary (guild_id, booking_date, channel_id, message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, booking_date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `).run(guildId, bookingDate, channelId, messageId);
}

export function getUnlockedPastSummaries(guildId, todayStr) {
  return db.prepare(`
    SELECT * FROM daily_summary
    WHERE guild_id = ? AND booking_date < ? AND locked = 0
  `).all(guildId, todayStr);
}

export function markSummaryLocked(guildId, bookingDate) {
  db.prepare(`UPDATE daily_summary SET locked = 1 WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

// 完全刪掉某個語音群、某個日期的討論串紀錄，只給測試討論串清理用
export function deleteSummaryMessage(guildId, bookingDate) {
  db.prepare(`DELETE FROM daily_summary WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

export function deleteAllSummaryPages(guildId, bookingDate) {
  db.prepare(`DELETE FROM summary_pages WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

export function deleteBookingsByDate(guildId, bookingDate) {
  db.prepare(`DELETE FROM bookings WHERE guild_id = ? AND booking_date = ?`).run(guildId, bookingDate);
}

// ---- 班表分頁訊息（page_index >= 1，page 0 記錄在 daily_summary） ----

export function getSummaryPages(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM summary_pages WHERE guild_id = ? AND booking_date = ? ORDER BY page_index
  `).all(guildId, bookingDate);
}

export function setSummaryPage(guildId, bookingDate, pageIndex, messageId) {
  db.prepare(`
    INSERT INTO summary_pages (guild_id, booking_date, page_index, message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, booking_date, page_index) DO UPDATE SET message_id = excluded.message_id
  `).run(guildId, bookingDate, pageIndex, messageId);
}

export function deleteSummaryPage(guildId, bookingDate, pageIndex) {
  db.prepare(`DELETE FROM summary_pages WHERE guild_id = ? AND booking_date = ? AND page_index = ?`).run(guildId, bookingDate, pageIndex);
}

// ---- 鎖定時段（不開放預約）相關 ----

export function insertBlockedSlot({ guildId, bookingDate, startTime, endTime, reason, sourceRecurringId }) {
  const stmt = db.prepare(`
    INSERT INTO blocked_slots (guild_id, booking_date, start_time, end_time, reason, source_recurring_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(guildId, bookingDate, startTime, endTime, reason || null, sourceRecurringId || null);
  return result.lastInsertRowid;
}

export function getBlockedSlotsByDate(guildId, bookingDate) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? AND booking_date = ? ORDER BY start_time
  `).all(guildId, bookingDate);
}

// 查同一天、同時段有沒有已經存在的鎖定紀錄，用來避免週期鎖定重複產生同一筆
export function getBlockedSlotByDateTimeRange(guildId, bookingDate, startTime, endTime) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? AND booking_date = ? AND start_time = ? AND end_time = ?
  `).get(guildId, bookingDate, startTime, endTime);
}

// 查某條週期鎖定樣板，目前已經產生過哪些一次性鎖定（用於樣板刪除時一併清理）
export function getBlockedSlotsBySourceRecurringId(sourceRecurringId) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE source_recurring_id = ?
  `).all(sourceRecurringId);
}

// 查詢某語音群所有鎖定時段（不分日期），過期與否由呼叫端依「現在時間」判斷後過濾
export function getAllBlockedSlots(guildId) {
  return db.prepare(`
    SELECT * FROM blocked_slots WHERE guild_id = ? ORDER BY booking_date, start_time
  `).all(guildId);
}

export function getBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM blocked_slots WHERE id = ?`).get(id);
}

export function deleteBlockedSlot(id) {
  db.prepare(`DELETE FROM blocked_slots WHERE id = ?`).run(id);
}

// ---- 週期鎖定樣板 ----

export function insertRecurringBlockedSlot({ guildId, weekday, startTime, endTime, reason }) {
  const stmt = db.prepare(`
    INSERT INTO recurring_blocked_slots (guild_id, weekday, start_time, end_time, reason)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(guildId, weekday, startTime, endTime, reason || null);
  return result.lastInsertRowid;
}

export function getRecurringBlockedSlotsByWeekday(guildId, weekday) {
  return db.prepare(`
    SELECT * FROM recurring_blocked_slots WHERE guild_id = ? AND weekday = ? ORDER BY start_time
  `).all(guildId, weekday);
}

export function getAllRecurringBlockedSlots(guildId) {
  return db.prepare(`
    SELECT * FROM recurring_blocked_slots WHERE guild_id = ? ORDER BY weekday, start_time
  `).all(guildId);
}

export function getRecurringBlockedSlotById(id) {
  return db.prepare(`SELECT * FROM recurring_blocked_slots WHERE id = ?`).get(id);
}

// 只刪樣板本身，不會動到已經產生出來的一次性鎖定（那些要清理由呼叫端另外處理）
export function deleteRecurringBlockedSlot(id) {
  db.prepare(`DELETE FROM recurring_blocked_slots WHERE id = ?`).run(id);
}

export default db;
