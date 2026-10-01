export const DEFAULT_LOOKBACK_MINUTES = 120;
export const FUTURE_TOLERANCE_MS = 5 * 60000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function formatUtc(value, { seconds = true, millis = false, zone = true } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (value === null || value === undefined || value === '' || isNaN(d.getTime())) return '';
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  let time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (seconds || millis) time += `:${pad(d.getUTCSeconds())}`;
  if (millis) time += `.${pad(d.getUTCMilliseconds(), 3)}`;
  return `${date} ${time}${zone ? 'Z' : ''}`;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const EPOCH_MILLIS = /^\d{12,14}$/;

export function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (EPOCH_MILLIS.test(text)) return Number(text);
  const match = text.match(TIMESTAMP);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  const offset = /^z$/i.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.replace(':', '').slice(3, 5) || '00'}`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendar.getUTCDate() === Number(day) && calendar.getUTCMonth() + 1 === Number(month) ? ms : null;
}

function toMsOrThrow(value, name) {
  const ms = parseTimestamp(value);
  if (ms === null) {
    throw new Error(`invalid \`${name}\`: ${JSON.stringify(value)}. Use an ISO 8601 timestamp, e.g. '2026-09-23T10:28:00Z' (a timestamp without a zone is read as UTC)`);
  }
  return ms;
}

const given = (v) => v !== undefined && v !== null && v !== '';

function lookbackMinutes(value, defaultLookback) {
  if (!given(value)) return defaultLookback;
  const minutes = typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`\`minutes_lookback\` must be a positive number of minutes, got ${JSON.stringify(value)}`);
  }
  return minutes;
}

function describeSpan(minutes) {
  if (minutes < 120) return `${Math.round(minutes * 10) / 10} min`;
  if (minutes < 2880) return `${Math.round(minutes / 6) / 10} h`;
  return `${Math.round(minutes / 144) / 10} d`;
}

export function resolveTime({ time_from, time_to, minutes_lookback } = {}, defaultLookback = DEFAULT_LOOKBACK_MINUTES, now = Date.now()) {
  const lookback = lookbackMinutes(minutes_lookback, defaultLookback);
  let fromMs;
  let toMs;
  let lookbackMin = null;
  if (given(time_from)) {
    fromMs = toMsOrThrow(time_from, 'time_from');
    toMs = given(time_to) ? toMsOrThrow(time_to, 'time_to') : now;
  } else {
    toMs = given(time_to) ? toMsOrThrow(time_to, 'time_to') : now;
    fromMs = toMs - Math.round(lookback * 60000);
    lookbackMin = lookback;
  }
  if (given(time_from) && fromMs > now) {
    throw new Error(`\`time_from\` (${formatUtc(fromMs)}) is in the future; it is now ${formatUtc(now)}. Timestamps without a zone are read as UTC`);
  }
  if (given(time_to) && toMs > now + FUTURE_TOLERANCE_MS) {
    throw new Error(`\`time_to\` (${formatUtc(toMs)}) is in the future; it is now ${formatUtc(now)}. Omit \`time_to\` for a window that ends now. Timestamps without a zone are read as UTC`);
  }
  if (fromMs >= toMs) {
    throw new Error(`\`time_from\` (${formatUtc(fromMs)}) must be earlier than \`time_to\` (${formatUtc(toMs)})`);
  }
  const relative = lookbackMin !== null && !given(time_to);
  const span = relative ? `last ${describeSpan(lookbackMin)}` : describeSpan((toMs - fromMs) / 60000);
  return {
    fromMs,
    toMs,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    lookbackMin,
    durationMs: toMs - fromMs,
    gtf: `c_${fromMs}_${toMs}`,
    timeframe: `custom${fromMs}to${toMs}`,
    from: String(fromMs),
    to: String(toMs),
    v2Query: { from: String(fromMs), to: String(toMs) },
    analysisQuery: { gtf: `c_${fromMs}_${toMs}`, timeframe: `custom${fromMs}to${toMs}` },
    describe: `${formatUtc(fromMs, { zone: false })} → ${formatUtc(toMs, { zone: false })} UTC (${span})`,
  };
}
