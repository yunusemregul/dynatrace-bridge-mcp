import * as format from './format.js';
import * as servicefilter from './servicefilter.js';
import { resolveTime, DEFAULT_LOOKBACK_MINUTES } from './time.js';
import { createEntityHelpers, isEntityId, idSelector, chunkIds } from './entities.js';
import { BridgeError, EXTENSION_NAME } from './bridge.js';

function timeSchema(defaultLookback = DEFAULT_LOOKBACK_MINUTES) {
  return {
    minutes_lookback: {
      type: 'number',
      description: `Window length in minutes. Default ${defaultLookback}. With neither time_from nor time_to it means the last N minutes up to now; with only time_to it means the N minutes ending at time_to; ignored when time_from is given. The response header always shows the resolved absolute UTC window.`,
    },
    time_from: { type: 'string', description: "Absolute start time, ISO 8601 (e.g. '2026-09-23T10:28:00Z'). A timestamp without a zone (Z or ±hh:mm) is read as UTC. Without time_to, the window runs from here to now. Must not be in the future." },
    time_to: { type: 'string', description: 'Absolute end time, ISO 8601; without a zone it is read as UTC. Without time_from, the window starts minutes_lookback before this. Must not be in the future.' },
  };
}

function limitSchema(defaultLimit, what = 'rows', max = null) {
  return { type: 'number', description: `Maximum number of ${what} to print. Default ${defaultLimit}${max ? `, at most ${max}` : ''}. The output says how many were omitted.` };
}

function entitySchema(what, example) {
  return { type: 'string', description: `${what}, as an entity id (${example}) or a name. A name that matches several entities returns the candidates instead of guessing.` };
}

const NUMERIC = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/;
const shown = (value) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

export function numberArgument(value, name, { fallback = null, min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' && NUMERIC.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`\`${name}\` must be a number, got ${shown(value)}`);
  if (number < min || number > max) {
    const range = max === Infinity ? `${min} or more` : (min === -Infinity ? `${max} or less` : `between ${min} and ${max}`);
    throw new Error(`\`${name}\` must be ${range}, got ${shown(value)}`);
  }
  return integer ? Math.floor(number) : number;
}

export function clampLimit(value, defaultLimit, max = 1000, name = 'limit') {
  return Math.min(numberArgument(value, name, { fallback: defaultLimit, min: 1, integer: true }), max);
}

function listArgument(value, name, spec) {
  const strings = spec?.items?.type === 'string';
  let list = value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      list = JSON.parse(value);
    } catch (error) {
      list = value;
    }
  }
  if (typeof list === 'string' && strings) list = list.split(',').map(item => item.trim()).filter(Boolean);
  if ((typeof list === 'number' || typeof list === 'boolean') && strings) list = [list];
  if (!Array.isArray(list)) throw new Error(`\`${name}\` must be a list, got ${shown(value)}`);
  return strings ? list.map(item => (typeof item === 'number' || typeof item === 'boolean' ? String(item) : item)) : list;
}

export function normalizeArguments(args, schema) {
  const out = { ...(args || {}) };
  for (const [name, spec] of Object.entries(schema?.properties || {})) {
    const value = out[name];
    if (value === undefined || value === null) continue;
    if (spec?.type === 'number' || spec?.type === 'integer') {
      out[name] = numberArgument(value, name, { fallback: undefined });
    } else if (spec?.type === 'boolean') {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
      if (text === '') out[name] = undefined;
      else if (text === true || text === 'true') out[name] = true;
      else if (text === false || text === 'false') out[name] = false;
      else throw new Error(`\`${name}\` must be true or false, got ${shown(value)}`);
    } else if (spec?.type === 'string') {
      if (typeof value === 'number' || typeof value === 'boolean') out[name] = String(value);
      else if (typeof value !== 'string') throw new Error(`\`${name}\` must be text, got ${shown(value)}`);
    } else if (spec?.type === 'array') {
      out[name] = value === '' ? undefined : listArgument(value, name, spec);
    }
  }
  return out;
}

export function defineTools(tools) {
  return tools.map(tool => ({
    ...tool,
    handler: async (args, ctx) => format.fitOutput(await tool.handler(normalizeArguments(args, tool.inputSchema(ctx)), ctx)),
  }));
}

const PLAIN_UNITS = [undefined, null, '', 'Count', 'Unspecified', 'NotApplicable'];

export function createContextFactory({ bridge, version, mcpPort }) {
  const environmentSchema = () => {
    const names = bridge.environments().map(e => e.name);
    return {
      type: 'string',
      description: names.length > 0
        ? `Which Dynatrace environment to query, as named in the ${EXTENSION_NAME} extension popup. Available: ${names.join(', ')}. Default: ${names[0]}.`
        : `Which Dynatrace environment to query, as named in the ${EXTENSION_NAME} extension popup. The extension has not reported any environments yet, so omit this unless the user names one.`,
    };
  };

  const schema = {
    time: timeSchema,
    environment: environmentSchema,
    serviceFilter: servicefilter.serviceFilterSchema,
    limit: limitSchema,
    entity: entitySchema,
  };

  return function contextFor(toolName, args = {}) {
    const defaults = (options = {}) => ({
      environment: options.environment ?? args.environment ?? null,
      tool: options.tool ?? toolName,
      label: options.label ?? null,
    });

    const dt = (request, options) => bridge.dt(request, defaults(options));

    const get = async (path, query = {}, options = {}) => (await dt({ method: 'GET', path, query, poll: options.poll, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes }, options)).data;

    async function v2List(path, query = {}, { itemsKey, limit = 500, pageSize = null, label = null, environment } = {}) {
      const wanted = clampLimit(limit, 500, 5000);
      const items = [];
      let totalCount = null;
      let nextPageKey = null;
      let pages = 0;
      do {
        const pageQuery = nextPageKey ? { nextPageKey } : { ...query, pageSize: pageSize ?? Math.min(wanted, 500) };
        const { data } = await dt({ path, query: pageQuery }, { label, environment });
        const key = itemsKey || Object.keys(data || {}).find(k => Array.isArray(data[k]));
        if (!data || !Array.isArray(data[key])) {
          throw new Error(`Unexpected response from ${path}: no \`${itemsKey || 'items'}\` array.`);
        }
        items.push(...data[key]);
        if (typeof data.totalCount === 'number') totalCount = data.totalCount;
        nextPageKey = data.nextPageKey || null;
        pages++;
      } while (nextPageKey && items.length < wanted && pages < 20);
      return {
        items: items.slice(0, wanted),
        totalCount: totalCount ?? items.length,
        truncated: items.length > wanted || !!nextPageKey,
      };
    }

    const environment = (name = args.environment) => bridge.findEnvironment(name);

    async function attempt(run, fallback = null) {
      try {
        return { value: await run(), note: null, status: null };
      } catch (error) {
        const soft = error?.code === 'API_CHANGED' || (error instanceof BridgeError && ['HTTP_ERROR', 'POLL_TIMEOUT', 'TIMEOUT', 'RESPONSE_TOO_LARGE'].includes(error.code));
        if (!soft) throw error;
        return { value: fallback, note: format.oneLine(error.message), status: error.status ?? null };
      }
    }

    async function queryMetrics(selectors, { entitySelector, resolution, time = null, label = null } = {}) {
      const pairs = selectors.map(selector => (Array.isArray(selector) ? selector : [format.metricSelector.key(selector), selector]));
      const data = await get('/rest/v2/metrics/query', {
        metricSelector: pairs.map(([, selector]) => selector).join(','),
        entitySelector,
        resolution,
        ...(time ? time.v2Query : {}),
      }, { label });
      if (!Array.isArray(data?.result)) throw new Error('Unexpected response from /rest/v2/metrics/query: no `result` array.');
      const metrics = format.metricSeries(data);
      return new Map(pairs.map(([key, selector], index) => [key, (metrics.find(metric => metric.metricId === selector) || metrics[index])?.series || []]));
    }

    async function queryMetricsForEntities(selectors, ids, { selector = idSelector, ...options } = {}) {
      const results = await Promise.all(chunkIds(ids, selector).map(chunk => queryMetrics(selectors, { ...options, entitySelector: selector(chunk) })));
      const merged = new Map();
      for (const result of results) {
        for (const [key, series] of result) merged.set(key, [...(merged.get(key) || []), ...series]);
      }
      return merged;
    }

    async function metricUnits(metricIds, { label = 'Reading metric units' } = {}) {
      const ids = [...new Set((metricIds || []).map(id => format.metricSelector.key(id)))];
      const { value, note } = await attempt(async () => (await v2List('/rest/v2/metrics', { metricSelector: ids.join(','), fields: 'unit' }, { itemsKey: 'metrics', limit: 500, label })).items, []);
      const units = new Map(value.filter(metric => typeof metric?.metricId === 'string').map(metric => [metric.metricId, metric.unit]));
      const assumed = new Map();
      const unit = (metricId, assumedUnit = null) => {
        const id = format.metricSelector.key(metricId);
        const known = units.get(id);
        if (known && known !== 'Unspecified') return known;
        if (!(units.has(id) && PLAIN_UNITS.includes(assumedUnit))) assumed.set(id, assumedUnit);
        return assumedUnit;
      };
      return {
        units,
        unit,
        formatter: (metricId, assumedUnit = null) => format.formatterForUnit(unit(metricId, assumedUnit)),
        note: () => (assumed.size
          ? `_Unit assumed, because Dynatrace's metric descriptor ${note ? 'could not be read' : 'names none'}: ${[...assumed].map(([id, assumedUnit]) => `\`${id}\` as ${assumedUnit || 'a plain number'}`).join(', ')}.${note ? ` (${note})` : ''}_`
          : null),
      };
    }

    function requestRow(contributor) {
      const metrics = contributor.metrics || {};
      const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
      const pick = (name) => (isNumber(metrics[`server${name}`]) ? metrics[`server${name}`] : metrics[`client${name}`]);
      return {
        id: contributor.id,
        name: contributor.name,
        databaseStatement: contributor.databaseStatement === true,
        unreliable: contributor.unreliableMetrics === true,
        calls: pick('LoadTotalValue'),
        avg: pick('ResponseTimeAvgValue'),
        median: pick('ResponseTime50Value'),
        p90: pick('ResponseTime90Value'),
        max: pick('ResponseTimeMaxValue'),
        total: pick('ResponseTimeSumValue'),
        failureRate: pick('FailureRateAvg'),
        cpu: metrics.cpuTimeTotalValue,
        http4xx: metrics.http4xxTotalValue,
        http5xx: metrics.http5xxTotalValue,
      };
    }

    async function serviceRequests(service, { filter = {}, time, label = null } = {}) {
      const data = await get('/rest/services/servicecontributor', {
        sci: service.entityId,
        servicefilter: servicefilter.encodeServiceFilter(filter),
        ...time.analysisQuery,
      }, { label: label || `Requests of ${service.displayName}` });
      format.expectShape(data, ['topContributors[]', 'topContributors[].id', 'topContributors[].name', 'topContributors[].metrics'], 'GET /rest/services/servicecontributor');
      const sampled = typeof data.maxSampleRate === 'number' && data.maxSampleRate !== 1 && data.maxSampleRate !== 0;
      const warnings = [
        data.partialResultFromAnalyzer === true ? 'Dynatrace returned a partial result' : null,
        data.skippedContributors > 0 ? `Dynatrace skipped ${data.skippedContributors} further rows` : null,
        sampled ? `traces are sampled (sample rate ${data.maxSampleRate})` : null,
      ].filter(Boolean);
      return { data, rows: data.topContributors.map(requestRow), warnings, skipped: data.skippedContributors > 0 ? data.skippedContributors : 0 };
    }

    async function resolveFilter(filterArgs = args, { service = null, time = null } = {}) {
      const request = typeof filterArgs.request === 'string' ? filterArgs.request.trim() : '';
      if (!request || servicefilter.isRequestReference(request) || !service) return servicefilter.serviceFilterFromArgs(filterArgs);
      const input = servicefilter.serviceFilterFromArgs({ ...filterArgs, request: undefined });
      const { rows } = await serviceRequests(service, { time, label: `Finding request "${format.truncate(request, 40)}" of ${service.displayName}` });
      const { match, candidates } = servicefilter.matchRequest(rows, request);
      const listed = (list) => format.cap(list, 15).shown.map(c => `- \`${c.id}\` ${format.truncate(format.oneLine(c.name), 160)}`).join('\n');
      if (!match && candidates.length === 0) {
        const known = rows.length
          ? ` Its requests in this window${rows.length > 15 ? ` (15 of ${rows.length})` : ''}:\n${listed(rows)}`
          : ' It handled no requests in this window; widen the time window.';
        throw new Error(`No request of ${service.displayName} (${service.entityId}) matches "${request}".${known}`);
      }
      if (!match) {
        throw new Error(`"${request}" matches ${candidates.length} requests of ${service.displayName} (${service.entityId}). Pass the name or id of the one you mean as \`request\`:\n${listed(candidates)}${candidates.length > 15 ? `\n- … ${candidates.length - 15} more` : ''}`);
      }
      if (match.id.startsWith('SERVICE_METHOD_GROUP-')) {
        if (input.requestGroup && input.requestGroup.id !== match.id) throw new Error('`request` and `request_group_id` name two different request groups; pass one of them');
        return { ...input, requestGroup: { id: match.id, name: match.name } };
      }
      return { ...input, requestId: match.id, requestName: format.truncate(format.oneLine(match.name), 80) };
    }

    function scopeToService(filter, service) {
      if (!service) return filter;
      const database = service.properties?.serviceType === 'DATABASE_SERVICE' && !filter.requestKind;
      return { ...filter, ...(database ? { requestKind: 'database' } : {}), serviceName: service.displayName };
    }

    async function mda({ metric = 'RESPONSE_TIME', dimension = '{Request:Name}', filter = {}, service = null, mergeServices = false, timeseries = false, percentile, aggregation, requestAttributeId, time, label = null }) {
      const endpoint = 'GET /rest/mda2';
      const encoded = servicefilter.encodeServiceFilter(scopeToService(filter, service));
      const merged = !service && mergeServices === true;
      const data = await get('/rest/mda2', {
        metric,
        dimension,
        percentile,
        aggregation,
        requestAttributeId,
        timeseries: timeseries === true,
        mergeServices: merged,
        servicefilter: encoded,
        ...time.analysisQuery,
      }, { label: label || `${metric} by ${dimension}${service ? ` of ${service.displayName}` : ''}` });
      format.expectShape(data, ['analysisResult.dimensions[]', 'analysisResult.dimensions[].totals'], endpoint);
      const result = data.analysisResult;
      const all = result.dimensions.map((dimensionRow) => {
        const parts = Array.isArray(dimensionRow.uiMda2DimensionParts) ? dimensionRow.uiMda2DimensionParts : [];
        return {
          name: dimensionRow.name !== undefined && dimensionRow.name !== null && dimensionRow.name !== '' ? String(dimensionRow.name) : '(empty)',
          id: parts.map(part => part?.id).find(id => isEntityId(id)) || null,
          parts,
          serviceId: dimensionRow.serviceId || null,
          totals: dimensionRow.totals || {},
          timeseries: dimensionRow.timeseries || null,
          unreliable: dimensionRow.unreliableMetrics === true,
        };
      });
      const own = service ? all.filter(row => !row.serviceId || row.serviceId === service.entityId) : all;
      const rows = own.filter(row => Object.keys(row.totals).length > 0);
      const total = result.unlimitedDimensionCount;
      return {
        data,
        result,
        rows,
        unit: result.unit,
        merged,
        servicefilter: encoded,
        foreign: all.length - own.length,
        withoutTotals: own.length - rows.length,
        returned: all.length,
        total: typeof total === 'number' && total > all.length ? total : all.length,
        capNote: typeof total === 'number' && total > all.length ? `Dynatrace returned only its top ${all.length} of ${format.count(total)} values` : null,
        omittedUnreliable: typeof result.omittedUnreliableDimensionsCount === 'number' ? result.omittedUnreliableDimensionsCount : 0,
        serviceNames: result.displayNames && typeof result.displayNames === 'object' ? result.displayNames : {},
        serviceTypes: Object.fromEntries(Object.entries(result.serviceEntities && typeof result.serviceEntities === 'object' ? result.serviceEntities : {}).map(([id, entity]) => [id, entity?.serviceType || null])),
        warnings: format.analysisWarnings(data.serviceAnalysisResultMetadata, data.serviceAnalysisResultDebugInfo || result.serviceAnalysisDebugInfo),
      };
    }

    const entities = createEntityHelpers({ dt, v2List });

    return {
      toolName,
      args,
      dt,
      get,
      v2List,
      environments: () => bridge.environments(),
      environment,
      status: () => ({ ...bridge.status(), serverVersion: version, mcpPort }),
      time: (timeArgs = args, defaultLookback = DEFAULT_LOOKBACK_MINUTES) => resolveTime(timeArgs, defaultLookback),
      limit: clampLimit,
      number: numberArgument,
      servicefilter: {
        encode: servicefilter.encodeServiceFilter,
        decode: servicefilter.decodeServiceFilter,
        describe: servicefilter.describeServiceFilter,
        fromArgs: servicefilter.serviceFilterFromArgs,
        resolve: resolveFilter,
        TYPES: servicefilter.FILTER_TYPES,
      },
      metrics: { query: queryMetrics, queryForEntities: queryMetricsForEntities, units: metricUnits },
      mda,
      serviceRequests,
      attempt,
      format,
      schema,
      entities,
      link: (route, options = {}) => format.deepLink(environment(options.environment), route, options),
      header: (title, options = {}) => format.header(title, { ...options, environment: environment(options.environment)?.name ?? args.environment ?? null }),
      expectShape: format.expectShape,
      BridgeError,
    };
  };
}
