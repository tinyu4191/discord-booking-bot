// 「限定地點時段」用的地點判斷（模糊比對）。純函式，不碰資料庫。
// 預約留言裡的「地點」是使用者自己打的，所以用關鍵字判斷屬於哪個突襲王：
//   龍王：龍王、闇黑龍王、暗黑龍王、黑龍…
//   蝴蝶王：蝴蝶、蝴蝶王、艾畢奈亞…
//   樹王：樹王
//   阿卡伊農：阿卡、阿卡伊農
export const LOCATION_DEFS = [
  { key: "dragon", label: "龍王", pattern: /龍王|闇黑龍|暗黑龍|黑龍/, hint: "龍王／闇黑龍王" },
  { key: "butterfly", label: "蝴蝶王", pattern: /蝴蝶|艾畢奈亞|艾比奈亞|畢奈亞/, hint: "蝴蝶／蝴蝶王／艾畢奈亞" },
  { key: "tree", label: "樹王", pattern: /樹王/, hint: "樹王" },
  { key: "akayron", label: "阿卡伊農", pattern: /阿卡/, hint: "阿卡伊農／阿卡" },
];

const SEPARATORS = /[,，、;；&＆+＋/／\s]+/;
const byKey = (key) => LOCATION_DEFS.find((d) => d.key === key);

// 一段文字（預約的地點，或管理者輸入的選項）屬於哪些地點，回傳 key 陣列（依 LOCATION_DEFS 順序、不重複）
export function matchLocationKeys(text) {
  const t = String(text ?? "");
  return LOCATION_DEFS.filter((d) => d.pattern.test(t)).map((d) => d.key);
}

// 解析管理者輸入的 location 選項（可用逗號、頓號、空白分隔多個）。
// 回傳 { keys, unknown }：unknown 是認不出來的片段，呼叫端要拒絕並提示
export function parseLocationOption(input) {
  const tokens = String(input ?? "").split(SEPARATORS).map((s) => s.trim()).filter(Boolean);
  const keys = new Set();
  const unknown = [];
  for (const token of tokens) {
    const hit = matchLocationKeys(token);
    if (hit.length) hit.forEach((k) => keys.add(k));
    else unknown.push(token);
  }
  return { keys: LOCATION_DEFS.filter((d) => keys.has(d.key)).map((d) => d.key), unknown };
}

export function formatLocationKeys(keys) {
  return LOCATION_DEFS.filter((d) => keys.includes(d.key)).map((d) => d.key).concat(keys.filter((k) => !byKey(k))).map((k) => byKey(k)?.label ?? k).join("、");
}

// 預約的地點在不在允許清單裡。地點文字同時提到多個王（例如「龍王+蝴蝶」）時，只要其中一個在清單內就算允許
export function isLocationAllowed(bookingLocation, allowedKeys) {
  return matchLocationKeys(bookingLocation).some((k) => allowedKeys.includes(k));
}

// 資料庫存的 locations 欄位（JSON 字串）→ key 陣列
export function windowKeys(win) {
  try {
    const arr = JSON.parse(win.locations);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 自動完成：支援「一路選下去」的多選。
//   輸入 ""            → 四個地點
//   輸入 "龍王"        → "龍王"、"龍王、蝴蝶王"、"龍王、樹王"…（挑一個就會變成新的輸入，接著還能再挑）
//   輸入 "龍王、樹"    → 以「龍王、」為前綴，補上符合「樹」的地點
export function suggestLocations(typed = "") {
  const text = String(typed);
  const endsWithSep = /[,，、;；&＆+＋/／\s]$/.test(text) && text.trim() !== "";
  const tokens = text.split(SEPARATORS).map((s) => s.trim()).filter(Boolean);

  let chosenTokens = endsWithSep ? tokens : tokens.slice(0, -1);
  let partial = endsWithSep ? "" : tokens[tokens.length - 1] ?? "";
  // 最後一段本身已經是完整的地點（例如剛選完「龍王」）→ 當成已選，接著提供「再加一個」
  const lastIsComplete = partial !== "" && matchLocationKeys(partial).length > 0;
  if (lastIsComplete) {
    chosenTokens = tokens;
    partial = "";
  }

  const chosen = parseLocationOption(chosenTokens.join(" ")).keys;
  const remaining = LOCATION_DEFS.filter((d) => !chosen.includes(d.key)).filter(
    (d) => !partial || d.label.includes(partial) || d.hint.includes(partial) || partial.includes(d.label)
  );

  const out = [];
  // 還在打字（最後一段沒打完）時不放「就這樣」，直接給補完的選項
  if (chosen.length && !partial) out.push({ name: `${formatLocationKeys(chosen)}（就這樣）`, value: formatLocationKeys(chosen) });
  for (const d of remaining) {
    const keys = [...chosen, d.key];
    const value = formatLocationKeys(LOCATION_DEFS.filter((x) => keys.includes(x.key)).map((x) => x.key));
    out.push({ name: chosen.length ? `＋ ${d.label}（${value}）` : `${d.label}（${d.hint}）`, value });
  }
  return out.slice(0, 25);
}
