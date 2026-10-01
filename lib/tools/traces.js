import { BRIDGE_NOTE, analysisWarnings, apiChanged, maskInline, maskNamed, warningLine } from '../format.js';
import { defineTools } from '../context.js';

export const order = 30;

const TRACE_LIST_ENDPOINT = 'GET /rest/purepaths/list';
const MDA_DEFINITIONS_ENDPOINT = 'GET /rest/mda2/uiDefs';
const TRACE_ENDPOINT = 'GET /rest/serviceanalysis/trace';
const CALL_DETAILS_ENDPOINT = 'GET /rest/serviceanalysis/servicecalldetails';

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => isNumber(v) && v > 0;
const given = (v) => v !== undefined && v !== null && v !== '';
const sum = (list, pick) => list.reduce((total, item) => total + (isNumber(pick(item)) ? pick(item) : 0), 0);

function resolveService(args, ctx, time) {
  return given(args.service) ? ctx.entities.service(args.service, { time }) : null;
}

function sortedBy(rows, pick, descending = true) {
  const rank = (row) => {
    const value = pick(row);
    return isNumber(value) ? value : -Infinity;
  };
  return [...rows].sort((a, b) => (descending ? rank(b) - rank(a) : rank(a) - rank(b)));
}

const CONTRIBUTOR_SORTS = {
  total_time: row => row.total,
  calls: row => row.calls,
  avg: row => row.avg,
  median: row => row.median,
  p90: row => row.p90,
  max: row => row.max,
  failure_rate: row => row.failureRate,
};

function contributorKind(rows) {
  if (rows.length && rows.every(row => String(row.id).startsWith('SERVICE_METHOD_GROUP-'))) return 'group';
  if (rows.some(row => row.databaseStatement)) return 'statement';
  return 'request';
}

const CONTRIBUTOR_KINDS = {
  request: {
    label: 'request',
    explain: null,
    next: 'call `list_traces`, `trace_statistics` or `analyze_response_time` with the same `service` and `request` set to an id (or name) from the table.',
  },
  statement: {
    label: 'SQL statement',
    explain: 'Rows are the SQL statements of this database service.',
    next: 'call `statement_callers` or `slow_statement_executions` with the same `service` and `statement` set to an id from the table, or `list_traces` with `request` set to it.',
  },
  group: {
    label: 'request group',
    explain: 'Rows are request groups (`SERVICE_METHOD_GROUP-…`). For a "Requests to unmonitored hosts" service each row is one target host.',
    next: 'call `list_traces` or `trace_statistics` with the same `service` and `request` set to a name from the table (or `request_group_id` and `request_group_name` set to an id and the name next to it).',
  },
};

const listServiceRequests = {
  name: 'list_service_requests',
  description: [
    'Lists what one service does, with metrics per row: call count, average / median / p90 / max response time, total time, failure rate and HTTP 4xx / 5xx counts.',
    'For a web or method service the rows are its requests (endpoints, jobs); for a database service they are its SQL statements; for a "Requests to unmonitored hosts" service they are the target hosts.',
    '',
    'Use it to see which endpoint of a service is slow (`sort: "avg"` or `"p90"`), costs the most time (`"total_time"`, the default), is called most (`"calls"`) or fails (`"failure_rate"`). For the same question across all services use `trace_statistics`; for cron jobs `cron_job_statistics`.',
    'Every row prints its id and name; the other tools take either one as `request`. The shared filter arguments narrow the requests that are counted, e.g. `response_time_min_ms: 2000` or `failed: true`.',
    '`service` is an id or a name; find services with `list_services`.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: ctx.schema.entity('The service', 'SERVICE-1234567890ABCDEF'),
      sort: { type: 'string', enum: [...Object.keys(CONTRIBUTOR_SORTS), 'name'], description: 'Ranking of the rows, highest first (name: A to Z). Default total_time.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(25, 'rows', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const sort = given(args.sort) ? String(args.sort).trim().toLowerCase() : 'total_time';
    if (sort !== 'name' && !CONTRIBUTOR_SORTS[sort]) throw new Error(`invalid \`sort\` ${JSON.stringify(args.sort)}. Use one of: ${[...Object.keys(CONTRIBUTOR_SORTS), 'name'].join(', ')}`);
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const { data, rows: all, warnings, skipped } = await ctx.serviceRequests(service, { filter, time });

    const kind = CONTRIBUTOR_KINDS[contributorKind(all)];
    const ranked = sort === 'name' ? [...all].sort((a, b) => String(a.name).localeCompare(String(b.name))) : sortedBy(all, CONTRIBUTOR_SORTS[sort]);
    const { shown, omitted } = format.cap(ranked, ctx.limit(args.limit, 25, 200));
    const withHttp = all.some(row => isNumber(row.http4xx) || isNumber(row.http5xx));
    const headers = ['id', kind.label, 'calls', 'avg', 'median', 'p90', 'max', 'total time', 'failed', ...(withHttp ? ['4xx', '5xx'] : [])];
    const rows = shown.map(row => [
      row.id,
      `${format.truncate(row.name, 160)}${row.unreliable ? ' (unreliable metrics)' : ''}`,
      format.count(row.calls),
      format.duration(row.avg),
      format.duration(row.median),
      format.duration(row.p90),
      format.duration(row.max),
      format.duration(row.total),
      format.percent(row.failureRate),
      ...(withHttp ? [format.count(row.http4xx), format.count(row.http5xx)] : []),
    ]);
    const described = ctx.servicefilter.describe(filter);
    const empty = `_No requests of this service matched in this window._ ${described ? 'Loosen the filter or widen' : 'Widen'} the time window.`;
    return format.sections(
      ctx.header(`Requests of ${data.displayName || service.displayName}`, {
        time,
        details: [service.entityId, data.serviceType, described, `${shown.length} of ${all.length}, by ${sort.replace('_', ' ')}`],
      }),
      warningLine(warnings),
      rows.length ? kind.explain : null,
      format.table(headers, rows) || empty,
      format.omittedNote(omitted),
      rows.length ? format.assumedNote(['the `failed` column is Dynatrace\'s failure rate read as a percentage (0–100)']) : null,
      skipped && rows.length ? `_Dynatrace itself left out ${format.count(skipped)} further rows before this table was sorted (which rows it keeps is not verified), so a row outside its list can rank higher by ${sort.replace('_', ' ')}. Narrow with \`request\` or the filters for a complete ranking._` : null,
      format.footer({
        next: rows.length ? kind.next : null,
        link: ctx.link('#smgd', { params: { sci: service.entityId }, time }),
      }),
    );
  },
};

const TRACE_SORTS = {
  slowest: { pick: trace => trace.timingData?.responseTime, label: 'slowest first' },
  newest: { pick: trace => trace.infoData?.callStartTime, label: 'newest first' },
  oldest: { pick: trace => trace.infoData?.callStartTime, label: 'oldest first', ascending: true },
  cpu: { pick: trace => trace.timingData?.cpuTime, label: 'most CPU time first' },
  wait: { pick: trace => trace.timingData?.waitTime, label: 'longest wait time first' },
  db_calls: { pick: trace => trace.childCallsData?.callsToDatabases, label: 'most database calls first' },
  db_time: { pick: trace => trace.childCallsData?.timeSpentInCallsToDatabases, label: 'most database time first' },
  service_calls: { pick: trace => trace.childCallsData?.callsToServices, label: 'most downstream service calls first' },
};

function describeFailure(errorData) {
  const sides = [['server', errorData?.serverSide], ['client', errorData?.clientSide]]
    .filter(([, side]) => side && typeof side === 'object')
    .map(([name, side]) => [name, [side.type, isNumber(side.httpCode) ? side.httpCode : null].filter(given).join(' ')])
    .filter(([, text]) => text);
  if (sides.length === 2 && sides[0][1] === sides[1][1]) return sides[0][1];
  return sides.map(([name, text]) => `${name} side ${text}`).join(', ');
}

function plainText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function describeAttributes(attributesData, format) {
  const list = Array.isArray(attributesData?.requestAttributesList) ? attributesData.requestAttributesList : [];
  return list.map(attribute => `${attribute.name}=${attribute.confidential ? '<confidential>' : format.truncate(plainText(maskNamed(attribute.name, attribute.value)), 80)}`).join(', ');
}

function traceBlock(trace, index, ctx, showService) {
  const { format } = ctx;
  const info = trace.infoData;
  const timing = trace.timingData;
  const request = trace.requestData || {};
  const calls = trace.childCallsData || {};
  const name = String(info.dimension ?? '').split('@_@')[0] || '(unnamed request)';
  const url = maskInline([request.hostName, request.relativeUrl].filter(given).join(''));
  const code = request.httpCodeValid !== false && positive(request.httpCode) ? `HTTP ${request.httpCode}` : null;
  const http = [[request.httpRequestMethod, format.truncate(url, 200)].filter(given).join(' '), code].filter(given).join(' → ');
  const times = [
    `cpu ${format.duration(timing.cpuTime)}`,
    `wait ${format.duration(timing.waitTime)}`,
    `suspension ${format.duration(timing.suspensionTime)}`,
    positive(timing.syncTime) ? `lock ${format.duration(timing.syncTime)}` : null,
    positive(timing.diskIOTime) ? `disk I/O ${format.duration(timing.diskIOTime)}` : null,
    positive(timing.networkIOTime) ? `network I/O ${format.duration(timing.networkIOTime)}` : null,
  ].filter(Boolean).join(', ');
  const exceptions = Object.entries(trace.errorData?.exceptions || {}).map(([clazz, count]) => `${clazz} ×${count}`).join(', ');
  const failure = describeFailure(trace.errorData);
  const attributes = describeAttributes(trace.requestAttributesData, format);
  const lines = [
    `${index}. ${format.utc(info.callStartTime, { millis: true })} **${format.truncate(format.oneLine(name), 160)}** — ${format.duration(timing.responseTime)}${info.failed ? ' **FAILED**' : ''}`,
    http ? `   ${http}` : null,
    showService && given(info.serviceId) ? `   service: ${info.serviceName || ''} (${info.serviceId})` : null,
    `   ${times} · DB: ${format.count(calls.callsToDatabases)} calls, ${format.duration(calls.timeSpentInCallsToDatabases)} · services: ${format.count(calls.callsToServices)} calls, ${format.duration(calls.timeSpentInCallsToServices)}`,
    failure ? `   failure: ${failure}` : null,
    exceptions ? `   exceptions: ${exceptions}` : null,
    attributes ? `   request attributes: ${attributes}` : null,
    `   traceId \`${info.traceIdHex}\` callURI \`${info.callURI}\``,
  ];
  return lines.filter(Boolean).join('\n');
}

const listTraces = {
  name: 'list_traces',
  description: [
    'Lists individual traces (PurePaths): the requests of one service, or of the whole environment when `service` is omitted. Use it to find concrete slow or failed requests, then open one with `get_trace`.',
    '',
    'Filters: response time range, HTTP code or class, failed state, HTTP method, one request (`request`: name or id, with `service`), a request group, URL text (`url_contains`, web requests only, works without `service`), request kind, plus `raw_filters`.',
    'Per trace: start time, request name, method + URL, HTTP code, failed flag, response / CPU / wait / suspension time, database call count and time, downstream service calls, exception classes, request attributes (secret-looking ones masked), and the `traceId` + `callURI` that `get_trace` needs.',
    '',
    'Dynatrace returns the newest matching traces (`fetch_limit` of them, 100 by default, at most 3000); this tool then sorts those and prints `limit` of them (25 by default, at most 100). So "slowest" means the slowest among the fetched newest traces: when the output says Dynatrace returned its limit, narrow the window or the filters (e.g. `response_time_min_ms`) or raise `fetch_limit`. Default order: slowest first when a response time filter is given, newest first otherwise. A warning line appears when the window is only partly covered or traces are sampled.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: { ...ctx.schema.entity('The service whose traces to list', 'SERVICE-1234567890ABCDEF'), description: `${ctx.schema.entity('The service whose traces to list', 'SERVICE-1234567890ABCDEF').description} Omit for the whole environment.` },
      ...ctx.schema.serviceFilter(),
      sort: { type: 'string', enum: Object.keys(TRACE_SORTS), description: 'Order of the output. Default: slowest when a response time filter is given, newest otherwise.' },
      limit: ctx.schema.limit(25, 'traces', 100),
      fetch_limit: { type: 'number', description: 'How many of the newest matching traces Dynatrace returns before this tool sorts them (its purepathsLimit, at most 3000). Default: 100, or `limit` when that is larger. Raise it to rank a busy window more completely; it does not change how many are printed.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const sortName = given(args.sort) ? String(args.sort).trim().toLowerCase() : null;
    if (sortName && !TRACE_SORTS[sortName]) throw new Error(`invalid \`sort\` ${JSON.stringify(args.sort)}. Use one of: ${Object.keys(TRACE_SORTS).join(', ')}`);
    const limit = ctx.limit(args.limit, 25, 100);
    const fetchLimit = Math.max(limit, ctx.limit(args.fetch_limit, 100, 3000, 'fetch_limit'));
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const hasResponseTimeFilter = given(filter.responseTimeMinMs) || given(filter.responseTimeMaxMs);
    const sort = TRACE_SORTS[sortName || (hasResponseTimeFilter ? 'slowest' : 'newest')];
    const servicefilter = ctx.servicefilter.encode(filter);
    const data = await ctx.get('/rest/purepaths/list', {
      serviceId: service?.entityId,
      servicefilter,
      purepathsLimit: fetchLimit,
      purepathsDataSource: 'ALL',
      partialResult: false,
      ...time.analysisQuery,
    }, { label: service ? `Traces of ${service.displayName}` : 'Traces of the environment' });
    ctx.expectShape(data, [
      'analysisResult.purePathsList[]',
      'analysisResult.purePathsList[].infoData.callURI',
      'analysisResult.purePathsList[].infoData.traceIdHex',
      'analysisResult.purePathsList[].infoData.callStartTime',
      'analysisResult.purePathsList[].timingData.responseTime',
    ], TRACE_LIST_ENDPOINT);
    const traces = data.analysisResult.purePathsList;

    const { shown, omitted } = format.cap(sortedBy(traces, sort.pick, !sort.ascending), limit);
    const blocks = shown.map((trace, i) => traceBlock(trace, i + 1, ctx, !service));
    const full = traces.length >= fetchLimit;
    const raise = fetchLimit < 3000 ? ', or raise `fetch_limit` (at most 3000)' : '';
    const fullNote = sort === TRACE_SORTS.newest
      ? `. Dynatrace returned its limit of the ${fetchLimit} newest matching traces, so older ones exist: narrow the window or the filter${raise}`
      : `. Dynatrace returned its limit of the ${fetchLimit} newest matching traces and older ones exist, so this order (${sort.label}) covers only those ${fetchLimit}, not the whole window: narrow the window or the filter${raise}`;
    const scope = traces.length ? `${shown.length} of ${traces.length} fetched, ${sort.label}${full ? fullNote : ''}.` : null;
    const described = ctx.servicefilter.describe(filter);
    const empty = `_No traces matched in this window._ ${described ? 'Loosen the filter, ' : 'Check the service, '}widen the time window, or call \`list_service_requests\` to see what the service received.`;
    const route = service ? `ui/services/${service.entityId}/purepaths` : 'ui/diagnostictools/purepaths';
    return format.sections(
      ctx.header(service ? `Traces of ${service.displayName}` : 'Traces of the environment', {
        time,
        details: [service?.entityId, described],
      }),
      warningLine(analysisWarnings(data.serviceAnalysisResultMetadata, data.serviceAnalysisResultDebugInfo)),
      scope,
      blocks.length ? blocks.join('\n\n') : empty,
      format.omittedNote(omitted, 'raise `limit` (at most 100) or narrow the filter to see them'),
      format.footer({
        next: blocks.length ? 'call `get_trace` with `trace_id` and `call_uri` of a trace (same time window) for its span tree, or `trace_statistics` with the same filters for aggregates.' : null,
        link: ctx.link(route, { params: { servicefilter }, time }),
      }),
    );
  },
};

const AGGREGATIONS = {
  AVERAGE: 'AVERAGE',
  MEDIAN: 'MEDIAN',
  P90: 'P90',
  P95: 'P95',
  MAX: 'MAX',
  MIN: 'MIN',
  SUM: 'SUM',
  COUNT: 'COUNT',
  COUNT_PER_MINUTE: 'COUNT_PER_MINUTE',
  LOAD: 'LOAD',
  PERCENTILE: 'CUSTOM_PERCENTILE',
};
const AGGREGATION_ALIASES = { AVG: 'AVERAGE', P50: 'MEDIAN', REQUESTS: 'LOAD', CUSTOM_PERCENTILE: 'PERCENTILE' };
const VALUE_COLUMNS = ['LOAD', 'AVERAGE', 'MEDIAN', 'P90', 'P95', 'CUSTOM_PERCENTILE', 'MAX', 'MIN', 'SUM'];
const COUNT_COLUMNS = ['COUNT', 'COUNT_PER_MINUTE', 'LOAD', 'AVERAGE', 'MIN', 'MAX'];
const VALUE_LABELS = { AVERAGE: 'avg', MEDIAN: 'median', P90: 'p90', P95: 'p95', MAX: 'max', MIN: 'min', SUM: 'sum' };
const TIME_UNITS = ['NanoSecond', 'MicroSecond', 'MilliSecond', 'Second'];
const DEFAULT_PERCENTILE = 80;
const MDA_VIEWS = ['topweb', 'topdb', 'exceptions', 'atm', 'topsql'];
const REQUEST_DIMENSION = '{Request:Name}';
const COUNT_METRIC_LEGEND = 'This is a count metric, so its aggregates are printed under Dynatrace\'s own names. `COUNT` is the total Dynatrace ranks by (its top-100 cut uses it). In one live check of FAILED_REQUEST_COUNT, `LOAD` was the number of failed requests; how `COUNT` and `LOAD` differ, and what `AVERAGE`, `MIN` and `MAX` aggregate over, is not verified.';
const LOAD_LEGEND = '`LOAD` is Dynatrace\'s own aggregate name. For time metrics it is the number of requests; for this metric that reading is not verified.';

function normalizeDimension(value) {
  const text = given(value) ? String(value).trim() : REQUEST_DIMENSION;
  return text.includes('{') ? text : `{${text}}`;
}

function normalizeAggregation(args) {
  if (!given(args.aggregation)) return { name: given(args.percentile) ? 'PERCENTILE' : null, percentile: args.percentile };
  const text = String(args.aggregation).trim().toUpperCase();
  const name = AGGREGATION_ALIASES[text] || text;
  if (AGGREGATIONS[name]) return { name, percentile: args.percentile };
  const percentile = text.match(/^P(\d{1,2}(?:\.\d+)?)$/);
  if (percentile) return { name: 'PERCENTILE', percentile: Number(percentile[1]) };
  throw new Error(`invalid \`aggregation\` ${JSON.stringify(args.aggregation)}. Use one of: ${Object.keys(AGGREGATIONS).join(', ')}`);
}

function totalsModel(rows, unit, percentile, format) {
  const has = (key) => rows.some(row => isNumber(row.totals[key]));
  const countMetric = has('COUNT');
  const timeMetric = !countMetric && TIME_UNITS.includes(unit);
  const known = (countMetric ? COUNT_COLUMNS : VALUE_COLUMNS).filter(has);
  const other = [...new Set(rows.flatMap(row => Object.keys(row.totals)))].filter(key => !known.includes(key) && has(key)).sort();
  const columns = [...known, ...other];
  const label = (key) => {
    if (countMetric || other.includes(key)) return key;
    if (key === 'LOAD') return timeMetric ? 'requests' : 'LOAD';
    if (key === 'CUSTOM_PERCENTILE') return `p${percentile}`;
    return VALUE_LABELS[key] || key;
  };
  const formatter = (key) => {
    if (key === 'LOAD' || key === 'COUNT') return format.count;
    if (key === 'COUNT_PER_MINUTE') return (v) => (isNumber(v) ? `${format.number(v)}/min` : '-');
    return other.includes(key) ? format.number : format.formatterForUnit(unit);
  };
  const totalKey = countMetric ? 'COUNT' : (columns.includes('SUM') ? 'SUM' : null);
  const legend = countMetric ? COUNT_METRIC_LEGEND : (columns.includes('LOAD') && !timeMetric ? LOAD_LEGEND : null);
  return { countMetric, timeMetric, columns, label, formatter, totalKey, legend };
}

function rankingKey(wanted, model) {
  if (!wanted) {
    if (model.countMetric) return { key: 'COUNT', note: null };
    return { key: model.columns.includes('AVERAGE') ? 'AVERAGE' : (model.columns[0] ?? null), note: null };
  }
  const key = AGGREGATIONS[wanted];
  if (model.columns.includes(key)) return { key, note: null };
  if (wanted === 'SUM' && model.countMetric) return { key: 'COUNT', note: '`aggregation: "SUM"` was read as `COUNT`, the total of a count metric.' };
  if (wanted === 'COUNT' && model.timeMetric && model.columns.includes('LOAD')) return { key: 'LOAD', note: '`aggregation: "COUNT"` was read as the number of requests (`LOAD`), because a time metric has no `COUNT`.' };
  return { key: null, note: null };
}

const callsOf = (row) => (isNumber(row.totals.LOAD) ? row.totals.LOAD : row.totals.COUNT);

async function listTraceDefinitions(args, ctx) {
  const { format } = ctx;
  const view = given(args.definitions_view) ? String(args.definitions_view).trim() : 'topweb';
  const time = ctx.time(args);
  const service = await resolveService(args, ctx, time);
  const data = await ctx.get('/rest/mda2/uiDefs', {
    mdaId: view,
    initial: true,
    serviceId: service?.entityId,
    gtf: time.gtf,
  }, { label: `Trace statistics definitions (${view})` });
  ctx.expectShape(data, ['metricDefinitions[]', 'dimensionDefinitions[]'], MDA_DEFINITIONS_ENDPOINT);

  const aggregationNames = (list) => (Array.isArray(list) ? list : []).map(a => (a === 'CUSTOM_PERCENTILE' ? 'PERCENTILE' : a)).join(', ');
  const builtInMetrics = data.metricDefinitions.filter(m => m.type !== 'REQUEST_ATTRIBUTE');
  const attributeMetrics = data.metricDefinitions.filter(m => m.type === 'REQUEST_ATTRIBUTE');
  const placeholder = (definition) => `\`${normalizeDimension(definition.placeHolder)}\``;
  const builtInDimensions = data.dimensionDefinitions.filter(d => d.type !== 'REQUEST_ATTRIBUTE').map(placeholder);
  const attributeDimensions = data.dimensionDefinitions.filter(d => d.type === 'REQUEST_ATTRIBUTE').map(placeholder);
  const preset = data.mdaConfig && typeof data.mdaConfig === 'object' ? data.mdaConfig : null;
  let presetFilter = '';
  if (preset && given(preset.serviceFilter)) {
    try {
      presetFilter = ctx.servicefilter.describe(ctx.servicefilter.decode(preset.serviceFilter).input);
    } catch (error) {
      presetFilter = '';
    }
  }
  const presetLine = preset
    ? `Preset of this view: metric \`${preset.metric}\`, dimension \`${preset.dimension}\`, aggregation ${preset.aggregation}${presetFilter ? `, filter ${presetFilter}` : ''}.`
    : null;
  return format.sections(
    ctx.header('Trace statistics definitions', { details: [`view \`${view}\``, service?.entityId, `${data.metricDefinitions.length} metrics, ${data.dimensionDefinitions.length} dimensions`] }),
    presetLine,
    `## Metrics\n\n${format.table(['metric', 'default aggregation', 'aggregations'], builtInMetrics.map(m => [`\`${m.type}\``, m.defaultAggregation === 'CUSTOM_PERCENTILE' ? 'PERCENTILE' : m.defaultAggregation, aggregationNames(m.possibleAggregations)])) || '_None._'}`,
    attributeMetrics.length
      ? `## Request attribute metrics\n\nPass \`metric: "REQUEST_ATTRIBUTE"\` together with \`request_attribute_id\`.\n\n${format.table(['request attribute', 'request_attribute_id', 'aggregations'], attributeMetrics.map(m => [m.displayName, m.requestAttributeId, aggregationNames(m.possibleAggregations)]))}`
      : null,
    `## Dimensions\n\n${builtInDimensions.join(', ') || '_None._'}`,
    attributeDimensions.length ? `## Request attribute dimensions\n\n${attributeDimensions.join(', ')}` : null,
    format.footer({
      next: 'call `trace_statistics` with `metric` and `dimension` set to values from these lists (dimensions with their braces).',
      link: ctx.link('ui/diagnostictools/mda', { params: { mdaId: view }, time }),
    }),
  );
}

function statisticsNext(metric, top, withIds) {
  if (!top) return null;
  const target = top.serviceId ? `\`service: "${top.serviceId}"\`${top.id ? ` and \`request: "${top.id}"\`` : ''}` : (withIds ? '`service` and `request` set to ids from the table' : 'the same filters');
  if (metric === 'CPU_TIME') {
    return `for the top row call \`method_hotspots\` with ${top.serviceId ? `\`service: "${top.serviceId}"\`` : 'its service'} for the methods that burn the CPU, or \`list_traces\` with ${target} and \`sort: "cpu"\` for single requests.`;
  }
  if (/FAIL|ERROR|EXCEPTION/.test(metric)) {
    return `for the top row call \`analyze_failures\` with ${target} for the reasons, or \`list_traces\` with ${target} and \`failed: true\` for single requests.`;
  }
  return `for the top row call \`list_traces\` with ${target} for single requests, or \`analyze_response_time\` with ${target} for where the time goes. Change \`dimension\` to split differently.`;
}

const traceStatistics = {
  name: 'trace_statistics',
  description: [
    'Multidimensional analysis over traces: aggregates one metric over all matching requests, split by one dimension, across all services or for one. The tool for "which endpoints are the slowest / cost the most time / burn the most CPU / fail the most".',
    '',
    'Recipes (the metric defaults to RESPONSE_TIME and the dimension to the request name `{Request:Name}`; add `request_kind: "web"` to rank HTTP endpoints only, because without it SQL statements dominate an environment-wide ranking; add `service` for one service):',
    '- slowest endpoints: `aggregation: "P95"` (or `"AVERAGE"`, the default for time metrics) with `min_calls: 20`, so that requests seen once or twice do not win;',
    '- most time-consuming endpoints: `aggregation: "SUM"`;',
    '- most CPU: `metric: "CPU_TIME"`, `aggregation: "SUM"`;',
    '- most errors: `metric: "FAILED_REQUEST_COUNT"` (or `HTTP_5XX_ERROR_COUNT`), a count metric, ranked by its `COUNT` by default;',
    '- by something else: `dimension: "{Relative-URL}"`, `"{HTTP-Status}"`, `"{Exception:Class}"`, `"{Service:Name}"`, or a request attribute as `"{RequestAttribute:<name>}"`.',
    '',
    '`list_definitions: true` lists the metrics, dimensions and request attributes this environment has. `aggregation` picks the column the rows are ranked by; the header names it. The table shows every aggregate Dynatrace returns. For a time metric these are `requests` (the number of requests), avg, median, p90, p95, the chosen percentile, max, min and sum. For a count metric (Dynatrace returns a `COUNT` for it) they are printed under Dynatrace\'s own names, `COUNT`, `COUNT_PER_MINUTE`, `LOAD`, `AVERAGE`, `MIN`, `MAX`, with a line saying what is known about them. `timeseries: true` adds the top values over time.',
    'Each row prints the request id and, without `service`, the service it belongs to. Dynatrace returns at most its top 100 values, those with the largest total (sum, or `COUNT` for a count metric), and leaves out values with too few sampled requests. Ranking by anything else (avg, p95, max, …) re-sorts only those 100, so a rarely called slow request outside them is missing; the output says when that happened.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      metric: { type: 'string', description: 'Metric to aggregate, e.g. RESPONSE_TIME, CPU_TIME, WAIT_TIME, REQUEST_COUNT, FAILED_REQUEST_COUNT, FAILURE_RATE, HTTP_5XX_ERROR_COUNT, EXCEPTION_COUNT, DATABASE_CHILD_CALL_COUNT, DATABASE_CHILD_CALL_TIME. Default RESPONSE_TIME. List them with list_definitions.' },
      dimension: { type: 'string', description: 'Dimension to split by, in braces, e.g. {Request:Name}, {Relative-URL}, {URL:Host}, {HTTP-Status}, {HTTP-Method}, {Exception:Class}, {Service:Name}, {Request:Failure}, or a request attribute as {RequestAttribute:<name>}. Default {Request:Name}. List them with list_definitions.' },
      aggregation: { type: 'string', enum: Object.keys(AGGREGATIONS), description: 'Aggregate the rows are ranked by. Default: COUNT for count metrics (those Dynatrace returns a COUNT for: REQUEST_COUNT, FAILED_REQUEST_COUNT, …), AVERAGE for every other metric. SUM = total time (on a count metric it means COUNT). LOAD = the number of requests of a time metric (the `requests` column). PERCENTILE needs `percentile`. An aggregate the metric does not have is an error that lists the available ones.' },
      percentile: { type: 'number', description: `Percentile (1-99) for the PERCENTILE aggregation, shown as an extra column. Default ${DEFAULT_PERCENTILE}.` },
      min_calls: { type: 'number', description: 'Leave out rows with fewer requests than this: the `requests` column of a time metric; for other metrics it is compared with Dynatrace\'s `LOAD` aggregate. Use about 20 when ranking by AVERAGE, P95 or MAX so that rarely called requests do not win. Default 0.' },
      request_attribute_id: { type: 'string', description: 'Only with metric REQUEST_ATTRIBUTE: the id of the numeric request attribute, as printed by list_definitions.' },
      service: { ...ctx.schema.entity('Restrict to one service', 'SERVICE-1234567890ABCDEF'), description: `${ctx.schema.entity('Restrict to one service', 'SERVICE-1234567890ABCDEF').description} Omit for all services.` },
      merge_services: { type: 'boolean', description: 'true = one row per dimension value across services; false (default) = one row per dimension value and service. Ignored when `service` is given.' },
      timeseries: { type: 'boolean', description: 'Also summarise the top dimension values over time. Default false.' },
      list_definitions: { type: 'boolean', description: 'Discovery mode: list the available metrics and dimensions instead of running an analysis.' },
      definitions_view: { type: 'string', enum: MDA_VIEWS, description: 'Which built-in analysis view list_definitions reads. Default topweb (web requests); topdb / topsql for database statements, exceptions for exception analysis.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(25, 'dimension values', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    if (args.list_definitions === true) return listTraceDefinitions(args, ctx);
    const { format } = ctx;
    const time = ctx.time(args);
    const metric = given(args.metric) ? String(args.metric).trim().toUpperCase() : 'RESPONSE_TIME';
    const dimension = normalizeDimension(args.dimension);
    const wanted = normalizeAggregation(args);
    const percentile = given(wanted.percentile) ? wanted.percentile : DEFAULT_PERCENTILE;
    if (!isNumber(percentile) || percentile <= 0 || percentile >= 100) throw new Error(`\`percentile\` must be a number between 1 and 99, got ${JSON.stringify(percentile)}`);
    if (given(args.min_calls) && (!isNumber(args.min_calls) || args.min_calls < 0)) throw new Error('`min_calls` must be a non-negative number');
    const minCalls = given(args.min_calls) ? args.min_calls : 0;
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const analysis = await ctx.mda({
      metric,
      dimension,
      filter,
      service,
      percentile,
      requestAttributeId: given(args.request_attribute_id) ? String(args.request_attribute_id).trim() : undefined,
      timeseries: args.timeseries === true,
      mergeServices: args.merge_services === true,
      time,
    });

    const busy = analysis.rows.filter(row => !(callsOf(row) < minCalls));
    const tooFew = analysis.rows.length - busy.length;
    const model = totalsModel(busy, analysis.unit, percentile, format);
    const ranking = rankingKey(wanted.name, model);
    const chosen = ranking.key;
    if (busy.length && !chosen) {
      const offered = Object.keys(AGGREGATIONS).filter(name => model.columns.includes(AGGREGATIONS[name]));
      throw new Error(`metric ${metric} has no ${wanted.name} aggregation. Available: ${offered.join(', ') || 'none'}.`);
    }
    const ranked = chosen ? sortedBy(busy, row => row.totals[chosen]) : busy;
    const { shown, omitted } = format.cap(ranked, ctx.limit(args.limit, 25, 200));
    const rankLabel = chosen ? model.label(chosen) : null;
    const withIds = shown.some(row => row.id);
    const withService = !service && shown.some(row => row.serviceId);
    const serviceLabel = (row) => {
      const facts = [row.serviceId, analysis.serviceTypes[row.serviceId]].filter(Boolean).join(', ');
      return `${analysis.serviceNames[row.serviceId] || ''} (${facts})`.trim();
    };
    const headers = [...(withIds ? ['id'] : []), dimension, ...(withService ? ['service'] : []), ...model.columns.map(model.label)];
    const rows = shown.map(row => [
      ...(withIds ? [row.id || ''] : []),
      `${format.truncate(format.oneLine(row.name), 160)}${row.unreliable ? ' (unreliable)' : ''}`,
      ...(withService ? [row.serviceId ? serviceLabel(row) : ''] : []),
      ...model.columns.map(key => model.formatter(key)(row.totals[key])),
    ]);

    let seriesBlock = null;
    if (args.timeseries === true && chosen) {
      const series = shown.slice(0, 5)
        .map(row => ({ row, points: row.timeseries?.[chosen] }))
        .filter(entry => entry.points)
        .map(({ row, points }) => ({ label: withService && row.serviceId ? `${row.name} (${analysis.serviceNames[row.serviceId] || row.serviceId})` : row.name, shortLabel: row.name, ...format.pointSeries(points) }));
      seriesBlock = `## ${rankLabel} over time (top ${series.length})\n\n${series.length ? format.seriesReport(series, { format: model.formatter(chosen), maxSeries: 5 }) : 'Dynatrace returned no time series for these values.'}`;
    }

    const totalLabel = model.totalKey ? model.label(model.totalKey) : 'total';
    const capNote = !analysis.capNote || !chosen ? (analysis.capNote ? `${analysis.capNote}.` : null) : (chosen === model.totalKey
      ? `${analysis.capNote}, those with the largest ${totalLabel}; the others are not part of this ranking. Narrow the filter or the time window to see them.`
      : `${analysis.capNote}, those with the largest ${totalLabel}, and this table re-sorts only those by ${rankLabel}: a value outside them can rank higher by ${rankLabel}, so this is not the complete ranking by ${rankLabel}. Narrow the filter or the time window until all values fit.`);
    const loadLabel = model.columns.includes('LOAD') ? model.label('LOAD') : 'COUNT';
    const notes = [
      ranking.note,
      analysis.foreign > 0 ? `${analysis.foreign} row${analysis.foreign === 1 ? '' : 's'} of other services with the same name ${analysis.foreign === 1 ? 'was' : 'were'} dropped; only rows of ${service.entityId} are shown.` : null,
      capNote,
      analysis.omittedUnreliable > 0 || analysis.withoutTotals > 0 ? `${analysis.omittedUnreliable + analysis.withoutTotals} values with too few sampled requests for reliable numbers are not shown.` : null,
      tooFew > 0 ? `${tooFew} value${tooFew === 1 ? '' : 's'} with \`${loadLabel}\` below ${minCalls} left out (\`min_calls\`).` : null,
    ].filter(Boolean).join(' ');
    const described = ctx.servicefilter.describe(filter);
    const empty = `_No requests matched in this window._ Check \`metric\` and \`dimension\` with \`list_definitions: true\`, ${described || minCalls ? 'loosen the filter, ' : ''}or widen the time window.`;
    return format.sections(
      ctx.header(`Trace statistics: ${metric} by ${dimension}`, {
        time,
        details: [
          service ? `${service.displayName} ${service.entityId}` : null,
          described,
          chosen ? `${shown.length} of ${busy.length}, ranked by ${rankLabel}` : null,
        ],
      }),
      warningLine(analysis.warnings),
      format.table(headers, rows) || empty,
      format.omittedNote(omitted),
      rows.length ? model.legend : null,
      notes || null,
      seriesBlock,
      format.footer({
        next: rows.length ? statisticsNext(metric, dimension === REQUEST_DIMENSION ? { id: shown[0].id, serviceId: shown[0].serviceId || service?.entityId } : null, withIds) || 'call `list_traces` with the same filters for the individual traces, or change `dimension` to split differently.' : null,
        link: ctx.link('ui/diagnostictools/mda', {
          params: { mdaId: 'topweb', metric, dimension, mergeServices: analysis.merged, aggregation: chosen && chosen !== 'LOAD' ? chosen : undefined, percentile, servicefilter: analysis.servicefilter },
          time,
        }),
      }),
    );
  },
};

const NODE_FIELD_COUNT = 27;
const NODE_COLUMNS = {
  id: 0,
  parentId: 1,
  callURI: 2,
  service: 3,
  name: 4,
  icon: 5,
  multiplicity: 6,
  clientStart: 7,
  clientEnd: 8,
  serverStart: 9,
  serverEnd: 10,
  kind: 12,
  suspension: 14,
  wait: 15,
  cpu: 17,
  selfTime: 18,
  responseTime: 21,
};
const DATABASE_KIND = 1;

function decodeTraceNodes(data) {
  if (typeof data.nodeData !== 'string') throw apiChanged(TRACE_ENDPOINT, 'has no text `nodeData`');
  const fields = data.nodeData === '' ? [] : data.nodeData.split('|');
  if (fields.length % NODE_FIELD_COUNT !== 0) {
    throw apiChanged(TRACE_ENDPOINT, `has a \`nodeData\` table of ${fields.length} fields, which is not a multiple of the expected ${NODE_FIELD_COUNT} per node`);
  }
  const strings = data.stringMap || {};
  const icons = data.iconMap || {};
  const nodes = [];
  for (let offset = 0; offset < fields.length; offset += NODE_FIELD_COUNT) {
    const at = (column) => fields[offset + NODE_COLUMNS[column]];
    const numeric = (column) => Number(at(column));
    const node = {
      id: at('id'),
      parentId: at('parentId'),
      callURI: at('callURI') === 'null' || at('callURI') === '' ? null : at('callURI'),
      service: strings[at('service')] ?? null,
      name: strings[at('name')] ?? null,
      technology: icons[at('icon')]?.primaryType ?? null,
      multiplicity: Math.max(1, numeric('multiplicity') || 1),
      clientStart: numeric('clientStart'),
      clientEnd: numeric('clientEnd'),
      serverStart: numeric('serverStart'),
      serverEnd: numeric('serverEnd'),
      kind: numeric('kind'),
      suspension: numeric('suspension'),
      wait: numeric('wait'),
      cpu: numeric('cpu'),
      selfTime: numeric('selfTime'),
      responseTime: numeric('responseTime'),
      children: [],
    };
    if (!isNumber(node.responseTime) || !isNumber(node.clientStart) || !isNumber(node.serverStart)) {
      throw apiChanged(TRACE_ENDPOINT, `has a non-numeric timing column in \`nodeData\` (node ${node.id})`);
    }
    node.clientDuration = node.clientStart > 0 && node.clientEnd >= node.clientStart ? node.clientEnd - node.clientStart : null;
    node.duration = node.responseTime > 0 ? node.responseTime : (node.clientDuration ?? 0);
    node.start = node.clientStart > 0 ? node.clientStart : (node.serverStart > 0 ? node.serverStart : null);
    nodes.push(node);
  }
  return nodes;
}

function traceRoots(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const roots = [];
  for (const node of nodes) {
    const parent = byId.get(node.parentId);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes) node.children.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  return roots.flatMap(root => (root.callURI === null ? root.children : [root]));
}

const subtreeSize = (node) => 1 + sum(node.children, subtreeSize);

function collapseSiblings(nodes) {
  const groups = [];
  for (const node of nodes) {
    const key = `${node.kind}\u0000${node.service}\u0000${node.name}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key && node.children.length === 0 && last.nodes[0].children.length === 0) last.nodes.push(node);
    else groups.push({ key, nodes: [node] });
  }
  return groups.map(({ nodes: members }) => ({
    first: members[0],
    members,
    calls: sum(members, n => n.multiplicity),
    duration: sum(members, n => n.duration),
    cpu: sum(members, n => n.cpu),
    wait: sum(members, n => n.wait),
    suspension: sum(members, n => n.suspension),
    children: members.length === 1 ? members[0].children : [],
  }));
}

function traceLine(group, depth, startMicros, format) {
  const node = group.first;
  const single = group.members.length === 1;
  const offset = node.start !== null && isNumber(startMicros) ? `+${format.duration(Math.max(0, node.start - startMicros))} ` : '';
  const clientSide = single && node.responseTime > 0 && node.clientDuration !== null && node.clientDuration - node.responseTime > Math.max(1000, node.responseTime * 0.1);
  const details = [
    single && node.selfTime > 0 && node.selfTime !== group.duration ? `self ${format.duration(node.selfTime)}` : null,
    group.cpu > 0 ? `cpu ${format.duration(group.cpu)}` : null,
    group.wait > 0 ? `wait ${format.duration(group.wait)}` : null,
    group.suspension > 0 ? `suspension ${format.duration(group.suspension)}` : null,
    clientSide ? `client-side ${format.duration(node.clientDuration)}` : null,
  ].filter(Boolean).join(', ');
  const technology = node.technology && node.technology !== 'UnknownIcon' ? ` [${node.technology}]` : '';
  const collapsed = single ? '' : ` (${group.members.length} consecutive identical calls collapsed, callURI of the first)`;
  const name = format.truncate(format.oneLine(node.name ?? '(unnamed)'), 200);
  return `${'  '.repeat(depth)}- ${offset}**${node.service ?? '(unknown service)'}** ${name}${group.calls > 1 ? ` ×${group.calls}` : ''} — ${format.duration(group.duration)}${group.calls > 1 ? ' total' : ''}${details ? ` (${details})` : ''}${technology}${node.callURI ? ` \`${node.callURI}\`` : ''}${collapsed}`;
}

function renderTrace(roots, { startMicros, minMicros, maxDepth, lineLimit, format }) {
  const lines = [];
  const pruned = { short: 0, deep: 0, overflow: 0 };
  const walk = (nodes, depth) => {
    for (const group of collapseSiblings(nodes)) {
      const size = sum(group.members, subtreeSize);
      if (depth > 0 && group.duration < minMicros) {
        pruned.short += size;
        continue;
      }
      if (lines.length >= lineLimit) {
        pruned.overflow += size;
        continue;
      }
      lines.push(traceLine(group, depth, startMicros, format));
      if (group.children.length === 0) continue;
      if (maxDepth !== null && depth + 1 >= maxDepth) pruned.deep += sum(group.children, subtreeSize);
      else walk(group.children, depth + 1);
    }
  };
  walk(roots, 0);
  return { lines, pruned };
}

function describeBreakdown(breakdown, format) {
  const entries = Array.isArray(breakdown?.entries) ? breakdown.entries : [];
  return entries.filter(e => positive(e?.time)).map(e => `${e.type} ${format.duration(e.time)}`).join(', ');
}

function describeExceptionFinding(findings) {
  const finding = findings?.exceptionFinding;
  if (!finding) return '';
  const classes = Object.entries(finding.exceptionsByCount || {}).map(([clazz, count]) => `${clazz} ×${count}`);
  if (positive(finding.otherExceptions)) classes.push(`${finding.otherExceptions} ${classes.length ? 'other' : 'exception(s), classes in `get_trace_details`'}`);
  return classes.join(', ');
}

function traceStateWarnings(data) {
  const state = data.stateInfo || {};
  const warnings = analysisWarnings(state);
  const correlation = data.debug?.['correlation state'];
  if (typeof correlation === 'string' && correlation.toLowerCase() !== 'ok') warnings.push(`correlation state is ${correlation}`);
  if (data.header?.inProgressPurePath === true) warnings.push('the trace is still in progress');
  return warnings;
}

const getTrace = {
  name: 'get_trace',
  description: [
    'Shows one trace as an indented span tree: for every call the service, the operation (request name or SQL statement), how often it ran, its start offset from the beginning of the trace, response time, self time, CPU / wait / suspension time, the technology, and the `callURI` of the node.',
    '',
    'Pass `trace_id` and `call_uri` exactly as printed by `list_traces`, with a time window that contains the trace (the same window is fine). Runs of identical sibling calls (the same SQL statement 200 times) are collapsed into one line with the call count and total time.',
    'Large traces: `min_duration_ms` hides calls shorter than that, `max_depth` limits the nesting, `limit` caps the lines; the output always says what was hidden.',
    'Follow up with `get_trace_details` on a node\'s `callURI` for exceptions with stack traces, the code-level method tree, full SQL and HTTP headers.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      trace_id: { type: 'string', description: 'The traceId printed by list_traces (32 hex characters).' },
      call_uri: { type: 'string', description: 'The callURI printed next to the traceId by list_traces.' },
      max_depth: { type: 'number', description: 'Show only this many nesting levels (1 = only the entry call). Default: all levels.' },
      min_duration_ms: { type: 'number', description: 'Hide calls (with everything below them) that took less than this many milliseconds in total. Default 0 = show all.' },
      limit: ctx.schema.limit(150, 'tree lines', 400),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['trace_id', 'call_uri'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const traceId = String(args.trace_id).trim();
    const callURI = String(args.call_uri).trim();
    if (given(args.min_duration_ms) && (!isNumber(args.min_duration_ms) || args.min_duration_ms < 0)) throw new Error('`min_duration_ms` must be a non-negative number of milliseconds');
    if (given(args.max_depth) && (!isNumber(args.max_depth) || args.max_depth < 1)) throw new Error('`max_depth` must be 1 or more');
    const minMicros = given(args.min_duration_ms) ? args.min_duration_ms * 1000 : 0;
    const maxDepth = given(args.max_depth) ? Math.floor(args.max_depth) : null;
    const lineLimit = ctx.limit(args.limit, 150, 400);
    const data = await ctx.get('/rest/serviceanalysis/trace', { traceId, callURI, ...time.analysisQuery }, { label: `Trace ${format.truncate(traceId, 12)}` });
    ctx.expectShape(data, ['header', 'nodeData', 'stringMap'], TRACE_ENDPOINT);

    const header = data.header;
    const nodes = decodeTraceNodes(data);
    const roots = traceRoots(nodes);
    const calls = nodes.filter(node => node.callURI !== null);
    const { lines, pruned } = renderTrace(roots, { startMicros: header.startTime, minMicros, maxDepth, lineLimit, format });
    const prunedParts = [
      pruned.short ? `${pruned.short} calls shorter than ${format.durationMs(args.min_duration_ms)} (\`min_duration_ms\`)` : null,
      pruned.deep ? `${pruned.deep} calls below nesting level ${maxDepth} (\`max_depth\`)` : null,
      pruned.overflow ? `${pruned.overflow} calls beyond the ${lineLimit}-line \`limit\`` : null,
    ].filter(Boolean);
    const breakdown = describeBreakdown(header.breakdown, format);
    const exceptions = describeExceptionFinding(header.findings);
    const summary = [
      `- Entry service: ${header.serviceName ?? '(unknown)'}${header.serviceId ? ` (\`${header.serviceId}\`)` : ''}`,
      isNumber(header.startTime) ? `- Start: ${format.utc(header.startTime / 1000, { millis: true })}` : null,
      `- Response time: ${format.duration(header.responseTime)}${isNumber(header.processingTime) && header.processingTime !== header.responseTime ? ` (processing ${format.duration(header.processingTime)})` : ''}`,
      breakdown ? `- Breakdown: ${breakdown}` : null,
      exceptions ? `- Exceptions: ${exceptions}` : null,
      `- Calls: ${calls.length} nodes, ${sum(calls.filter(n => n.kind === DATABASE_KIND), n => n.multiplicity)} database calls`,
    ].filter(Boolean).join('\n');
    const legend = 'Each line: +offset from the trace start, **service**, operation, ×calls, time (self = time not spent in calls to other services), [technology], `callURI`.';
    return format.sections(
      ctx.header(`Trace ${traceId}`, { time, details: [header.serviceName] }),
      warningLine(traceStateWarnings(data)),
      summary,
      lines.length ? `## Calls\n\n${legend}\n\n${lines.join('\n')}` : '_The trace has no calls in this window._ Use a time window that contains the trace start.',
      lines.length ? (prunedParts.length ? `_Hidden: ${prunedParts.join('; ')}._` : '_Nothing was hidden: this is the complete tree._') : null,
      format.footer({
        next: lines.length ? 'call `get_trace_details` with `call_uri` set to the callURI of a node (same time window) for exceptions, the method-level tree, SQL text and headers.' : null,
        link: ctx.link('#trace', { params: { traceId, callURI }, time }),
      }),
    );
  },
};

function callDuration(timing) {
  if (positive(timing?.sdur)) return timing.sdur;
  if (positive(timing?.cdur)) return timing.cdur;
  return 0;
}

function describeTiming(timing, format) {
  const parts = [
    positive(timing.sdur) ? `response ${format.duration(timing.sdur)}` : null,
    positive(timing.cdur) ? `${positive(timing.sdur) ? 'client-side' : 'response'} ${format.duration(timing.cdur)}` : null,
    positive(timing.self) && timing.self !== timing.sdur ? `self ${format.duration(timing.self)}` : null,
    positive(timing.cpu) ? `cpu ${format.duration(timing.cpu)}` : null,
    positive(timing.wait) ? `wait ${format.duration(timing.wait)}` : null,
    positive(timing.sync) ? `lock ${format.duration(timing.sync)}` : null,
    positive(timing.susp) ? `suspension ${format.duration(timing.susp)}` : null,
    positive(timing.diskIO) ? `disk I/O ${format.duration(timing.diskIO)}` : null,
    positive(timing.networkIO) ? `network I/O ${format.duration(timing.networkIO)}` : null,
  ].filter(Boolean);
  return parts.join(', ') || 'no timing recorded';
}

function exceptionBlocks(root, frameLimit, format) {
  const lists = [root.server?.exception?.exceptions, root.client?.exception?.exceptions].filter(Array.isArray).flat();
  return lists.map((exception) => {
    const frames = (Array.isArray(exception.stacktrace) ? exception.stacktrace : [])
      .map(frame => `at ${[frame?.clazz, frame?.method].filter(given).join('.')}${isNumber(frame?.line) && frame.line > 0 ? `:${frame.line}` : ''}`);
    const title = `**${exception.throwableClass ?? 'Exception'}**${given(exception.message) ? `: ${format.truncate(maskInline(format.oneLine(exception.message)), 400)}` : ''}`;
    return frames.length ? `${title}\n\`\`\`\n${format.stackTrace(frames, frameLimit)}\n\`\`\`` : title;
  });
}

function headerLines(headers, format) {
  const source = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
  const names = Object.keys(source);
  const hidden = names.filter(name => format.isSensitiveHeader(name));
  const kept = format.stripHeaders(source);
  return {
    lines: Object.entries(kept).map(([name, value]) => `- ${name}: ${format.truncate(plainText(value), 300)}`),
    hidden,
  };
}

function webRequestBlock(title, web, format) {
  if (!web || typeof web !== 'object') return null;
  const code = web.httpCodeValid !== false && positive(web.httpCode) ? ` → HTTP ${web.httpCode}` : '';
  const request = headerLines(web.requestHeaders, format);
  const response = headerLines(web.responseHeaders, format);
  const params = Object.entries(web.requestParams && typeof web.requestParams === 'object' ? web.requestParams : {})
    .map(([name, value]) => {
      const masked = maskNamed(name, value);
      return `- ${name}: ${format.truncate(Array.isArray(masked) ? masked.map(plainText).join(', ') : plainText(masked), 200)}`;
    });
  const hidden = [...new Set([...request.hidden, ...response.hidden].map(name => name.toLowerCase()))];
  return [
    `## ${title}`,
    `${[web.httpMethod, format.truncate(maskInline(String(web.uri ?? '')), 400)].filter(given).join(' ')}${code}`,
    [given(web.hostName) ? `host ${web.hostName}` : null, given(web.contextRoot) ? `context root ${web.contextRoot}` : null, given(web.applicationId) ? `application ${web.applicationId}` : null].filter(Boolean).join(', ') || null,
    params.length ? `Request parameters:\n${params.join('\n')}` : null,
    request.lines.length ? `Request headers:\n${request.lines.join('\n')}` : null,
    response.lines.length ? `Response headers:\n${response.lines.join('\n')}` : null,
    hidden.length ? `_${hidden.length} sensitive header${hidden.length === 1 ? '' : 's'} hidden: ${hidden.join(', ')}._` : null,
  ].filter(Boolean).join('\n\n');
}

function databaseBlock(database, format) {
  if (!database || typeof database !== 'object') return null;
  const facts = [
    isNumber(database.execCount) ? `executions ${database.execCount}` : null,
    isNumber(database.rowsReturnedPerExecution) ? `rows per execution ${format.number(database.rowsReturnedPerExecution)}` : null,
    isNumber(database.fetchesPerExecution) ? `fetches per execution ${format.number(database.fetchesPerExecution)}` : null,
    given(database.methodName) ? `method ${database.methodName}` : null,
  ].filter(Boolean).join(', ');
  return [`## Database statement`, facts || null, given(database.sql) ? `\`\`\`sql\n${format.truncate(database.sql, 4000)}\n\`\`\`` : null].filter(Boolean).join('\n\n');
}

function downstreamRows(children, format) {
  const groups = new Map();
  for (const child of children) {
    const call = child.call || {};
    const key = `${call.name}\u0000${call.methodName}`;
    if (!groups.has(key)) groups.set(key, { call, calls: 0, duration: 0, failed: 0, nodes: 0, serviceType: call.serviceType });
    const group = groups.get(key);
    group.calls += positive(call.mult) ? call.mult : 1;
    group.duration += callDuration(child.timing);
    group.failed += child.details?.failed ? 1 : 0;
    group.nodes++;
  }
  return sortedBy([...groups.values()], group => group.duration).map(group => [
    group.call.name ?? '',
    format.truncate(format.oneLine(group.call.methodName), 300),
    group.serviceType ?? '',
    group.calls,
    format.duration(group.duration),
    group.failed ? 'yes' : '',
    group.call.callURI ? `\`${group.call.callURI}\`` : '',
  ]);
}

function methodForest(root) {
  const nodes = Array.isArray(root.nodes) ? root.nodes : [];
  const parents = Array.isArray(root.parentIds) ? root.parentIds : [];
  const items = nodes.map(node => ({ node, children: [] }));
  const roots = [];
  items.forEach((item, index) => {
    const parent = items[parents[index]];
    if (parent && parents[index] !== index) parent.children.push(item);
    else roots.push(item);
  });
  return roots;
}

function renderMethods(root, { thresholdMicros, lineLimit, format }) {
  const called = new Map((Array.isArray(root.children) ? root.children : []).map(child => [String(child.id), child]));
  const hidden = { cold: 0, passThrough: 0, overflow: 0 };
  const lines = [];
  const weight = (node) => {
    if (node.type === 'SERVICE_PLACEHOLDER') return callDuration(called.get(String(node.calledServiceId))?.timing);
    return isNumber(node.dur) ? node.dur : -1;
  };
  const mark = (item) => {
    const { node } = item;
    item.size = 1 + sum(item.children.map(mark), size => size);
    item.hot = node.type === 'EXCEPTION' || node.exception === true || weight(node) >= thresholdMicros;
    item.keep = item.hot || item.children.some(child => child.keep);
    return item.size;
  };
  const line = (item, depth) => {
    const { node } = item;
    const indent = '  '.repeat(depth);
    if (node.type === 'EXCEPTION') return `${indent}- exception thrown: ${node.label ?? '(unknown class)'}`;
    if (node.type === 'SERVICE_PLACEHOLDER') {
      const child = called.get(String(node.calledServiceId));
      if (!child) return `${indent}- call to another service`;
      const mult = positive(child.call?.mult) && child.call.mult > 1 ? ` ×${child.call.mult}` : '';
      return `${indent}- call → **${child.call?.name ?? ''}** ${format.truncate(format.oneLine(child.call?.methodName), 120)}${mult} — ${format.duration(callDuration(child.timing))}`;
    }
    const method = node.method || {};
    const details = [
      positive(method.self) && method.self !== node.dur ? `self ${format.duration(method.self)}` : null,
      positive(method.cpu) ? `cpu ${format.duration(method.cpu)}` : null,
      positive(method.wait) ? `wait ${format.duration(method.wait)}` : null,
      positive(method.sync) ? `lock ${format.duration(method.sync)}` : null,
      positive(method.susp) ? `suspension ${format.duration(method.susp)}` : null,
    ].filter(Boolean).join(', ');
    const name = format.truncate([method.clazz, method.method].filter(given).join('.') || '(unknown method)', 200);
    return `${indent}- ${name}${positive(node.dur) ? ` — ${format.duration(node.dur)}` : ''}${details ? ` (${details})` : ''}${given(method.apiName) ? ` [${method.apiName}]` : ''}${method.exitByException ? ' exits by exception' : ''}`;
  };
  const walk = (items, depth) => {
    for (const item of items) {
      if (!item.keep) {
        hidden.cold += item.size;
        continue;
      }
      const kept = item.children.filter(child => child.keep);
      const ownTime = item.node.method?.self;
      const passThrough = item.node.type === 'METHOD' && item.node.exception !== true && kept.length === 1 && kept[0].node.type === 'METHOD' && !(positive(ownTime) && ownTime >= thresholdMicros);
      if (passThrough) {
        hidden.passThrough++;
        walk(item.children, depth);
        continue;
      }
      if (lines.length >= lineLimit) {
        hidden.overflow += item.size;
        continue;
      }
      lines.push(line(item, depth));
      walk(item.children, depth + 1);
    }
  };
  const roots = methodForest(root);
  roots.forEach(mark);
  walk(roots, 0);
  return { lines, hidden, total: sum(roots, item => item.size) };
}

function runsOnLines(root) {
  const runsOn = root.runsOn || {};
  const sub = root.details?.subPathData || {};
  return [
    given(runsOn.pgiName) || given(runsOn.pgiId) ? `- Process: ${runsOn.pgiName ?? ''}${runsOn.pgiId ? ` (\`${runsOn.pgiId}\`)` : ''}` : null,
    given(runsOn.pgName) ? `- Process group: ${runsOn.pgName}` : null,
    given(runsOn.osiName) || given(runsOn.osiId) ? `- Host / pod: ${runsOn.osiName ?? ''}${runsOn.osiId ? ` (\`${runsOn.osiId}\`)` : ''}` : null,
    given(sub.threadName) ? `- Thread: ${sub.threadName}` : null,
    given(sub.agentTechnology) ? `- Agent: ${[sub.agentTechnology, sub.agentVersion].filter(given).join(' ')}` : null,
    given(sub.operatingSystem) ? `- OS: ${sub.operatingSystem}` : null,
  ].filter(Boolean);
}

function describeTechnologies(details) {
  const techs = Array.isArray(details?.techs) ? details.techs : [];
  return [...new Set(techs.map(tech => [tech?.verbatimType || tech?.type, tech?.version].filter(given).join(' ')).filter(Boolean))].join(', ');
}

function describeAttributeMap(...maps) {
  return maps
    .filter(map => map && typeof map === 'object')
    .flatMap(map => Object.entries(map))
    .map(([key, value]) => `${key}=${plainText(maskNamed(key, value))}`)
    .join(', ');
}

const getTraceDetails = {
  name: 'get_trace_details',
  description: [
    'Everything Dynatrace recorded about one call (node) of a trace: exceptions with stack traces, the code-level method tree with total / self / CPU / wait time pruned to the hot paths, the downstream calls it made with SQL text and call counts, the full SQL of a database call, HTTP request and response headers and parameters, the process and host / pod it ran on, and the technologies involved.',
    '',
    'Pass `call_uri` of a node as printed by `get_trace` (or by `list_traces` for the entry call), with a time window that contains the trace.',
    'Stack traces show the top `stack_frames` frames (`full_stack: true` for all). The method tree hides methods below `min_method_ms` (default 1 % of the call) and pass-through frames, and says how many. Authorization, cookie and token headers are never shown; request parameters, headers and attributes whose name looks like a secret (password, token, key, session id, …) or whose value looks like a credential are printed as `<masked>`, as are such parameters inside URLs.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      call_uri: { type: 'string', description: 'The callURI of the call, as printed by get_trace or list_traces.' },
      full_stack: { type: 'boolean', description: 'Print every frame of the exception stack traces. Default false.' },
      stack_frames: { type: 'number', description: 'Frames per stack trace when full_stack is not set. Default 8, at most 100.' },
      min_method_ms: { type: 'number', description: 'Hide methods of the code-level tree that took less than this many milliseconds. Default: 1 % of the call\'s response time, at least 1 ms.' },
      method_limit: { type: 'number', description: 'Maximum lines of the code-level tree. Default 40, at most 300.' },
      limit: ctx.schema.limit(25, 'downstream calls', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['call_uri'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const callURI = String(args.call_uri).trim();
    if (given(args.min_method_ms) && (!isNumber(args.min_method_ms) || args.min_method_ms < 0)) throw new Error('`min_method_ms` must be a non-negative number of milliseconds');
    const data = await ctx.get('/rest/serviceanalysis/servicecalldetails', { callURI, span: 'NO_SPAN', ...time.analysisQuery }, { label: 'Trace call details' });
    ctx.expectShape(data, ['root.call', 'root.timing', 'root.children[]'], CALL_DETAILS_ENDPOINT);

    const root = data.root;
    const call = root.call;
    const details = root.details || {};
    const total = callDuration(root.timing);
    const drillup = root.drillup || {};
    const upward = (label, target) => (target?.callURI && target.callURI !== callURI ? `- ${label}: ${target.serviceName ?? ''} \`${target.callURI}\`` : null);
    const tags = (Array.isArray(details.tags) ? details.tags : []).map(tag => (given(tag?.value) ? `${tag.key}:${plainText(maskNamed(tag.key, tag.value))}` : tag?.key)).filter(given).join(', ');
    const attributes = describeAttributeMap(details.oneAgentAttributesData?.attributes, details.oneAgentAttributesData?.resourceAttributes);
    const technologies = describeTechnologies(details);
    const summary = [
      `- Service: ${call.name ?? '(unknown)'}${call.id ? ` (\`${call.id}\`)` : ''}${given(call.serviceType) ? `, ${call.serviceType}` : ''}`,
      `- Operation: ${format.truncate(format.oneLine(call.methodName), 300) || '(unnamed)'}${call.methodId ? ` (\`${call.methodId}\`)` : ''}`,
      given(call.methodGroupId) ? `- Request group: ${call.methodGroupName ?? ''} (\`${call.methodGroupId}\`)` : null,
      `- Result: ${details.failed ? '**FAILED**' : 'successful'}${positive(call.mult) && call.mult > 1 ? `, executed ×${call.mult}` : ''}`,
      `- Timing: ${describeTiming(root.timing, format)}`,
      technologies ? `- Technologies: ${technologies}` : null,
      tags ? `- Tags: ${tags}` : null,
      attributes ? `- Attributes: ${format.truncate(attributes, 600)}` : null,
      upward('Called by', drillup.parentService),
      drillup.rootService?.callURI !== drillup.parentService?.callURI ? upward('Trace entry', drillup.rootService) : null,
    ].filter(Boolean).join('\n');

    const frameLimit = args.full_stack === true ? null : ctx.limit(args.stack_frames, 8, 100, 'stack_frames');
    const exceptions = exceptionBlocks(root, frameLimit, format);
    const threshold = given(args.min_method_ms) ? args.min_method_ms * 1000 : Math.max(1000, total * 0.01);
    const methodLimit = ctx.limit(args.method_limit, 40, 300, 'method_limit');
    const methods = renderMethods(root, { thresholdMicros: threshold, lineLimit: methodLimit, format });
    const hiddenParts = [
      methods.hidden.cold ? `${methods.hidden.cold} below ${format.duration(threshold)}` : null,
      methods.hidden.passThrough ? `${methods.hidden.passThrough} pass-through frames` : null,
      methods.hidden.overflow ? `${methods.hidden.overflow} beyond \`method_limit\` ${methodLimit}` : null,
    ].filter(Boolean);
    const methodBlock = methods.total
      ? [
        `## Code-level method tree (${methods.lines.length} of ${methods.total} nodes)`,
        methods.lines.length ? methods.lines.join('\n') : `_No method took ${format.duration(threshold)} or more._`,
        hiddenParts.length ? `_Hidden: ${hiddenParts.join('; ')}. Lower \`min_method_ms\` or raise \`method_limit\` to see more._` : null,
      ].filter(Boolean).join('\n\n')
      : null;

    const downstream = downstreamRows(root.children, format);
    const { shown, omitted } = format.cap(downstream, ctx.limit(args.limit, 25, 200));
    const downstreamBlock = downstream.length
      ? [
        `## Downstream calls (${sum(root.children, child => (positive(child.call?.mult) ? child.call.mult : 1))} calls, ${downstream.length} distinct)`,
        format.table(['service', 'operation / SQL', 'type', 'calls', 'total time', 'failed', 'callURI (first)'], shown),
        format.omittedNote(omitted),
      ].filter(Boolean).join('\n\n')
      : null;

    const location = runsOnLines(root);
    const traceId = details.subPathData?.traceIdHex;
    return format.sections(
      ctx.header(`Trace call: ${call.name ?? callURI}`, { time, details: [format.truncate(format.oneLine(call.methodName), 80)] }),
      summary,
      exceptions.length ? `## Exceptions (${exceptions.length})\n\n${exceptions.join('\n\n')}` : null,
      databaseBlock(root.client?.database || root.server?.database, format),
      webRequestBlock('Web request (server side)', root.server?.webRequest, format) || webRequestBlock('Web request (client side)', root.client?.webRequest, format),
      downstreamBlock,
      methodBlock,
      location.length ? `## Runs on\n\n${location.join('\n')}` : null,
      format.footer({
        next: downstream.length
          ? 'call `get_trace_details` with the callURI of a downstream call for its own details, or `get_trace` for the whole tree.'
          : 'call `get_trace` for the whole tree, or `get_trace_details` on the parent call.',
        link: traceId ? ctx.link('#trace', { params: { traceId, callURI }, time }) : ctx.link('ui/diagnostictools/purepaths', { time }),
      }),
    );
  },
};

export const tools = defineTools([listServiceRequests, listTraces, traceStatistics, getTrace, getTraceDetails]);
