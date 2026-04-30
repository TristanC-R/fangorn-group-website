import { tilthStore } from "../tilth/state/localStore.js";
import { syncTasksToGoogle } from "./googleCalendarSync.js";

export function addDays(dateIso, days) {
  if (!dateIso || days === "" || days == null || !Number.isFinite(Number(days)) || Number(days) <= 0) return null;
  const d = new Date(`${dateIso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

export function upsertFarmTask(farmId, task, { syncGoogle = true } = {}) {
  if (!farmId || !task?.title || !task?.dueDate) return null;
  const result = tilthStore.upsertTask(farmId, task);
  if (syncGoogle) {
    syncTasksToGoogle(farmId, result.tasks).catch(() => {});
  }
  return result.task;
}

export function cancelFarmTaskBySourceKey(farmId, sourceKey, { syncGoogle = true } = {}) {
  if (!farmId || !sourceKey) return null;
  const result = tilthStore.cancelTaskBySourceKey(farmId, sourceKey);
  if (result.task && syncGoogle) {
    syncTasksToGoogle(farmId, result.tasks).catch(() => {});
  }
  return result.task;
}

export function titleWithSubject(prefix, subject) {
  return subject ? `${prefix}: ${subject}` : prefix;
}
