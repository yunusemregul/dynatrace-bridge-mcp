import { formatUtc, parseTimestamp } from './time.js';

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const MISSING = '-';
const MISSING_VALUE_BELOW = -1e100;
const measured = (v) => (isNumber(v) && v > MISSING_VALUE_BELOW ? v : null);

export const BRIDGE_NOTE = "This tool runs through the Dynatrace Bridge browser extension in the user's logged-in browser. If it fails, report the error to the user; do not try to open browser tabs or use browser automation instead.";

export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : (noun.endsWith('s') ? 'es' : 's')}`;
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function tag(value) {
  if (typeof value === 'string') return value;
  if (value?.stringRepresentation) return value.stringRepresentation;
  return value?.value ? `${value.key}:${value.value}` : String(value?.key ?? '');
}

export function refId(ref) {
  if (typeof ref === 'string') return ref;
  if (typeof ref?.entityId === 'string') return ref.entityId;
  return ref?.entityId?.id || ref?.id || null;
}

export function refLabel(ref) {
  const id = refId(ref);
  if (!id) return ref?.name || '';
  return ref?.name ? `${ref.name} (${id})` : id;
}

export function number(value, digits = 3) {
  if (!isNumber(value)) return MISSING;
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 10 ** digits) return String(Math.round(value));
  return String(Number(value.toPrecision(digits)));
}

export function count(value) {
  if (!isNumber(value)) return MISSING;
  const abs = Math.abs(value);
  if (abs < 10000) return Number.isInteger(value) ? String(value) : number(value);
  if (abs < 1e6) return `${number(value / 1e3)}k`;
  if (abs < 1e9) return `${number(value / 1e6)}M`;
  return `${number(value / 1e9)}B`;
}

export function duration(micros) {
  if (!isNumber(micros)) return MISSING;
  const abs = Math.abs(micros);
  if (abs === 0) return '0 ms';
  if (abs < 1000) return `${number(micros)} µs`;
  if (abs < 1e6) return `${number(micros / 1e3)} ms`;
  if (abs < 60e6) return `${number(micros / 1e6)} s`;
  if (abs < 3600e6) return `${number(micros / 60e6)} min`;
  return `${number(micros / 3600e6)} h`;
}

export function durationMs(millis) {
  return isNumber(millis) ? duration(millis * 1000) : MISSING;
}

export function bytes(value) {
  if (!isNumber(value)) return MISSING;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${number(scaled)} ${units[unit]}`;
}

export function percent(value, { ratio = false } = {}) {
  if (!isNumber(value)) return MISSING;
  return `${number(ratio ? value * 100 : value)} %`;
}

const BYTE_UNITS = { Byte: 1, KiloByte: 1e3, KibiByte: 1024, MegaByte: 1e6, MebiByte: 1024 ** 2, GigaByte: 1e9, GibiByte: 1024 ** 3 };
const MICROS_PER = { NanoSecond: 1e-3, MicroSecond: 1, MilliSecond: 1e3, Second: 1e6, Minute: 60e6, Hour: 3600e6 };
const RATE_SUFFIX = { PerSecond: '/s', PerMinute: '/min', PerHour: '/h' };

export function formatterForUnit(unit) {
  if (MICROS_PER[unit]) return (v) => duration(isNumber(v) ? v * MICROS_PER[unit] : v);
  if (BYTE_UNITS[unit]) return (v) => bytes(isNumber(v) ? v * BYTE_UNITS[unit] : v);
  if (unit === 'Percent') return (v) => percent(v);
  if (unit === 'Count') return (v) => count(v);
  if (RATE_SUFFIX[unit]) return (v) => (isNumber(v) ? `${count(v)}${RATE_SUFFIX[unit]}` : MISSING);
  const bytesRate = typeof unit === 'string' && unit.match(/^(\w*Byte)(PerSecond|PerMinute|PerHour)$/);
  if (bytesRate && BYTE_UNITS[bytesRate[1]]) return (v) => (isNumber(v) ? `${bytes(v * BYTE_UNITS[bytesRate[1]])}${RATE_SUFFIX[bytesRate[2]]}` : MISSING);
  if (unit === 'MilliCores') return (v) => (isNumber(v) ? `${number(v)} mCores` : MISSING);
  if (unit === 'Cores') return (v) => (isNumber(v) ? `${number(v)} cores` : MISSING);
  if (!unit || unit === 'Unspecified' || unit === 'NotApplicable') return (v) => number(v);
  return (v) => (isNumber(v) ? `${number(v)} ${unit}` : MISSING);
}

export function utc(value, options) {
  return formatUtc(value, options) || MISSING;
}

export function timestamp(value) {
  return parseTimestamp(value);
}

export function truncate(text, max = 200) {
  const value = text === null || text === undefined ? '' : String(text);
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function truncateStart(text, max = 40) {
  const value = text === null || text === undefined ? '' : String(text);
  return value.length > max ? `…${value.slice(-(max - 1)).trimStart()}` : value;
}

function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

export function table(headers, rows) {
  if (!rows || rows.length === 0) return '';
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${headers.map((_, i) => cell(row[i])).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function cap(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const max = isNumber(limit) && limit >= 1 ? Math.floor(limit) : list.length;
  const shown = list.slice(0, max);
  const omitted = list.length - shown.length;
  return { shown, omitted, note: omittedNote(omitted) };
}

export function omittedNote(omitted, hint = 'raise `limit` or narrow the filter to see them') {
  return omitted > 0 ? `_${count(omitted)} more omitted (${hint})_` : '';
}

export function stackTrace(trace, maxFrames = 8) {
  const frames = (Array.isArray(trace) ? trace.map(String) : String(trace ?? '').split(/\r?\n/))
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '');
  if (!isNumber(maxFrames) || frames.length <= maxFrames) return frames.join('\n');
  return [...frames.slice(0, maxFrames), `… ${frames.length - maxFrames} more frames`].join('\n');
}

const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-csrftoken|x-csrf-token|x-xsrf-token|x-api-key|x-dynatrace.*)$/i;
const MASK = '<masked>';
const JWT = String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`;
const OPAQUE_CREDENTIAL = String.raw`(?=[A-Za-z_~-]*[0-9+/=])[A-Za-z0-9+/_~-]{16,}={0,2}(?![A-Za-z0-9+/_~=-]|\.[A-Za-z0-9])`;
const DYNATRACE_TOKEN = String.raw`\bdt0[a-z]\d{2}\.[A-Za-z0-9]{8,}(?:\.[A-Za-z0-9]{8,})?`;
const REDACTIONS = [
  [new RegExp(DYNATRACE_TOKEN, 'g'), 'dt0***.<redacted>'],
  [/(\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?(?:basic|bearer|digest|negotiate|api-token)\s+)[^\s"',;]+/gi, '$1<redacted>'],
  [new RegExp(String.raw`\b(Bearer|Basic)\s+(?:${JWT}|${OPAQUE_CREDENTIAL})`, 'gi'), '$1 <redacted>'],
  [/\b(Api-Token)\s+[A-Za-z0-9+/=._~-]{16,}/gi, '$1 <redacted>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>'],
];
const SECRET_KEY = /passw|passphrase|secret|token|api[-_ ]?key|credential|private[-_ ]?key|authorization|^pwd$|^(j?session[-_ ]?id|sid|sig|signature|auth|otp|pin|cvv|cvc)$/i;
const WHOLE_SECRETS = [/-----BEGIN [A-Z ]+-----/, new RegExp(`^\\s*${JWT}`), new RegExp(DYNATRACE_TOKEN)];
const QUERY_PARAMETER = /(^|[?&;])([^=&;#?\s]{1,64})=([^&;#\s]+)/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID = /^[A-Z][A-Z0-9_]*-[0-9A-F]{16}$/;
const SECRET_NAME_FIELDS = ['name', 'key', 'header', 'headerName'];
const SECRET_VALUE_FIELDS = ['value', 'values', 'secretValue'];

export function isSensitiveHeader(name) {
  return SENSITIVE_HEADERS.test(String(name).trim());
}

export function isSecretName(name) {
  const text = String(name ?? '').trim();
  return SECRET_KEY.test(text) || SENSITIVE_HEADERS.test(text);
}

export function redact(text) {
  if (typeof text !== 'string') return text;
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function looksOpaque(value) {
  if (value.length < 40 || !/^[A-Za-z0-9+/=_-]+$/.test(value) || value.startsWith('/') || UUID.test(value) || ENTITY_ID.test(value)) return false;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) return true;
  return value.split(/[-_]/).some(run => run.length >= 24 && /\d/.test(run) && /[A-Za-z]/.test(run));
}

export function maskInline(value) {
  if (typeof value !== 'string') return value;
  const masked = value
    .replace(/(:\/\/[^/\s:@]+):[^/\s@]+@/g, `$1:${MASK}@`)
    .replace(QUERY_PARAMETER, (match, lead, key, text) => (SECRET_KEY.test(key) && text !== MASK ? `${lead}${key}=${MASK}` : match));
  return redact(masked);
}

function isCredentialPair(value) {
  const pair = value.trim().match(/^(?:Bearer|Basic|Api-Token|Digest)\s+(\S{8,})$/i);
  return !!pair && !/^[A-Z]?[a-z]+$/.test(pair[1]);
}

export function maskString(value) {
  if (typeof value !== 'string') return value;
  if (WHOLE_SECRETS.some(pattern => pattern.test(value)) || isCredentialPair(value) || looksOpaque(value)) return MASK;
  return maskInline(value);
}

export function maskSecrets(value, secret = false) {
  if (typeof value === 'string') return secret && value !== '' ? MASK : maskString(value);
  if (typeof value === 'number') return secret ? MASK : value;
  if (Array.isArray(value)) return value.map(item => maskSecrets(item, secret));
  if (value && typeof value === 'object') {
    const namesSecret = SECRET_NAME_FIELDS.some(field => typeof value[field] === 'string' && SECRET_KEY.test(value[field]));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      maskSecrets(item, secret || SECRET_KEY.test(key) || (namesSecret && SECRET_VALUE_FIELDS.includes(key))),
    ]));
  }
  return value;
}

export function maskNamed(name, value, { opaque = true } = {}) {
  if (value === null || value === undefined || value === '') return value;
  if (isSecretName(name)) return MASK;
  if (typeof value === 'string') return opaque ? maskString(value) : maskInline(value);
  return opaque ? maskSecrets(value) : value;
}

export function stripHeaders(headers) {
  if (Array.isArray(headers)) {
    return headers
      .filter(h => !isSensitiveHeader(Array.isArray(h) ? h[0] : (h?.name ?? h?.key ?? '')))
      .map(h => (Array.isArray(h) ? [h[0], maskNamed(h[0], h[1])] : { ...h, ...(typeof h?.value === 'string' ? { value: maskNamed(h?.name ?? h?.key ?? '', h.value) } : {}) }));
  }
  if (headers && typeof headers === 'object') {
    return Object.fromEntries(Object.entries(headers)
      .filter(([name]) => !isSensitiveHeader(name))
      .map(([name, value]) => [name, maskNamed(name, value)]));
  }
  return headers;
}

export const OUTPUT_BUDGET = 50000;
const FOOTER_SEARCH = 4000;
const CUT_NOTE_RESERVE = 400;

export function fitOutput(text, budget = OUTPUT_BUDGET) {
  if (typeof text !== 'string' || text.length <= budget) return text;
  const footerAt = ['\n\nNext: ', '\n\n[Open in Dynatrace]('].map(marker => text.lastIndexOf(marker)).find(at => at !== -1 && text.length - at <= FOOTER_SEARCH) ?? -1;
  const tail = footerAt === -1 ? '' : text.slice(footerAt);
  const room = Math.max(0, budget - tail.length - CUT_NOTE_RESERVE);
  const lineEnd = text.lastIndexOf('\n', room);
  const head = text.slice(0, lineEnd > room / 2 ? lineEnd : room).trimEnd();
  const dropped = text.slice(head.length, footerAt === -1 ? text.length : footerAt);
  const openFence = (head.match(/^```/gm) || []).length % 2 === 1;
  const note = `_Output cut to fit the ${count(budget)}-character output budget: ${count(dropped.length)} more characters (${count(dropped.split('\n').length - 1)} lines) are not shown. Lower \`limit\`, narrow the filters or shorten the time window to get the rest._`;
  return `${head}${openFence ? '\n```' : ''}\n\n${note}${tail}`;
}

export function assumedNote(assumptions) {
  const list = [...new Set((assumptions || []).filter(Boolean))];
  return list.length ? `_Assumed, not verified against a live Dynatrace: ${list.join('; ')}._` : null;
}

export function deepLink(env, route, { params = {}, time = null } = {}) {
  const base = env ? `${env.origin}${env.basePath}` : '';
  const clean = String(route).replace(/^\/+/, '');
  const all = Object.entries({ ...params, ...(time ? { gtf: time.gtf } : {}) })
    .filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (clean.startsWith('#')) {
    return `${base}/${clean}${all.map(([k, v]) => `;${k}=${encodeURIComponent(v)}`).join('')}`;
  }
  if (all.length === 0) return `${base}/${clean}`;
  const search = new URLSearchParams(all.map(([k, v]) => [k, String(v)])).toString();
  return `${base}/${clean}${clean.includes('?') ? '&' : '?'}${search}`;
}

export function header(title, { environment = null, time = null, details = [] } = {}) {
  const parts = [
    ...details.filter(Boolean),
    environment ? `env \`${environment}\`` : null,
    time ? time.describe : null,
  ].filter(Boolean);
  return parts.length ? `# ${title} (${parts.join(', ')})` : `# ${title}`;
}

export function footer({ next = null, link = null } = {}) {
  const lines = [];
  if (next) lines.push(`Next: ${next}`);
  if (link) lines.push(`[Open in Dynatrace](${link})`);
  return lines.join('\n\n');
}

export function sections(...blocks) {
  return blocks.flat().filter(block => block !== null && block !== undefined && block !== '' && block !== false).join('\n\n');
}

function points(timestamps, values) {
  const out = [];
  const length = Math.min(timestamps?.length || 0, values?.length || 0);
  for (let i = 0; i < length; i++) {
    if (isNumber(values[i]) && isNumber(timestamps[i])) out.push({ t: timestamps[i], v: values[i] });
  }
  return out.sort((a, b) => a.t - b.t);
}

const mean = (list) => list.reduce((sum, p) => sum + p.v, 0) / list.length;

function trendOf(list) {
  if (list.length < 4) return { direction: 'n/a', changePercent: null };
  const third = Math.max(1, Math.floor(list.length / 3));
  const first = mean(list.slice(0, third));
  const last = mean(list.slice(-third));
  if (first === 0 && last === 0) return { direction: 'flat', changePercent: 0 };
  if (first === 0) return { direction: last > 0 ? 'rising' : 'falling', changePercent: null };
  const changePercent = ((last - first) / Math.abs(first)) * 100;
  const direction = Math.abs(changePercent) < 10 ? 'flat' : (changePercent > 0 ? 'rising' : 'falling');
  return { direction, changePercent };
}

export function seriesStats(timestamps, values, { peaks = 3 } = {}) {
  const list = points(timestamps, values);
  if (list.length === 0) return null;
  let min = list[0];
  let max = list[0];
  for (const p of list) {
    if (p.v < min.v) min = p;
    if (p.v > max.v) max = p;
  }
  const sum = list.reduce((total, p) => total + p.v, 0);
  const last = list[list.length - 1];
  return {
    points: list.length,
    min: min.v,
    minAt: min.t,
    max: max.v,
    maxAt: max.t,
    avg: sum / list.length,
    sum,
    last: last.v,
    lastAt: last.t,
    firstAt: list[0].t,
    trend: trendOf(list),
    peaks: [...list].sort((a, b) => b.v - a.v || a.t - b.t).slice(0, peaks),
  };
}

export function downsample(timestamps, values, buckets = 24, range = null) {
  const list = points(timestamps, values);
  if (list.length === 0) return [];
  if (!range && list.length <= buckets) {
    return list.map(p => ({ from: p.t, to: p.t, points: 1, min: p.v, max: p.v, avg: p.v }));
  }
  const from = range?.fromMs ?? list[0].t;
  const to = range?.toMs ?? list[list.length - 1].t;
  const size = Math.max(1, buckets);
  const width = Math.max(1, (to - from) / size);
  const out = Array.from({ length: size }, (_, i) => ({ from: Math.round(from + i * width), to: Math.round(from + (i + 1) * width), points: 0, sum: 0, min: null, max: null }));
  for (const p of list) {
    const index = Math.min(size - 1, Math.max(0, Math.floor((p.t - from) / width)));
    const bucket = out[index];
    bucket.points++;
    bucket.sum += p.v;
    bucket.min = bucket.min === null ? p.v : Math.min(bucket.min, p.v);
    bucket.max = bucket.max === null ? p.v : Math.max(bucket.max, p.v);
  }
  return out.map(({ sum, ...bucket }) => ({ ...bucket, avg: bucket.points ? sum / bucket.points : null }));
}

export function describeTrend(trend) {
  if (!trend || trend.direction === 'n/a') return 'n/a';
  if (trend.changePercent === null) return trend.direction;
  const sign = trend.changePercent > 0 ? '+' : '';
  return `${trend.direction} (${sign}${number(trend.changePercent)} %)`;
}

export function bucketLabel(ms, spanMs) {
  return spanMs > 36 * 3600e3 ? formatUtc(ms, { seconds: false, zone: false }).slice(5) : formatUtc(ms, { seconds: false, zone: false }).slice(11);
}

export function seriesSummary(timestamps, values, { format = number, buckets = 24, label = null } = {}) {
  const stats = seriesStats(timestamps, values);
  if (!stats) return label ? `**${label}**: no data points` : 'no data points';
  const lines = [];
  const lead = label ? `**${label}**: ` : '';
  lines.push(`${lead}min ${format(stats.min)} · avg ${format(stats.avg)} · max ${format(stats.max)} at ${utc(stats.maxAt)} · last ${format(stats.last)} · trend ${describeTrend(stats.trend)} · ${stats.points} points`);
  if (stats.peaks.length > 1) lines.push(`Peaks: ${stats.peaks.map(p => `${format(p.v)} at ${utc(p.t)}`).join('; ')}`);
  const rows = downsample(timestamps, values, buckets);
  if (rows.length > 1) {
    const span = rows[rows.length - 1].to - rows[0].from;
    lines.push('');
    lines.push(table(['time (UTC)', 'avg', 'max'], rows.filter(b => b.points).map(b => [bucketLabel(b.from, span), format(b.avg), format(b.max)])));
  }
  return lines.join('\n');
}

export function seriesLabel(dimensionMap, dimensions, { ids = true } = {}) {
  const map = dimensionMap && typeof dimensionMap === 'object' ? dimensionMap : {};
  const keys = Object.keys(map).filter(k => !k.endsWith('.name') || map[k.slice(0, -5)] === undefined);
  const parts = keys.map((key) => {
    const name = map[`${key}.name`];
    if (key.endsWith('.name')) return String(map[key]);
    if (name === undefined || name === map[key]) return String(map[key]);
    return ids ? `${name} (${map[key]})` : String(name);
  });
  if (parts.length) return parts.join(', ');
  if (Array.isArray(dimensions) && dimensions.length) return dimensions.join(', ');
  return '(total)';
}

export function metricSeries(queryResult) {
  const result = Array.isArray(queryResult?.result) ? queryResult.result : [];
  return result.map(metric => ({
    metricId: metric.metricId,
    warnings: Array.isArray(metric.warnings) ? metric.warnings : [],
    series: (Array.isArray(metric.data) ? metric.data : []).map(entry => ({
      label: seriesLabel(entry.dimensionMap, entry.dimensions),
      shortLabel: seriesLabel(entry.dimensionMap, entry.dimensions, { ids: false }),
      dimensionMap: entry.dimensionMap || {},
      timestamps: entry.timestamps || [],
      values: (entry.values || []).map(value => (isNumber(value) ? measured(value) : value)),
    })),
  }));
}

export function pointSeries(points) {
  const list = Array.isArray(points) ? points : (Array.isArray(points?.dataPoints) ? points.dataPoints : []);
  return { timestamps: list.map(p => p?.timestamp), values: list.map(p => measured(p?.value)) };
}

export const metricSelector = {
  key: (selector) => String(selector).trim().match(/^[a-z]+:[A-Za-z0-9_.-]+/)?.[0] ?? String(selector),
  splitBy: (...dimensions) => `:splitBy(${dimensions.map(d => `"${d}"`).join(',')})`,
  eq: (dimension, value) => `:filter(eq("${dimension}","${value}"))`,
  in: (dimension, entitySelector) => `:filter(in("${dimension}",entitySelector("${String(entitySelector).replace(/~/g, '~~').replace(/"/g, '~"')}")))`,
};

export function valueByDimension(series, dimension) {
  const values = new Map();
  for (const entry of series || []) {
    const id = entry.dimensionMap?.[dimension];
    const value = (entry.values || []).find(isNumber);
    if (id !== undefined && value !== undefined) values.set(id, value);
  }
  return values;
}

export function statsLine(label, stats, format = number) {
  if (!stats) return `- ${label}: no data points`;
  return `- ${label}: min ${format(stats.min)} · avg ${format(stats.avg)} · max ${format(stats.max)} at ${utc(stats.maxAt)} · last ${format(stats.last)} · trend ${describeTrend(stats.trend)}`;
}

export function seriesReport(series, { format = number, buckets = 24, maxSeries = 10, columns = 5, overTime = true } = {}) {
  const ranked = (series || [])
    .map(s => ({ ...s, stats: seriesStats(s.timestamps, s.values) }))
    .sort((a, b) => (b.stats?.avg ?? -Infinity) - (a.stats?.avg ?? -Infinity));
  const withData = ranked.filter(s => s.stats);
  if (withData.length === 0) return 'No data points in this window.';
  const { shown, omitted } = cap(withData, maxSeries);
  const blocks = [];
  blocks.push(table(
    ['series', 'min', 'avg', 'max', 'max at (UTC)', 'last', 'trend', 'points'],
    shown.map(s => [s.label, format(s.stats.min), format(s.stats.avg), format(s.stats.max), utc(s.stats.maxAt), format(s.stats.last), describeTrend(s.stats.trend), s.stats.points]),
  ));
  const notes = [];
  if (omitted) notes.push(omittedNote(omitted, 'series ranked by average; raise `max_series` to see them'));
  const empty = ranked.length - withData.length;
  if (empty) notes.push(`_${empty} series had no data points_`);
  if (notes.length) blocks.push(notes.join('\n'));

  if (!overTime) return blocks.join('\n\n');
  const detailed = shown.slice(0, columns);
  const instants = [...new Set(detailed.flatMap(s => s.timestamps.filter((t, i) => isNumber(t) && isNumber(s.values[i]))))].sort((a, b) => a - b);
  if (instants.length > 1) {
    const span = instants[instants.length - 1] - instants[0];
    const exact = instants.length <= buckets;
    let rows;
    if (exact) {
      const lookups = detailed.map(s => new Map(s.timestamps.map((t, i) => [t, s.values[i]])));
      rows = instants.map(t => [bucketLabel(t, span), ...lookups.map(lookup => (isNumber(lookup.get(t)) ? format(lookup.get(t)) : ''))]);
    } else {
      const range = { fromMs: instants[0], toMs: instants[instants.length - 1] };
      const grids = detailed.map(s => downsample(s.timestamps, s.values, buckets, range));
      rows = grids[0].map((bucket, i) => [bucketLabel(bucket.from, span), ...grids.map(grid => (grid[i].points ? format(grid[i].avg) : ''))]);
    }
    const single = detailed.length === 1;
    const scope = shown.length > detailed.length ? `, top ${detailed.length} series` : '';
    const title = exact ? `Over time (every data point${scope}):` : `Over time (averages of ${buckets} buckets, labelled by bucket start${scope}):`;
    blocks.push(`${title}\n\n${table(['time (UTC)', ...detailed.map(s => (single ? 'value' : truncate(s.shortLabel || s.label, 40)))], rows)}`);
  }
  return blocks.join('\n\n');
}

export function apiChanged(endpoint, problem) {
  const error = new Error(`Dynatrace's internal API changed: the response of ${endpoint} ${problem}. This tool needs an update for this Dynatrace version.`);
  error.code = 'API_CHANGED';
  return error;
}

function valueAt(data, path) {
  return path.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), data);
}

function missingPath(data, path) {
  const item = path.indexOf('[].');
  if (item !== -1) {
    const listPath = path.slice(0, item);
    const list = valueAt(data, listPath);
    if (!Array.isArray(list)) return { path: listPath, array: true };
    if (list.length === 0) return null;
    const inner = missingPath(list[0], path.slice(item + 3));
    return inner ? { ...inner, path: `${listPath}[].${inner.path}` } : null;
  }
  const wantsArray = path.endsWith('[]');
  const plain = wantsArray ? path.slice(0, -2) : path;
  const value = valueAt(data, plain);
  const ok = wantsArray ? Array.isArray(value) : value !== undefined && value !== null;
  return ok ? null : { path: plain, array: wantsArray };
}

export function expectShape(data, paths, endpoint) {
  for (const path of paths) {
    const missing = missingPath(data, path);
    if (missing) throw apiChanged(endpoint, `has no ${missing.array ? 'array ' : ''}\`${missing.path}\``);
  }
  return data;
}

export function analysisWarnings(metadata, debug = null) {
  const warnings = [];
  if (metadata?.onlyPartialTimeframeCovered) warnings.push('only part of the requested time window is covered by stored traces');
  if (metadata?.partialResult) warnings.push('Dynatrace returned a partial result');
  if (typeof metadata?.state === 'string' && metadata.state.toUpperCase() !== 'OK') warnings.push(`analysis state is ${metadata.state}`);
  if (isNumber(metadata?.usedServices) && isNumber(metadata?.totalServices) && metadata.usedServices < metadata.totalServices) {
    warnings.push(`only ${metadata.usedServices} of ${metadata.totalServices} services were analysed`);
  }
  const rates = [debug?.indexFileSampleRate, metadata?.sampleRate].flat().filter(isNumber).filter(rate => rate !== 1 && rate !== 0);
  if (rates.length) warnings.push(`traces are sampled (sample rate ${[...new Set(rates)].join(', ')}), so not every request is present`);
  if (isNumber(debug?.successfulClusterNodes) && isNumber(debug?.totalClusterNodes) && debug.successfulClusterNodes < debug.totalClusterNodes) {
    warnings.push(`only ${debug.successfulClusterNodes} of ${debug.totalClusterNodes} cluster nodes answered`);
  }
  if (debug?.hasWarnings === true) warnings.push('the cluster reported analysis warnings');
  return warnings;
}

export function warningLine(warnings) {
  const list = (warnings || []).filter(Boolean);
  return list.length ? `**Warning:** ${list.join('; ')}.` : null;
}

export function tree(roots, { childrenOf, line, maxDepth = Infinity, limit = Infinity }) {
  const lines = [];
  let beyondLimit = 0;
  let beyondDepth = 0;
  const size = (node) => 1 + childrenOf(node).reduce((total, child) => total + size(child), 0);
  const visit = (node, depth) => {
    if (lines.length >= limit) {
      beyondLimit += size(node);
      return;
    }
    const indent = '  '.repeat(depth);
    const [first, ...rest] = [].concat(line(node, depth));
    lines.push(`${indent}- ${first}`, ...rest.map(extra => `${indent}  ${extra}`));
    const children = childrenOf(node);
    if (depth >= maxDepth) {
      beyondDepth += children.reduce((total, child) => total + size(child), 0);
      return;
    }
    children.forEach(child => visit(child, depth + 1));
  };
  (Array.isArray(roots) ? roots : [roots]).forEach(root => visit(root, 0));
  const notes = [
    beyondDepth ? `_${plural(beyondDepth, 'deeper node')} not shown (raise \`max_depth\`)_` : null,
    omittedNote(beyondLimit, 'raise `limit` to see them'),
  ].filter(Boolean).join('\n');
  return { text: lines.join('\n'), lines, beyondLimit, beyondDepth, notes };
}

export function eventProperties(event) {
  const properties = event?.properties;
  if (Array.isArray(properties)) return Object.fromEntries(properties.filter(p => p && typeof p.key === 'string').map(p => [p.key, p.value]));
  return properties && typeof properties === 'object' ? properties : {};
}

export function groupEvents(events, keyOf, timesOf = (event) => ({ first: event.startTime, last: event.startTime })) {
  const groups = new Map();
  for (const event of events || []) {
    const key = JSON.stringify(keyOf(event));
    if (!groups.has(key)) groups.set(key, { members: [], count: 0, open: 0, first: null, last: null, latest: event, entities: new Map() });
    const group = groups.get(key);
    group.members.push(event);
    group.count++;
    if (event.status === 'OPEN') group.open++;
    const { first, last } = timesOf(event);
    if (isNumber(first) && (group.first === null || first < group.first)) group.first = first;
    if (isNumber(last) && (group.last === null || last >= group.last)) {
      group.last = last;
      group.latest = event;
    }
    const id = refId(event.entityId);
    if (id) group.entities.set(id, event.entityId?.name || id);
  }
  return [...groups.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
}
