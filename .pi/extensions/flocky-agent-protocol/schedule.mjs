export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeLocalTimes(localTimes = []) {
  return localTimes.map((time) => String(time).trim());
}

export function areValidLocalTimes(localTimes = []) {
  const normalized = normalizeLocalTimes(localTimes);
  return normalized.length > 0 && normalized.every((time) => LOCAL_TIME_PATTERN.test(time));
}
