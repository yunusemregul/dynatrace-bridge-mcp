import { BRIDGE_NOTE, maskNamed, metricSelector, plural, refId, refLabel, tag as describeTag } from '../format.js';
import { defineTools } from '../context.js';

export const order = 10;

const SERVICE_DIMENSION = 'dt.entity.service';
const BY_SERVICE = metricSelector.splitBy(SERVICE_DIMENSION);
const RESPONSE_TIME = 'builtin:service.response.time';
const FAILURE_RATE = 'builtin:service.errors.total.rate';
const REQUEST_COUNT = 'builtin:service.requestCount.total';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const given = (value) => typeof value === 'string' && value.trim() !== '';
const clean = (value) => (given(value) ? value.trim() : '');
const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lower = (value) => String(value ?? '').toLowerCase();

function relatedIds(relationships, relation, type = null) {
  const targets = Array.isArray(relationships?.[relation]) ? relationships[relation] : [];
  return targets
    .filter(target => !type || (typeof target === 'string' ? target.startsWith(`${type}-`) : target?.type === type))
    .map(target => (typeof target === 'string' ? target : target?.id))
    .filter(Boolean);
}

function technologyNames(entity) {
  const properties = entity.properties || {};
  const named = Array.isArray(properties.serviceTechnologyTypes) ? properties.serviceTechnologyTypes : [];
  if (named.length) return named;
  return properties.agentTechnologyType ? [properties.agentTechnologyType] : [];
}

function technologyTerms(entity) {
  const software = Array.isArray(entity.properties?.softwareTechnologies) ? entity.properties.softwareTechnologies.map(t => t?.type) : [];
  return [...technologyNames(entity), entity.properties?.agentTechnologyType, ...software].filter(Boolean).map(squash);
}

const SERVICE_TYPES = [
  'WEB_REQUEST_SERVICE', 'WEB_SERVICE', 'DATABASE_SERVICE', 'BACKGROUND_ACTIVITY', 'CUSTOM_SERVICE', 'MESSAGING_SERVICE', 'QUEUE_LISTENER_SERVICE',
  'RMI_SERVICE', 'RPC_SERVICE', 'CICS_SERVICE', 'IMS_SERVICE', 'ENTERPRISE_SERVICE_BUS_SERVICE', 'IBM_INTEGRATION_BUS_SERVICE', 'EXTERNAL',
];

function knownServiceType(text) {
  const wanted = squash(text);
  const exact = SERVICE_TYPES.filter(type => squash(type) === wanted || squash(type) === `${wanted}service`);
  if (exact.length === 1) return exact[0];
  const partial = SERVICE_TYPES.filter(type => squash(type).includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

function firstSeries(series) {
  const entry = series?.[0];
  return { timestamps: entry?.timestamps || [], values: entry?.values || [] };
}

function singleValue(series) {
  return firstSeries(series).values.find(isNumber);
}

function perMinute(requests, time, format) {
  return isNumber(requests) ? `${format.number(requests / (time.durationMs / 60000))}/min` : '-';
}

const LIST_SELECTORS = [
  ['avg', `${RESPONSE_TIME}${BY_SERVICE}:avg`],
  ['p90', `${RESPONSE_TIME}${BY_SERVICE}:percentile(90)`],
  ['failureRate', `${FAILURE_RATE}${BY_SERVICE}:avg`],
  ['requests', `${REQUEST_COUNT}${BY_SERVICE}:value`],
];

const SERVICE_SORTS = {
  throughput: { label: 'throughput', value: row => row.requests },
  response_time: { label: 'average response time', value: row => row.avg },
  p90: { label: 'p90 response time', value: row => row.p90 },
  failure_rate: { label: 'failure rate', value: row => row.failureRate },
  name: { label: 'name', value: null },
};

const listServices = {
  name: 'list_services',
  description: [
    'Lists the services Dynatrace monitors with their key numbers for the time window: average and p90 response time, failure rate, request count and requests per minute. Use it to find a service id, to see which services are slow, failing or busy, and as the starting point of any service investigation.',
    '',
    'Filter with `name` (case-insensitive substring), `service_type` (WEB_REQUEST_SERVICE, WEB_SERVICE, DATABASE_SERVICE, BACKGROUND_ACTIVITY, CUSTOM_SERVICE, …; a part such as "database" is enough), `technology` (Java, Node JS, Nginx, Apache, SQL Server, …) and `tag` (exactly as Dynatrace shows it, case-sensitive: `key:value`, or `key` for a tag without a value). `sort` picks the ranking: throughput (default), response_time, p90, failure_rate (all highest first) or name.',
    '',
    'Start here for "which services are slow / failing / busy": `sort: "response_time"`, `"failure_rate"` or `"throughput"`. Several services can share one name (one per process group); the ids tell them apart. Follow up with `service_overview` for one service.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Case-insensitive substring of the service name.' },
      service_type: { type: 'string', description: 'Service type or a part of it, e.g. WEB_REQUEST_SERVICE, DATABASE_SERVICE, BACKGROUND_ACTIVITY, "database".' },
      technology: { type: 'string', description: 'Technology of the service, e.g. Java, Node JS, Nginx, Apache, SQL Server.' },
      tag: { type: 'string', description: 'A tag the service must carry, case-sensitive: `key:value`, or `key` for a tag without a value.' },
      sort: { type: 'string', enum: Object.keys(SERVICE_SORTS), description: 'Ranking: throughput (default), response_time, p90, failure_rate, name.' },
      limit: ctx.schema.limit(25, 'services', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 25, 200);
    const sortKey = clean(args.sort).toLowerCase() || 'throughput';
    const sort = SERVICE_SORTS[sortKey];
    if (!sort) throw new Error(`unknown \`sort\` "${args.sort}". Use one of: ${Object.keys(SERVICE_SORTS).join(', ')}.`);
    const name = clean(args.name);
    const serviceType = clean(args.service_type);
    const technology = clean(args.technology);
    const tag = clean(args.tag);

    const exactType = serviceType ? knownServiceType(serviceType) : null;
    const selector = [
      'type("SERVICE")',
      name ? `entityName.contains(${ctx.entities.quote(name)})` : null,
      exactType ? `serviceType(${ctx.entities.quote(exactType)})` : null,
      tag ? `tag(${ctx.entities.quote(tag)})` : null,
    ].filter(Boolean).join(',');
    const { entities, totalCount } = await ctx.entities.list(selector, { fields: ['properties', 'tags'], time, limit: 2000, label: `Listing services${name ? ` named "${name}"` : ''}` });
    const matched = entities.filter(entity => (
      (!serviceType || exactType || squash(entity.properties?.serviceType).includes(squash(serviceType)))
      && (!technology || technologyTerms(entity).some(term => term.includes(squash(technology))))
    ));

    const filters = [
      name ? `name contains "${name}"` : null,
      serviceType ? `type ${exactType || serviceType}` : null,
      technology ? `technology ${technology}` : null,
      tag ? `tag ${tag}` : null,
    ];
    const link = ctx.link('ui/services', { time });
    if (matched.length === 0) {
      return format.sections(
        ctx.header('Services', { time, details: [...filters, '0 of 0'] }),
        '_No services matched in this window._ Loosen `name`, `service_type`, `technology` or `tag`, or widen the time window (only services seen in the window are listed).',
        format.footer({ link }),
      );
    }

    const metrics = await ctx.metrics.query(LIST_SELECTORS, { entitySelector: selector, resolution: 'Inf', time, label: 'Reading service metrics' });
    const values = Object.fromEntries(LIST_SELECTORS.map(([key]) => [key, format.valueByDimension(metrics.get(key), SERVICE_DIMENSION)]));
    const services = matched.map(entity => ({
      entity,
      avg: values.avg.get(entity.entityId),
      p90: values.p90.get(entity.entityId),
      failureRate: values.failureRate.get(entity.entityId),
      requests: values.requests.get(entity.entityId),
    }));
    const byName = (a, b) => a.entity.displayName.localeCompare(b.entity.displayName);
    services.sort(sort.value
      ? (a, b) => (sort.value(b) ?? -Infinity) - (sort.value(a) ?? -Infinity) || byName(a, b)
      : byName);

    const { shown, omitted } = format.cap(services, limit);
    const rows = shown.map(s => [
      s.entity.entityId,
      s.entity.displayName,
      s.entity.properties?.serviceType || '',
      technologyNames(s.entity).join(', '),
      format.duration(s.avg),
      format.duration(s.p90),
      format.percent(s.failureRate),
      format.count(s.requests),
      perMinute(s.requests, time, format),
    ]);
    return format.sections(
      ctx.header('Services', { time, details: [...filters, `${shown.length} of ${matched.length}`, `sorted by ${sort.label}`] }),
      format.table(['id', 'service', 'type', 'technology', 'avg response time', 'p90', 'failure rate', 'requests', 'throughput'], rows),
      format.omittedNote(omitted),
      totalCount > entities.length ? `_Only the first ${entities.length} of ${totalCount} services were read; narrow \`name\` to cover the rest._` : null,
      'A `-` means the service handled no requests in the window.',
      format.footer({
        next: 'call `service_overview` with `service` set to an id from the table for percentiles, trend, dependencies, hosts and problems.',
        link,
      }),
    );
  },
};

function propertyText(value, ctx, max = 200) {
  const { format } = ctx;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item && typeof item === 'object') {
        if (typeof item.type === 'string') return [item.type, item.edition, item.version].filter(Boolean).join(' ');
        if (typeof item.id === 'string') return item.id;
        if (typeof item.name === 'string') return item.name;
        return JSON.stringify(item);
      }
      return String(item);
    });
    const { shown, omitted } = format.cap(items, 8);
    return format.truncate(`${shown.join(', ')}${omitted ? ` (+${omitted} more)` : ''}`, max);
  }
  return format.truncate(typeof value === 'object' ? JSON.stringify(value) : value, max);
}

function namedIds(ids, names, limit, ctx) {
  const { shown, omitted } = ctx.format.cap(ids, limit);
  const listed = shown.map(id => (names.has(id) ? `\`${id}\` ${names.get(id)}` : `\`${id}\``));
  return `${listed.join(', ')}${omitted ? `, +${omitted} more` : ''}`;
}

function trendTable(series, time, format, buckets = 12) {
  const range = { fromMs: time.fromMs, toMs: time.toMs };
  const grids = {
    responseTime: format.downsample(series.responseTime.timestamps, series.responseTime.values, buckets, range),
    failureRate: format.downsample(series.failureRate.timestamps, series.failureRate.values, buckets, range),
    requests: format.downsample(series.requests.timestamps, series.requests.values, buckets, range),
  };
  const length = Math.max(grids.responseTime.length, grids.failureRate.length, grids.requests.length);
  const rows = [];
  for (let i = 0; i < length; i++) {
    const cells = [grids.responseTime[i], grids.failureRate[i], grids.requests[i]];
    if (!cells.some(cell => cell?.points)) continue;
    const from = cells.find(Boolean).from;
    rows.push([
      format.bucketLabel(from, time.durationMs),
      cells[0]?.points ? format.duration(cells[0].avg) : '',
      cells[1]?.points ? format.percent(cells[1].avg) : '',
      cells[2]?.points ? format.count(Math.round(cells[2].avg * cells[2].points)) : '',
    ]);
  }
  return format.table(['time (UTC)', 'avg response time', 'failure rate', 'requests'], rows);
}

function problemEnd(problem) {
  return isNumber(problem.endTime) && problem.endTime > 0 ? problem.endTime : null;
}

function problemDuration(problem, format) {
  if (!isNumber(problem.startTime)) return '-';
  return format.durationMs((problemEnd(problem) ?? Date.now()) - problem.startTime);
}

const POD_LIMIT = 50;

async function podsOfWorkloads(ctx, workloadIds, time) {
  if (workloadIds.length === 0) return { entities: [], totalCount: 0 };
  const { entities, totalCount } = await ctx.entities.listByIds(workloadIds, {
    selector: ids => `type("CLOUD_APPLICATION_INSTANCE"),fromRelationships.isInstanceOf(${ctx.entities.idSelector(ids)})`,
    fields: ['properties'],
    time,
    limit: POD_LIMIT,
    label: 'Listing the pods of the service',
  });
  return { entities: entities.slice(0, POD_LIMIT), totalCount };
}

const OVERVIEW_TOTALS = [
  ['p50', `${RESPONSE_TIME}${BY_SERVICE}:percentile(50)`],
  ['p90', `${RESPONSE_TIME}${BY_SERVICE}:percentile(90)`],
  ['p99', `${RESPONSE_TIME}${BY_SERVICE}:percentile(99)`],
  ['avg', `${RESPONSE_TIME}${BY_SERVICE}:avg`],
  ['failureRate', `${FAILURE_RATE}${BY_SERVICE}:avg`],
  ['requests', `${REQUEST_COUNT}${BY_SERVICE}:value`],
];

const OVERVIEW_TREND = [
  ['responseTime', `${RESPONSE_TIME}${BY_SERVICE}:avg`],
  ['failureRate', `${FAILURE_RATE}${BY_SERVICE}:avg`],
  ['requests', `${REQUEST_COUNT}${BY_SERVICE}:value`],
];

const SHOWN_SERVICE_PROPERTIES = ['serviceType', 'serviceTechnologyTypes'];

const serviceOverview = {
  name: 'service_overview',
  description: [
    'Everything about one service in one call: type, technology, tags and properties; response time p50 / p90 / p99 / average, failure rate and throughput for the window, with a compact trend over time; the services it calls and the services that call it; the process groups, hosts, Kubernetes workloads and pods it runs on; and the Dynatrace problems that affected it in the window.',
    '',
    'Pass `service` as an id (SERVICE-1234567890ABCDEF) or a name; an ambiguous name returns the candidates. Find services with `list_services`.',
    'Then drill down with the same `service` and time window: `list_service_requests` (its endpoints), `list_traces` (individual requests), `analyze_failures`, `analyze_response_time`, `service_flow` (downstream), `service_backtrace` (upstream), and `get_problem` for a listed problem.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: ctx.schema.entity('The service', 'SERVICE-1234567890ABCDEF'),
      relationship_limit: { type: 'number', description: 'Maximum related entities listed per relationship (called services, callers, hosts, …). Default 10, at most 50.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const relationshipLimit = ctx.limit(args.relationship_limit, 10, 50, 'relationship_limit');
    const service = await ctx.entities.service(args.service, { fields: ['properties', 'tags', 'managementZones', 'fromRelationships', 'toRelationships'], time });
    const id = service.entityId;
    const scope = `entityId(${ctx.entities.quote(id)})`;

    const groups = {
      calls: relatedIds(service.fromRelationships, 'calls'),
      calledBy: relatedIds(service.toRelationships, 'calls'),
      processGroups: relatedIds(service.fromRelationships, 'runsOn', 'PROCESS_GROUP'),
      hosts: relatedIds(service.fromRelationships, 'runsOnHost', 'HOST'),
      workloads: relatedIds(service.fromRelationships, 'isServiceOf', 'CLOUD_APPLICATION'),
    };
    const nameIds = Object.values(groups).flatMap(ids => ids.slice(0, relationshipLimit));

    const [totals, trend, names, problems, pods] = await Promise.all([
      ctx.metrics.query(OVERVIEW_TOTALS, { entitySelector: scope, resolution: 'Inf', time, label: `Reading the key metrics of ${service.displayName}` }),
      ctx.metrics.query(OVERVIEW_TREND, { entitySelector: scope, time, label: `Reading the metric trend of ${service.displayName}` }),
      ctx.entities.names(nameIds, { time }),
      ctx.v2List('/rest/v2/problems', { entitySelector: scope, sort: '-startTime', ...time.v2Query }, { itemsKey: 'problems', limit: 20, label: `Reading problems of ${service.displayName}` }),
      podsOfWorkloads(ctx, groups.workloads.slice(0, relationshipLimit), time),
    ]);

    const properties = service.properties || {};
    const summary = [
      `- Id: \`${id}\``,
      properties.serviceType ? `- Type: ${properties.serviceType}` : null,
      technologyNames(service).length ? `- Technology: ${technologyNames(service).join(', ')}` : null,
      service.tags?.length ? `- Tags: ${service.tags.map(describeTag).join(', ')}` : null,
      service.managementZones?.length ? `- Management zones: ${service.managementZones.map(z => z.name || z.id).join(', ')}` : null,
      ...Object.keys(properties).filter(key => !SHOWN_SERVICE_PROPERTIES.includes(key)).sort()
        .map(key => `- ${key}: ${propertyText(maskNamed(key, properties[key], { opaque: false }), ctx)}`),
    ].filter(Boolean).join('\n');

    const requests = singleValue(totals.get('requests'));
    const hasTraffic = OVERVIEW_TOTALS.some(([key]) => isNumber(singleValue(totals.get(key))));
    const metrics = hasTraffic
      ? [
        `- Response time: p50 ${format.duration(singleValue(totals.get('p50')))} · p90 ${format.duration(singleValue(totals.get('p90')))} · p99 ${format.duration(singleValue(totals.get('p99')))} · avg ${format.duration(singleValue(totals.get('avg')))}`,
        `- Failure rate: ${format.percent(singleValue(totals.get('failureRate')))}`,
        `- Throughput: ${format.count(requests)} requests (${perMinute(requests, time, format)})`,
      ].join('\n')
      : '_No requests were recorded for this service in the window._';

    const series = {
      responseTime: firstSeries(trend.get('responseTime')),
      failureRate: firstSeries(trend.get('failureRate')),
      requests: firstSeries(trend.get('requests')),
    };
    const hasTrend = Object.values(series).some(s => s.values.some(isNumber));
    const stats = (entry) => format.seriesStats(entry.timestamps, entry.values);
    const trendBlock = hasTrend
      ? [
        [
          format.statsLine('Response time (avg)', stats(series.responseTime), format.duration),
          format.statsLine('Failure rate', stats(series.failureRate), format.percent),
          format.statsLine('Requests per data point', stats(series.requests), format.count),
        ].join('\n'),
        trendTable(series, time, format),
      ].join('\n\n')
      : null;

    const dependencyLine = (label, ids) => (ids.length ? `- ${label} (${ids.length}): ${namedIds(ids, names, relationshipLimit, ctx)}` : `- ${label}: none seen`);
    const runsOn = [
      groups.processGroups.length ? `- Process groups (${groups.processGroups.length}): ${namedIds(groups.processGroups, names, relationshipLimit, ctx)}` : null,
      groups.hosts.length ? `- Hosts (${groups.hosts.length}): ${namedIds(groups.hosts, names, relationshipLimit, ctx)}` : null,
      groups.workloads.length ? `- Kubernetes workloads (${groups.workloads.length}): ${namedIds(groups.workloads, names, relationshipLimit, ctx)}` : null,
    ].filter(Boolean);
    const podRows = pods.entities.map(pod => [
      pod.entityId,
      pod.displayName,
      pod.properties?.cloudApplicationInstancePhase ?? '',
      format.count(pod.properties?.containerRestartCount),
      pod.properties?.nodeName ?? '',
    ]);

    const sortedProblems = [...problems.items].sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN') || (b.startTime || 0) - (a.startTime || 0));
    const problemRows = sortedProblems.map(p => [
      p.displayId,
      p.title,
      p.severityLevel,
      p.status,
      format.utc(p.startTime),
      problemEnd(p) ? format.utc(problemEnd(p)) : 'still open',
      p.rootCauseEntity ? refLabel(p.rootCauseEntity) : '',
    ]);
    const quoted = `service: "${id}"`;
    return format.sections(
      ctx.header(`Service: ${service.displayName}`, { time, details: [id] }),
      summary,
      `## Key metrics\n\n${metrics}`,
      trendBlock ? `## Trend\n\n${trendBlock}` : null,
      `## Dependencies\n\n${[dependencyLine('Calls', groups.calls), dependencyLine('Called by', groups.calledBy)].join('\n')}`,
      names.note,
      runsOn.length ? `## Runs on\n\n${runsOn.join('\n')}` : null,
      podRows.length ? `## Pods\n\n${format.table(['id', 'pod', 'phase', 'restarts (lifetime)', 'node'], podRows)}` : null,
      format.omittedNote(pods.totalCount - podRows.length, 'call `list_pods` with a workload id to see them'),
      problemRows.length
        ? `## Problems affecting it in this window (${problems.totalCount})\n\n${format.table(['problem', 'title', 'severity', 'status', 'start (UTC)', 'end (UTC)', 'root cause'], problemRows)}`
        : '## Problems affecting it in this window\n\n_None._',
      format.omittedNote(problems.totalCount - problemRows.length, 'call `list_problems` with `entity_selector` to see them'),
      format.footer({
        next: [
          `with \`${quoted}\` and the same time window call \`list_service_requests\` (its endpoints with metrics), \`list_traces\` (single requests; add \`failed: true\` or \`response_time_min_ms\`), \`analyze_failures\` (why requests fail), \`analyze_response_time\` (where the time goes), \`service_flow\` (what it calls) or \`service_backtrace\` (who calls it).`,
          problemRows.length ? ' For a problem above call `get_problem` with its P- id.' : '',
        ].join(''),
        link: ctx.link('#smgd', { params: { sci: id }, time }),
      }),
    );
  },
};

function eventDetail(properties) {
  const reason = properties['dt.kubernetes.event.reason'];
  const message = properties['dt.kubernetes.event.message'] ?? properties['dt.event.description'];
  return [reason, message].filter(value => value !== undefined && value !== null && value !== '').join(': ');
}

function eventStatus(group) {
  if (group.open === 0) return 'closed';
  if (group.open === group.count) return 'open';
  return `${group.open} open, ${group.count - group.open} closed`;
}

function eventsLink(ctx, entitySelector, time) {
  const single = String(entitySelector || '').match(/^entityId\(\s*"?([A-Z][A-Z0-9_]*-[0-9A-F]{16})"?\s*\)$/);
  if (single) return ctx.link(`ui/entity/${single[1]}`, { time });
  const type = String(entitySelector || '').match(/type\(\s*"?([A-Za-z0-9_]+)"?\s*\)/);
  return type ? ctx.link(`ui/entity/list/${type[1].toUpperCase()}`, { time }) : ctx.link('ui/problems', { time });
}

const listEvents = {
  name: 'list_events',
  description: [
    'Lists Dynatrace events in a time window: deployments, process restarts, Kubernetes events (probe failures, kills, scheduling), availability and anomaly events (error rate or response time increase, CPU saturation), custom info and annotations. Identical events (same type, title, entity and Kubernetes reason) are collapsed into one row with a count and the first and last time, so a flapping probe is one line.',
    '',
    'Scope it with `entity_selector` (entitySelector syntax, e.g. `entityId("SERVICE-1234567890ABCDEF")`, `type(CLOUD_APPLICATION_INSTANCE),fromRelationships.isInstanceOf(entityId("CLOUD_APPLICATION-1234567890ABCDEF"))` for the pods of a workload, `type(HOST)`), `event_type` (e.g. CUSTOM_DEPLOYMENT, PROCESS_RESTART, SERVICE_ERROR_RATE_INCREASED, CUSTOM_INFO) and `status` (open / closed). `event_selector` takes a raw Dynatrace eventSelector instead, e.g. `property.dt.kubernetes.event.reason("Unhealthy")`. Without any filter it lists every event of the environment in the window.',
    '',
    'Use it to answer "what changed" around the time something broke; then `get_entity` or `service_overview` on an entity id, or `list_problems` for the same window.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      entity_selector: { type: 'string', description: 'Dynatrace entitySelector limiting the entities the events belong to, e.g. `entityId("HOST-1234567890ABCDEF")` or `type(SERVICE),entityName.contains("checkout")`.' },
      event_type: { type: 'string', description: 'Event type, e.g. CUSTOM_DEPLOYMENT, CUSTOM_INFO, PROCESS_RESTART, SERVICE_ERROR_RATE_INCREASED, SERVICE_SLOWDOWN, MARKED_FOR_TERMINATION.' },
      status: { type: 'string', enum: ['open', 'closed'], description: 'Only events that are still open, or only closed ones. Default: both.' },
      event_selector: { type: 'string', description: 'Raw Dynatrace eventSelector, used verbatim instead of `event_type` and `status`.' },
      limit: ctx.schema.limit(30, 'event groups', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 30, 200);
    const entitySelector = clean(args.entity_selector) || undefined;
    const status = clean(args.status).toLowerCase();
    if (status && status !== 'open' && status !== 'closed') throw new Error(`unknown \`status\` "${args.status}". Use open or closed.`);
    const eventType = clean(args.event_type).toUpperCase();
    const eventSelector = clean(args.event_selector) || [
      eventType ? `eventType(${ctx.entities.quote(eventType)})` : null,
      status ? `status("${status.toUpperCase()}")` : null,
    ].filter(Boolean).join(',') || undefined;

    const { items, totalCount } = await ctx.v2List('/rest/v2/events', { entitySelector, eventSelector, ...time.v2Query }, { itemsKey: 'events', limit: 1000, label: `Listing events${entitySelector ? ` of ${format.truncate(entitySelector, 50)}` : ''}` });
    const groups = format.groupEvents(items, event => [event.eventType, event.title, refId(event.entityId), format.eventProperties(event)['dt.kubernetes.event.reason'] ?? null]);
    const { shown, omitted } = format.cap(groups, limit);
    const rows = shown.map(group => [
      group.count,
      group.latest.eventType,
      format.truncate(group.latest.title, 80),
      refLabel(group.latest.entityId),
      eventStatus(group),
      format.utc(group.first),
      group.count > 1 ? format.utc(group.last) : '',
      format.truncate(eventDetail(format.eventProperties(group.latest)), 160),
    ]);
    const details = [
      entitySelector ? `entities \`${entitySelector}\`` : null,
      eventSelector ? `events \`${eventSelector}\`` : null,
      `${plural(items.length, 'event')} in ${plural(groups.length, 'group')}`,
    ];
    return format.sections(
      ctx.header('Events', { time, details }),
      rows.length
        ? format.table(['count', 'type', 'title', 'entity', 'status', 'first (UTC)', 'last (UTC)', 'detail'], rows)
        : '_No events in this window._ Widen the time window, loosen `entity_selector`, or drop `event_type` / `status`.',
      format.omittedNote(omitted, 'groups ordered by latest occurrence; raise `limit` or narrow the filter to see them'),
      totalCount > items.length ? `_Only the newest ${items.length} of ${totalCount} events were read; narrow the window or the filters to cover the rest._` : null,
      format.footer({
        next: rows.length ? 'call `get_entity` (or `service_overview` for a SERVICE id) on an entity id from the table, or `list_problems` for the same window to see what Dynatrace raised.' : null,
        link: eventsLink(ctx, entitySelector, time),
      }),
    );
  },
};

const PROBLEM_STATUS = ['open', 'closed', 'all'];
const IMPACT_LEVELS = ['APPLICATION', 'ENVIRONMENT', 'INFRASTRUCTURE', 'SERVICES'];
const SEVERITY_LEVELS = ['AVAILABILITY', 'ERROR', 'PERFORMANCE', 'RESOURCE_CONTENTION', 'CUSTOM_ALERT', 'MONITORING_UNAVAILABLE', 'INFO'];

function enumArgument(value, allowed, name) {
  const wanted = clean(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (!wanted) return null;
  if (!allowed.includes(wanted)) throw new Error(`unknown \`${name}\` "${value}". Use one of: ${allowed.join(', ')}.`);
  return wanted;
}

function problemMatchesText(problem, needle) {
  const haystack = [
    problem.displayId,
    problem.title,
    problem.problemId,
    refLabel(problem.rootCauseEntity),
    ...(problem.affectedEntities || []).map(refLabel),
    ...(problem.impactedEntities || []).map(refLabel),
  ];
  return haystack.some(value => lower(value).includes(needle));
}

const listProblems = {
  name: 'list_problems',
  description: [
    'Lists the problems Dynatrace (Davis) raised that were active in the time window: display id (P-…), internal problem id, title, severity, impact level, status, start, end, duration, root cause entity and how many entities were affected and impacted.',
    '',
    'Filter by `status` (open / closed / all), `impact_level` (SERVICES, INFRASTRUCTURE, APPLICATION, ENVIRONMENT), `severity` (AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, …), `entity_selector` (e.g. `entityId("SERVICE-1234567890ABCDEF")` or `type(HOST)`) and `text` (case-insensitive, matched against id, title and entity names). An open problem that started before the window is included.',
    '',
    'Start here for "what is wrong right now" or "what happened at that time". Follow up with `get_problem` (pass the P- id) for evidence, Davis root cause and the dependency path.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      status: { type: 'string', enum: PROBLEM_STATUS, description: 'open, closed or all. Default all.' },
      impact_level: { type: 'string', enum: IMPACT_LEVELS, description: 'Only problems with this impact level.' },
      severity: { type: 'string', enum: SEVERITY_LEVELS, description: 'Only problems with this severity level.' },
      entity_selector: { type: 'string', description: 'Dynatrace entitySelector; only problems that affect or impact these entities, e.g. `entityId("SERVICE-1234567890ABCDEF")`.' },
      text: { type: 'string', description: 'Case-insensitive text matched against the display id, title, root cause and affected entity names.' },
      limit: ctx.schema.limit(25, 'problems', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 25, 200);
    const status = clean(args.status).toLowerCase() || 'all';
    if (!PROBLEM_STATUS.includes(status)) throw new Error(`unknown \`status\` "${args.status}". Use one of: ${PROBLEM_STATUS.join(', ')}.`);
    const impactLevel = enumArgument(args.impact_level, IMPACT_LEVELS, 'impact_level');
    const severity = enumArgument(args.severity, SEVERITY_LEVELS, 'severity');
    const entitySelector = clean(args.entity_selector) || undefined;
    const text = clean(args.text).toLowerCase();
    const problemSelector = [
      status !== 'all' ? `status("${status}")` : null,
      impactLevel ? `impactLevel("${impactLevel}")` : null,
      severity ? `severityLevel("${severity}")` : null,
    ].filter(Boolean).join(',') || undefined;

    const { items, totalCount } = await ctx.v2List('/rest/v2/problems', { problemSelector, entitySelector, sort: '-startTime', ...time.v2Query }, { itemsKey: 'problems', limit: text ? 500 : limit, label: 'Listing problems' });
    const matched = text ? items.filter(problem => problemMatchesText(problem, text)) : items;
    const { shown, omitted } = format.cap(matched, limit);
    const total = text ? matched.length : totalCount;
    const rows = shown.map(p => [
      p.displayId,
      p.problemId,
      p.title,
      p.severityLevel,
      p.impactLevel,
      p.status,
      format.utc(p.startTime),
      problemEnd(p) ? format.utc(problemEnd(p)) : 'still open',
      problemDuration(p, format),
      p.rootCauseEntity ? refLabel(p.rootCauseEntity) : '',
      (p.affectedEntities || []).length,
      (p.impactedEntities || []).length,
    ]);
    const details = [
      status !== 'all' ? status : null,
      impactLevel ? `impact ${impactLevel}` : null,
      severity ? `severity ${severity}` : null,
      entitySelector ? `entities \`${entitySelector}\`` : null,
      text ? `text "${clean(args.text)}"` : null,
      `${shown.length} of ${total}`,
    ];
    return format.sections(
      ctx.header('Problems', { time, details }),
      rows.length
        ? format.table(['problem', 'problem id', 'title', 'severity', 'impact', 'status', 'start (UTC)', 'end (UTC)', 'duration', 'root cause', 'affected', 'impacted'], rows)
        : '_No problems were active in this window._ Widen the time window (e.g. `minutes_lookback: 1440`) or loosen the filters.',
      format.omittedNote(Math.max(omitted, total - shown.length)),
      text && totalCount > items.length ? `_\`text\` was matched against the newest ${items.length} of ${totalCount} problems only._` : null,
      format.footer({
        next: rows.length ? 'call `get_problem` with a P- id from the table for evidence, the Davis root cause and the dependency path.' : null,
        link: ctx.link('ui/problems', { time }),
      }),
    );
  },
};

const INTERNAL_PROBLEM_ID = /^-?\d+_\d+V2$/;
const DISPLAY_PROBLEM_ID = /^(?:P-?)?(\d+)$/i;
const PROBLEM_FIELDS = '+evidenceDetails,+impactAnalysis,+recentComments';

async function resolveProblemId(reference, ctx) {
  const value = String(reference).trim();
  if (INTERNAL_PROBLEM_ID.test(value)) return value;
  const display = value.match(DISPLAY_PROBLEM_ID);
  if (!display) throw new Error(`"${value}" is neither a problem display id (P-12345) nor an internal problem id (e.g. -1234567890123456789_1790000000000V2). Find problems with list_problems.`);
  const displayId = `P-${display[1]}`;
  const data = await ctx.get('/rest/v2/problems', { problemSelector: `displayId("${displayId}")`, from: 'now-1y', pageSize: 5 }, { label: `Finding problem ${displayId}` });
  const found = (Array.isArray(data?.problems) ? data.problems : []).find(p => p.displayId === displayId);
  if (!found) throw new Error(`No problem ${displayId} found in the last year. Check the id with list_problems.`);
  return found.problemId;
}

async function readProblem(problemId, ctx) {
  try {
    return await ctx.get(`/rest/v2/problems/${problemId}`, { fields: PROBLEM_FIELDS }, { label: 'Reading the problem' });
  } catch (error) {
    if (error instanceof ctx.BridgeError && error.code === 'HTTP_ERROR' && (error.status === 404 || error.status === 400)) {
      throw new Error(`No problem \`${problemId}\` found. Check the id with list_problems.`);
    }
    throw error;
  }
}

function internalAnalysis(ctx, path, endpoint, shape, label) {
  return ctx.attempt(async () => ctx.expectShape(await ctx.get(path, {}, { label }), shape, endpoint));
}

function changeText(before, after, unit, format) {
  if (!isNumber(before) && !isNumber(after)) return '';
  const formatter = format.formatterForUnit(unit);
  return `${formatter(before)} → ${formatter(after)}`;
}

function evidenceRows(details, format) {
  return details.map(d => [
    d.evidenceType,
    d.displayName || d.eventType || '',
    refLabel(d.entity),
    d.rootCauseRelevant ? 'yes' : 'no',
    format.utc(d.startTime),
    isNumber(d.endTime) && d.endTime > 0 ? format.utc(d.endTime) : '',
    changeText(d.valueBeforeChangePoint, d.valueAfterChangePoint, d.unit, format),
  ]);
}

function impactLines(impacts, format) {
  return impacts.map((impact) => {
    const calls = impact.numberOfPotentiallyAffectedServiceCalls;
    const parts = [
      isNumber(impact.estimatedAffectedUsers) ? `${format.count(impact.estimatedAffectedUsers)} estimated affected users` : null,
      isNumber(calls) ? `${format.count(calls)} potentially affected service calls` : null,
    ].filter(Boolean);
    return `- ${impact.impactType}: ${refLabel(impact.impactedEntity)}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  });
}

function commentLines(comments, format) {
  return comments.map(c => `- ${format.utc(c.createdAtTimestamp)} ${c.authorName || 'unknown'}${c.context ? ` [${c.context}]` : ''}: ${format.truncate(String(c.content ?? '').replace(/\s+/g, ' '), 300)}`);
}

function findingText(finding, format) {
  if (!finding || typeof finding !== 'object') return String(finding);
  const kind = finding.evidenceType || finding.eventType || finding.type || finding.displayName || finding.title || 'finding';
  const label = [finding.displayName, finding.title].find(value => typeof value === 'string' && value !== kind);
  const change = changeText(finding.valueBeforeChangePoint, finding.valueAfterChangePoint, finding.unit, format);
  const span = isNumber(finding.startTime) ? `${format.utc(finding.startTime)}${isNumber(finding.endTime) && finding.endTime > 0 ? ` → ${format.utc(finding.endTime)}` : ''}` : '';
  return [kind, label, change, span].filter(Boolean).join(', ');
}

const FINDING_GROUPS = [
  ['metricLikeFindings', 'metric'],
  ['metricFindings', 'metric'],
  ['eventFindings', 'event'],
  ['availabilityFindings', 'availability'],
  ['logFindings', 'log'],
  ['maintenanceWindowFindings', 'maintenance window'],
];

function rootCauseLines(rootCauseList, format) {
  return rootCauseList.flatMap((candidate) => {
    const meta = candidate.rootCauseCandidateMetaInfo || {};
    const facts = [meta.entityType, meta.metadata?.SERVICE_TYPE, meta.metadata?.PROCESS_TYPE].filter(Boolean).join(', ');
    const head = `- ${meta.entityDisplayName || 'unnamed entity'} (\`${meta.entityId || '?'}\`${facts ? `, ${facts}` : ''})`;
    const findings = FINDING_GROUPS.flatMap(([key, label]) => (Array.isArray(candidate[key]) ? candidate[key] : [])
      .slice(0, 10)
      .map(finding => `  - ${label} finding: ${findingText(finding, format)}`));
    return [head, ...(findings.length ? findings : ['  - no detailed findings'])];
  });
}

function baselineText(event, format) {
  const properties = format.eventProperties(event);
  const metadata = format.eventProperties({ properties: event.metadata });
  const pretty = (value) => (/^-?\d+(\.\d+)?$/.test(String(value)) ? format.number(Number(value)) : String(value));
  const fromProperties = Object.keys(properties).filter(key => key.startsWith('dt.event.baseline.')).sort()
    .map(key => `${key.slice('dt.event.baseline.'.length)} ${pretty(properties[key])}`);
  if (fromProperties.length) return fromProperties.join(', ');
  return Object.keys(metadata).filter(key => key.startsWith('BL_')).sort()
    .map(key => `${key.slice(3).toLowerCase()} ${pretty(metadata[key])}`).join(', ');
}

function triggerLines(event, format) {
  const properties = format.eventProperties(event);
  const metadata = format.eventProperties({ properties: event.metadata });
  const description = properties['dt.event.description'] ?? metadata.DESCRIPTION;
  const end = isNumber(event.endTime) && event.endTime > 0 ? format.utc(event.endTime) : 'still open';
  const baseline = baselineText(event, format);
  return [
    `- ${event.eventType} on ${event.entityDisplayName || 'unnamed entity'} (\`${event.entityId || '?'}\`), ${format.utc(event.startTime)} → ${end}`,
    description ? `- Description: ${format.truncate(String(description).replace(/\s+/g, ' ').trim(), 400)}` : null,
    baseline ? `- Baseline values: ${baseline}` : null,
  ].filter(Boolean);
}

function affectedRequestLines(impactAnalysis, format) {
  const services = impactAnalysis?.serviceImpactMap && typeof impactAnalysis.serviceImpactMap === 'object' ? impactAnalysis.serviceImpactMap : {};
  return Object.entries(services).flatMap(([serviceId, impact]) => {
    const calls = impact?.numberOfPotentiallyAffectedServiceCalls;
    const head = `- ${impact?.displayName || 'service'} (\`${serviceId}\`)${isNumber(calls) ? `: ${format.count(calls)} potentially affected calls` : ''}`;
    const findings = (Array.isArray(impact?.findings) ? impact.findings : []).slice(0, 10).map((finding) => {
      const share = finding.fractionOfPotentiallyAffectedServiceCalls;
      return `  - ${finding.serviceMethodGroupName || 'request group'} (\`${finding.serviceMethodGroupId || '?'}\`)${isNumber(share) ? `: ${format.percent(share, { ratio: true })} of calls affected` : ''}`;
    });
    return [head, ...findings];
  });
}

function pathLine(node, marks, format) {
  const facts = [node.type, node.unifiedIcon?.primaryType, node.metadata?.SERVICE_TYPE].filter(Boolean).join(', ');
  const events = (Array.isArray(node.events) ? node.events : []).slice(0, 5)
    .map(event => `${event.eventType} ${format.utc(event.startTime)}${isNumber(event.endTime) && event.endTime > 0 ? ` → ${format.utc(event.endTime)}` : ''}`);
  const mark = marks.get(node.id);
  return `${node.displayName || node.shortenedDisplayName || 'unnamed'} (\`${node.id}\`${facts ? `, ${facts}` : ''})${mark ? ` — **${mark}**` : ''}${events.length ? ` — events: ${events.join('; ')}` : ''}`;
}

function problemMarks(problem, rootCauseList) {
  const marks = new Map();
  const add = (id, label) => {
    if (!id) return;
    const existing = marks.get(id);
    if (!existing) marks.set(id, label);
    else if (!existing.split(', ').includes(label)) marks.set(id, `${existing}, ${label}`);
  };
  for (const ref of problem.affectedEntities || []) add(refId(ref), 'affected');
  add(refId(problem.rootCauseEntity), 'root cause');
  for (const candidate of rootCauseList) add(candidate.rootCauseCandidateMetaInfo?.entityId, 'root cause');
  return marks;
}

function firstService(problem) {
  const refs = [...(problem.affectedEntities || []), ...(problem.impactedEntities || []), problem.rootCauseEntity].filter(Boolean);
  return refs.find(ref => String(refId(ref)).startsWith('SERVICE-')) || null;
}

function problemNext(problem) {
  const end = problemEnd(problem);
  const windowArgs = isNumber(problem.startTime)
    ? `\`time_from: "${new Date(problem.startTime).toISOString()}"\`${end ? `, \`time_to: "${new Date(end).toISOString()}"\`` : ' (still open, so no `time_to`)'}`
    : 'the problem window';
  const service = firstService(problem);
  if (!service) {
    const entity = refId(problem.rootCauseEntity) || refId((problem.affectedEntities || [])[0]);
    return entity
      ? `call \`get_entity\` with \`entity: "${entity}"\`, or \`list_events\` with \`entity_selector: entityId("${entity}")\` and ${windowArgs}.`
      : `call \`list_events\` with ${windowArgs}.`;
  }
  const serviceId = refId(service);
  const rootId = refId(problem.rootCauseEntity);
  const rootHint = rootId && rootId !== serviceId && rootId.startsWith('SERVICE-')
    ? ` Repeat with the root cause \`service: "${rootId}"\`.`
    : '';
  return `call \`analyze_failures\` and \`list_traces\` (with \`failed: true\`) with \`service: "${serviceId}"\`, ${windowArgs}; \`service_overview\` with the same arguments shows its metrics and dependencies.${rootHint}`;
}

const getProblem = {
  name: 'get_problem',
  description: [
    'Returns one Dynatrace problem in depth: status, severity, impact, start, end and duration; root cause entity, affected and impacted entities; the evidence (metric changes with the value before and after, events, availability); impact analysis; recent comments; the Davis root-cause findings per candidate entity; the event that triggered the problem with its baseline values (e.g. current against reference error rate, load); the requests that were affected; and the dependency path Davis analysed (the visual resolution path).',
    '',
    'Pass `problem` as the display id (P-12345) or the internal problem id from `list_problems`. The Davis findings, trigger event and dependency path come from internal Dynatrace endpoints; if one of them is unavailable the rest is still returned with a note.',
    '',
    'The result ends with the affected service id and the problem window to pass to `analyze_failures` and `list_traces`.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      problem: { type: 'string', description: 'Problem display id (P-12345, or just 12345) or the internal problem id (e.g. -1234567890123456789_1790000000000V2).' },
      environment: ctx.schema.environment(),
    },
    required: ['problem'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const problemId = await resolveProblemId(args.problem, ctx);
    const problem = await readProblem(problemId, ctx);
    if (!problem || typeof problem !== 'object' || !problem.problemId) throw new Error('Unexpected response from /rest/v2/problems/{id}: no `problemId`.');
    const [davis, model] = await Promise.all([
      internalAnalysis(ctx, `/rest/problems/${problemId}`, 'GET /rest/problems/{id}', ['problem', 'rootCauses.rootCauseList[]'], 'Reading the Davis root cause analysis'),
      internalAnalysis(ctx, `/rest/problems/${problemId}/model`, 'GET /rest/problems/{id}/model', ['vrpNodes[]'], 'Reading the dependency path'),
    ]);

    const end = problemEnd(problem);
    const listRefs = (refs) => (refs || []).map(refLabel).join(', ');
    const summary = [
      `- Status: ${problem.status}`,
      `- Severity: ${problem.severityLevel}, impact: ${problem.impactLevel}`,
      `- Started: ${format.utc(problem.startTime)}`,
      `- Ended: ${end ? format.utc(end) : 'still open'}`,
      `- Duration: ${problemDuration(problem, format)}${end ? '' : ' so far'}`,
      `- Root cause entity: ${problem.rootCauseEntity ? refLabel(problem.rootCauseEntity) : 'none identified'}`,
      `- Affected entities (${(problem.affectedEntities || []).length}): ${listRefs(problem.affectedEntities) || 'none'}`,
      `- Impacted entities (${(problem.impactedEntities || []).length}): ${listRefs(problem.impactedEntities) || 'none'}`,
      problem.managementZones?.length ? `- Management zones: ${problem.managementZones.map(z => z.name || z.id).join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const evidence = Array.isArray(problem.evidenceDetails?.details) ? problem.evidenceDetails.details : [];
    const evidenceCap = format.cap(evidence, 30);
    const impacts = Array.isArray(problem.impactAnalysis?.impacts) ? problem.impactAnalysis.impacts : [];
    const comments = Array.isArray(problem.recentComments?.comments) ? problem.recentComments.comments : [];

    const rootCauseList = davis.value ? davis.value.rootCauses.rootCauseList : [];
    const counts = davis.value
      ? [
        isNumber(davis.value.triggerEventCount) ? plural(davis.value.triggerEventCount, 'trigger event') : null,
        isNumber(davis.value.totalEventCount) ? `${plural(davis.value.totalEventCount, 'event')} in total` : null,
        isNumber(davis.value.dependenciesAnalyzedCount) ? `${format.count(davis.value.dependenciesAnalyzedCount)} dependencies analysed` : null,
      ].filter(Boolean).join(', ')
      : '';
    const trigger = davis.value?.problem?.triggerEvent;
    const affectedRequests = davis.value ? affectedRequestLines(davis.value.impactAnalysisResult, format) : [];

    const marks = problemMarks(problem, rootCauseList);
    const path = model.value
      ? format.tree(model.value.vrpNodes, { childrenOf: node => (Array.isArray(node.children) ? node.children : []), line: node => pathLine(node, marks, format), maxDepth: 6, limit: 40 })
      : null;
    const pathOmitted = path ? path.beyondLimit + path.beyondDepth : 0;

    return format.sections(
      ctx.header(`Problem ${problem.displayId}: ${problem.title}`, { details: [problem.problemId] }),
      summary,
      evidence.length
        ? `## Evidence (${evidence.length})\n\n${format.table(['type', 'what', 'entity', 'root cause relevant', 'start (UTC)', 'end (UTC)', 'before → after'], evidenceRows(evidenceCap.shown, format))}${evidenceCap.omitted ? `\n\n_${evidenceCap.omitted} more evidence entries omitted_` : ''}`
        : null,
      impacts.length ? `## Impact\n\n${impactLines(impacts, format).join('\n')}` : null,
      comments.length ? `## Recent comments\n\n${commentLines(comments.slice(0, 10), format).join('\n')}` : null,
      davis.value
        ? `## Davis root cause${counts ? ` (${counts})` : ''}\n\n${rootCauseList.length ? rootCauseLines(rootCauseList, format).join('\n') : '_Davis identified no root cause candidate._'}`
        : `_Davis root cause, trigger event and affected requests are unavailable: ${davis.note}_`,
      trigger ? `## Trigger event\n\n${triggerLines(trigger, format).join('\n')}` : null,
      affectedRequests.length ? `## Affected requests\n\n${affectedRequests.join('\n')}` : null,
      model.value
        ? `## Dependency path\n\n${path.text || '_Empty._'}${pathOmitted ? `\n\n_${plural(pathOmitted, 'more node')} omitted_` : ''}`
        : `_The dependency path is unavailable: ${model.note}_`,
      format.footer({
        next: problemNext(problem),
        link: ctx.link('#problems/problemdetails', { params: { pid: problem.problemId } }),
      }),
    );
  },
};

const isScalar = (value) => value === null || typeof value !== 'object';

function scalarText(value, format) {
  if (value === null || value === undefined) return 'null';
  if (value === '') return '""';
  return format.truncate(String(value).replace(/\s+/g, ' '), 200);
}

function inlineObject(value, format) {
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  if (!entries.every(([, item]) => isScalar(item))) return null;
  const text = `{ ${entries.map(([key, item]) => `${key}: ${scalarText(item, format)}`).join(', ')} }`;
  return text.length <= 160 ? text : null;
}

function valueLines(key, value, depth, format) {
  const pad = '  '.repeat(depth);
  const lead = key === null ? `${pad}- ` : `${pad}- ${key}: `;
  if (isScalar(value)) return [`${lead}${scalarText(value, format)}`];
  if (depth >= 6) return [`${lead}${format.truncate(JSON.stringify(value), 160)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${lead}[]`];
    if (value.every(isScalar)) {
      const { shown, omitted } = format.cap(value, 12);
      return [`${lead}${shown.map(item => scalarText(item, format)).join(', ')}${omitted ? ` (+${omitted} more)` : ''}`];
    }
    const head = key === null ? `${pad}- (${value.length} items)` : `${pad}- ${key} (${value.length}):`;
    return [head, ...value.flatMap(item => valueLines(null, item, depth + 1, format))];
  }
  const inline = inlineObject(value, format);
  if (inline) return [`${lead}${inline}`];
  const children = Object.entries(value).flatMap(([childKey, item]) => valueLines(childKey, item, depth + 1, format));
  return key === null ? [`${pad}- item:`, ...children] : [`${pad}- ${key}:`, ...children];
}

function settingValueBlock(value, maxLines, format) {
  const masked = format.maskSecrets(value);
  if (isScalar(masked)) return `- value: ${scalarText(masked, format)}`;
  const lines = Array.isArray(masked)
    ? valueLines('value', masked, 0, format)
    : Object.entries(masked).flatMap(([key, item]) => valueLines(key, item, 0, format));
  if (lines.length === 0) return '- value: {}';
  const { shown, omitted } = format.cap(lines, maxLines);
  return `${shown.join('\n')}${omitted ? `\n- … ${omitted} more lines (raise \`max_lines\` to see them)` : ''}`;
}

function settingsDenied(error, ctx) {
  return error instanceof ctx.BridgeError && error.code === 'HTTP_ERROR' && error.status === 403;
}

async function listSchemas(args, ctx) {
  const { format } = ctx;
  const limit = ctx.limit(args.limit, 50, 500);
  const search = clean(args.search);
  const data = await ctx.get('/rest/v2/settings/schemas', {}, { label: 'Listing settings schemas' });
  if (!Array.isArray(data?.items)) throw new Error('Unexpected response from /rest/v2/settings/schemas: no `items` array.');
  const needle = search.toLowerCase();
  const matched = data.items
    .filter(schema => !needle || lower(schema.schemaId).includes(needle) || lower(schema.displayName).includes(needle))
    .sort((a, b) => String(a.schemaId).localeCompare(String(b.schemaId)));
  const { shown, omitted } = format.cap(matched, limit);
  const rows = shown.map(schema => [`\`${schema.schemaId}\``, schema.displayName || '', schema.latestSchemaVersion || '']);
  return format.sections(
    ctx.header(`Settings schemas${search ? `: "${search}"` : ''}`, { details: [`${shown.length} of ${matched.length}`] }),
    rows.length
      ? format.table(['schema id', 'name', 'version'], rows)
      : `_No settings schema matches "${search}"._ Try a shorter word (e.g. "alerting", "anomaly", "attribute") or call read_settings without \`search\` to list all ${data.items.length} schemas.`,
    format.omittedNote(omitted, 'raise `limit` or use `search` to see them'),
    format.footer({
      next: rows.length ? 'call `read_settings` with `schema` set to a schema id to read its objects; add `scope` (an entity id) for an entity-level configuration, or `effective: true` for the values in force including defaults.' : null,
      link: ctx.link('ui/settings'),
    }),
  );
}

const SETTINGS_OBJECT_FIELDS = 'objectId,scope,schemaId,schemaVersion,summary,value,modified';
const SETTINGS_EFFECTIVE_FIELDS = 'schemaId,schemaVersion,origin,summary,value';

const readSettings = {
  name: 'read_settings',
  order: 90,
  description: [
    'Reads Dynatrace configuration (Settings 2.0), read-only: alerting profiles, anomaly detection thresholds, failure detection rules, request attributes, naming rules, maintenance windows and every other settings schema.',
    '',
    'Without `schema` it lists the settings schemas; narrow the list with `search` (text matched against schema id and name, e.g. "alerting", "anomaly", "failure-detection").',
    'With `schema` (e.g. `builtin:alerting.profile`) it prints the configured objects of that schema at `scope` (default `environment`; pass an entity id such as SERVICE-1234567890ABCDEF or HOST_GROUP-… for an entity-level override). Set `effective: true` to get the values actually in force at that scope, including inherited ones and defaults.',
    '',
    'Values are printed as compact nested lists. Passwords, tokens, keys, credentials and anything else that looks like a secret are masked. The bridge cannot change settings.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      schema: { type: 'string', description: 'Settings schema id, e.g. `builtin:alerting.profile`, `builtin:anomaly-detection.services`, `builtin:failure-detection-rulesets`. Omit to list the schemas.' },
      search: { type: 'string', description: 'When listing schemas: case-insensitive text matched against schema id and display name.' },
      scope: { type: 'string', description: 'Scope to read: `environment` (default) or an entity id, e.g. SERVICE-1234567890ABCDEF, HOST-…, PROCESS_GROUP-….' },
      effective: { type: 'boolean', description: 'Read the effective values at the scope (inherited values and defaults included) instead of the objects stored at the scope. Default false.' },
      max_lines: { type: 'number', description: 'Maximum lines printed per settings value. Default 40, at most 200.' },
      limit: ctx.schema.limit(20, 'settings objects (at most 50), or schemas when listing (default 50, at most 500)'),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const schemaId = clean(args.schema);
    if (!schemaId) return listSchemas(args, ctx);
    const scope = clean(args.scope) || 'environment';
    const limit = ctx.limit(args.limit, 20, 50);
    const maxLines = ctx.limit(args.max_lines, 40, 200, 'max_lines');
    const effective = args.effective === true;
    const path = effective ? '/rest/v2/settings/effectiveValues' : '/rest/v2/settings/objects';
    const query = effective
      ? { schemaIds: schemaId, scope, fields: SETTINGS_EFFECTIVE_FIELDS }
      : { schemaIds: schemaId, scopes: scope, fields: SETTINGS_OBJECT_FIELDS };

    let page;
    try {
      page = await ctx.v2List(path, query, { itemsKey: 'items', limit, label: `Reading ${effective ? 'effective ' : ''}settings ${schemaId}` });
    } catch (error) {
      if (settingsDenied(error, ctx)) {
        throw new Error(`Dynatrace denied reading ${effective ? 'the effective values' : 'the objects'} of \`${schemaId}\` at scope \`${scope}\` (HTTP 403): the logged-in user has no permission to read these settings.${effective ? ' Try without `effective`.' : ''}`);
      }
      if (error instanceof ctx.BridgeError && error.code === 'HTTP_ERROR' && error.status === 404) {
        throw new Error(`Dynatrace does not know the settings schema \`${schemaId}\` or the scope \`${scope}\`. List the schemas with read_settings (no \`schema\`, optionally \`search\`).`);
      }
      throw error;
    }

    const blocks = page.items.map((item, index) => {
      const title = format.truncate(format.maskString(format.oneLine(item.summary)), 160) || `${effective ? 'Effective value' : 'Object'} ${index + 1}`;
      const facts = [
        item.objectId ? `- objectId: \`${item.objectId}\`` : null,
        item.scope ? `- scope: ${item.scope}` : null,
        item.origin ? `- origin: ${item.origin}` : null,
        item.schemaVersion ? `- schemaVersion: ${item.schemaVersion}` : null,
        isNumber(item.modified) ? `- modified: ${format.utc(item.modified)}` : null,
      ].filter(Boolean);
      return [`## ${title}`, '', ...facts, settingValueBlock(item.value, maxLines, format)].join('\n');
    });
    const what = effective ? 'effective values' : 'objects';
    const empty = effective
      ? `_No effective values of \`${schemaId}\` at scope \`${scope}\`._ Check the schema id (list schemas with read_settings and \`search\`).`
      : `_No objects of \`${schemaId}\` are stored at scope \`${scope}\`._ Either nothing is configured there (defaults apply; \`effective: true\` shows them), the configuration lives at another scope (pass an entity id as \`scope\`), or the logged-in user may not read this schema.`;
    return format.sections(
      ctx.header(`Settings \`${schemaId}\``, { details: [`scope ${scope}`, `${blocks.length} of ${page.totalCount} ${what}`] }),
      blocks.length ? blocks : empty,
      format.omittedNote(page.totalCount - blocks.length, 'raise `limit` (at most 50), or pass a narrower `scope`'),
      blocks.length ? 'Secrets are masked. The bridge is read-only; settings cannot be changed through it.' : null,
      format.footer({
        next: effective || blocks.length === 0 ? null : 'add `effective: true` to see the values in force including defaults, or pass an entity id as `scope` for an entity-level override.',
        link: ctx.link(`ui/settings/${schemaId}`),
      }),
    );
  },
};

export const tools = defineTools([listServices, serviceOverview, listEvents, listProblems, getProblem, readSettings]);
