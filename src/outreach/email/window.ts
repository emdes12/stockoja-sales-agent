/** Sending hours in Lagos time (WAT, UTC+1, no daylight saving). Pure functions; tested in tests/sending.test.ts. */

const WAT_OFFSET_MS = 60 * 60 * 1000;

export interface WindowSettings {
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  sendOnWeekends: boolean;
}

/** A Date whose UTC fields read as Lagos wall-clock time. */
const toLagos = (d: Date) => new Date(d.getTime() + WAT_OFFSET_MS);
const fromLagos = (d: Date) => new Date(d.getTime() - WAT_OFFSET_MS);

export function inSendWindow(now: Date, s: WindowSettings): boolean {
  const l = toLagos(now);
  const day = l.getUTCDay();
  if (!s.sendOnWeekends && (day === 0 || day === 6)) return false;
  const h = l.getUTCHours() + l.getUTCMinutes() / 60;
  return h >= s.sendWindowStartHour && h < s.sendWindowEndHour;
}

/** The next moment sending is allowed (now, if inside the window). */
export function nextWindowStart(now: Date, s: WindowSettings): Date {
  if (inSendWindow(now, s)) return now;
  const l = toLagos(now);
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + i, s.sendWindowStartHour, 0, 0));
    const real = fromLagos(candidate);
    if (real.getTime() > now.getTime() && inSendWindow(real, s)) return real;
  }
  return new Date(now.getTime() + 24 * 3600_000);
}

/** Start of today in Lagos, as a real instant (for "sent today" counts). */
export function lagosDayStart(now: Date): Date {
  const l = toLagos(now);
  return fromLagos(new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate())));
}

/** Start of tomorrow's window, for when today's limit is used up. */
export function tomorrowWindowStart(now: Date, s: WindowSettings): Date {
  return nextWindowStart(new Date(lagosDayStart(now).getTime() + 24 * 3600_000), s);
}
