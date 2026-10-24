export function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isDailyTaskDue(schedule, now = new Date(), lastSuccessDate = '') {
  if (schedule?.enabled !== true || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time ?? ''))) return false;
  const [hour, minute] = schedule.time.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute
    && lastSuccessDate !== localDayKey(now);
}
