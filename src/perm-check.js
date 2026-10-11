// 發訊息失敗（Missing Permissions）時，查出機器人在該頻道實際缺哪些權限，讓 log 跟管理員紀錄頻道能直接寫出答案
import { PermissionFlagsBits as P } from "discord.js";

// needs：[[權限旗標, 顯示名稱], ...]
export async function missingChannelPermissions(channel, needs) {
  try {
    const members = channel?.guild?.members;
    const me = members?.me ?? (await members?.fetchMe?.());
    const perms = me && channel.permissionsFor?.(me);
    if (!perms) return null; // 無法判斷
    return needs.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
  } catch {
    return null;
  }
}

export function announcementNeeds({ hasFiles, mentionsEveryone }) {
  const needs = [
    [P.ViewChannel, "查看頻道"],
    [P.SendMessages, "發送訊息"],
  ];
  if (hasFiles) needs.push([P.AttachFiles, "附加檔案"]);
  if (mentionsEveryone) needs.push([P.MentionEveryone, "提及 @everyone、@here 和所有身分組"]);
  return needs;
}
