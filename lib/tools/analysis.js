import { BRIDGE_NOTE, oneLine, plural } from '../format.js';
import { defineTools } from '../context.js';

export const order = 40;

const FILTER_NOTE = 'The shared trace filters (`response_time_min_ms`, `response_time_max_ms`, `http_code`, `failed`, `http_method`, `request`, `request_group_id`, `url_contains`, `request_kind`, `raw_filters`) narrow the analysed requests.';

const DATABASE_SERVICE = 'DATABASE_SERVICE';
const CLASS_PLACEHOLDER = '{Exception:Class}';
const SERVICE_PLACEHOLDER = '{Service:Name}';
const REQUEST_PLACEHOLDER = '{Request:Name}';

const STATEMENT_SORTS = {
  total_time: { aggregation: 'SUM', total: 'SUM', label: 'total time' },
  avg: { aggregation: 'AVERAGE', total: 'AVERAGE', label: 'average time' },
  max: { aggregation: 'MAX', total: 'MAX', label: 'slowest execution' },
  p95: { aggregation: 'P95', total: 'P95', label: '95th percentile' },
  executions: { aggregation: 'SUM', total: 'LOAD', label: 'executions' },
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const share = (part, total) => (isNumber(part) && isNumber(total) && total > 0 ? (part / total) * 100 : null);
const sum = (values) => values.reduce((total, value) => total + (isNumber(value) ? value : 0), 0);
const descending = (key) => (a, b) => (b[key] ?? 0) - (a[key] ?? 0);

function serviceArgument(ctx, what = 'The service') {
  return ctx.schema.entity(what, 'SERVICE-1234567890ABCDEF');
}

function resolveService(args, ctx, time) {
  return ctx.entities.service(args.service, { time });
}

function requireDatabase(service) {
  const type = service.properties?.serviceType;
  if (type && type !== DATABASE_SERVICE) {
    throw new Error(`${service.displayName} (${service.entityId}) is a ${type}, not a database service. Call \`top_database_statements\` without \`service\` to list the database services.`);
  }
}

async function statementFilter(args, ctx, service, time) {
  const filter = await ctx.servicefilter.resolve({ ...args, request: args.statement }, { service, time });
  if (!filter.requestId) throw new Error('`statement` must be one SQL statement of this database service: its SERVICE_METHOD-… id or a part of its text, as printed by `top_database_statements`.');
  return filter;
}

function withoutRequest(filter) {
  const { requestId, requestName, ...rest } = filter;
  return rest;
}

function hasRawFilter(filter, ctx, name) {
  const id = ctx.servicefilter.TYPES[name];
  return (filter.raw || []).some(raw => String(raw?.type).toUpperCase() === name || Number(raw?.type) === id);
}

function withRawFilters(filter, extra) {
  return { ...filter, raw: [...(filter.raw || []), ...extra] };
}

function analysisWarning(ctx, state, extra = []) {
  return ctx.format.warningLine([...ctx.format.analysisWarnings(state), ...extra]);
}

function stackFrames(stacktrace, max) {
  const frames = [];
  let frame = stacktrace?.children?.[0];
  while (frame && frames.length < max) {
    frames.push(frame.name);
    frame = frame.children?.[0];
  }
  return frames;
}

function causeLines(cause, ctx, frames) {
  const { format } = ctx;
  const subject = cause.throwableClass ? `\`${cause.throwableClass}\`` : (cause.errorType || 'unknown cause');
  const facts = [cause.throwableClass ? cause.errorType : null, isNumber(cause.contribution) ? `${format.percent(cause.contribution)} of this reason's failed requests` : null].filter(Boolean);
  const target = cause.foreignServiceName
    ? ` in a call to ${cause.foreignServiceName}${cause.foreignServiceIdentifier ? ` (${cause.foreignServiceIdentifier})` : ''}`
    : '';
  const http = cause.httpResponseCode > 0 ? `, HTTP ${cause.httpResponseCode}` : '';
  const message = cause.messages?.[0];
  const text = message?.message ? `: ${format.truncate(oneLine(message.message), 200)}` : '';
  const request = cause.requests?.[0];
  return [
    `- ${format.count(cause.count)}× ${subject}${facts.length ? ` (${facts.join(', ')})` : ''}${target}${http}${text}`,
    ...stackFrames(message?.stacktrace, frames).map(frame => `  at ${frame}`),
    request?.serviceMethodName ? `  called request: ${format.truncate(oneLine(request.serviceMethodName), 120)}${request.serviceMethodId ? ` (${request.serviceMethodId})` : ''}` : null,
  ].filter(Boolean);
}

function mergeCauses(causes, frames, format) {
  const groups = format.groupRepeats(causes, (cause) => {
    const message = cause.messages?.[0];
    return [
      cause.throwableClass ?? null,
      cause.errorType ?? null,
      cause.foreignServiceIdentifier ?? cause.foreignServiceName ?? null,
      cause.httpResponseCode ?? null,
      oneLine(message?.message ?? '').replace(/\b\d{4,}\b|\b[0-9a-f]{12,}\b/gi, '#'),
      stackFrames(message?.stacktrace, frames),
    ];
  });
  return groups.map(group => (group.count === 1 ? group.first : {
    ...group.first,
    count: sum(group.members.map(member => member.count)),
    contribution: group.members.every(member => isNumber(member.contribution)) ? sum(group.members.map(member => member.contribution)) : undefined,
  }));
}

function causeBlock(title, causes, ctx, frames) {
  if (!Array.isArray(causes) || causes.length === 0) return null;
  const merged = mergeCauses(causes, frames, ctx.format);
  const { shown, omitted } = ctx.format.cap([...merged].sort(descending('count')), 5);
  const repeats = causes.length - merged.length;
  return [
    `${title}${repeats > 0 ? ` (${causes.length} entries, identical ones merged into ${merged.length})` : ''}:`,
    ...shown.flatMap(cause => causeLines(cause, ctx, frames)),
    omitted ? `- … ${omitted} more` : null,
  ].filter(Boolean).join('\n');
}

function affectedLine(entities, ctx) {
  if (!Array.isArray(entities) || entities.length === 0) return null;
  const { format } = ctx;
  const { shown, omitted } = format.cap([...entities].sort(descending('failedRequests')), 5);
  const listed = shown.map(entity => `${format.truncate(oneLine(entity.name), 120)} (${format.count(entity.failedRequests)} failed)`);
  return `Affected requests: ${listed.join('; ')}${omitted ? `; +${omitted} more` : ''}`;
}

const analyzeFailures = {
  name: 'analyze_failures',
  description: [
    'Explains why requests of a service fail in a time window (Dynatrace failure analysis): the failure reasons ranked by failed requests, each with its type, HTTP status, share of all failures, the exception classes and messages behind it (with the top stack frames), failed downstream calls, and the requests it affects.',
    '',
    'Start here for "why does this service fail": use it when a service shows a failure rate or a problem names it. Pass `service` as an id or a name. ' + FILTER_NOTE,
    'Follow up with `list_traces` (`failed: true`, optionally `http_code`) for the individual failing traces, or `top_exceptions` for exception counts.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx),
      ...ctx.schema.serviceFilter(),
      stack_frames: { type: 'number', description: 'Stack frames shown per exception. Default 3, at most 30.' },
      limit: ctx.schema.limit(10, 'failure reasons', 50),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const endpoint = '/rest/serviceanalysis/failure';
    const data = await ctx.get(endpoint, {
      sci: service.entityId,
      servicefilter: ctx.servicefilter.encode(filter),
      ...time.analysisQuery,
    }, { label: `Failure analysis of ${service.displayName}` });
    ctx.expectShape(data, ['data.reasons[]'], `GET ${endpoint}`);

    const reasons = [...data.data.reasons].sort(descending('failedRequests'));
    const failed = isNumber(data.data.failedRequests) ? data.data.failedRequests : sum(reasons.map(r => r.failedRequests));
    const { shown, omitted } = format.cap(reasons, ctx.limit(args.limit, 10, 50));
    const frames = ctx.limit(args.stack_frames, 3, 30, 'stack_frames');
    const rows = shown.map((reason, index) => [
      index + 1,
      format.truncate(oneLine(reason.name), 120),
      reason.type,
      reason.httpResponseCode > 0 ? reason.httpResponseCode : '',
      format.count(reason.failedRequests),
      format.percent(share(reason.failedRequests, failed)),
    ]);
    const details = shown.map((reason, index) => [
      `## ${index + 1}. ${format.truncate(oneLine(reason.name), 120)}\n`,
      causeBlock('Root causes', reason.rootCauses, ctx, frames),
      causeBlock('Potential root causes', reason.potentialRootCauses, ctx, frames),
      affectedLine(reason.affectedEntities, ctx),
    ].filter(Boolean).join('\n'));

    return format.sections(
      ctx.header(`Failure analysis of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter)] }),
      analysisWarning(ctx, data.analysisState),
      reasons.length ? `**${format.count(failed)} failed requests**, ${plural(reasons.length, 'failure reason')}.` : '_No failed requests in this window._',
      format.table(['#', 'reason', 'type', 'HTTP', 'failed requests', 'share of failures'], rows),
      ...details,
      format.omittedNote(omitted),
      format.footer({
        next: reasons.length ? `call \`list_traces\` with \`service: "${service.entityId}"\` and \`failed: true\` (add \`http_code\` for one reason) to open failing traces, or \`top_exceptions\` with the same service.` : null,
        link: ctx.link('#failureanalysis', { params: { sci: service.entityId, timeframe: time.timeframe }, time }),
      }),
    );
  },
};

function downstreamServices(hierarchy) {
  const groups = [[hierarchy?.callsToOtherServices, 'service'], [hierarchy?.databaseUsage, 'database']];
  return groups
    .flatMap(([group, kind]) => (Array.isArray(group?.children) ? group.children : []).map(node => ({ ...node, kind })))
    .sort(descending('responseTimeContribution'));
}

function executionRows(selfTime, ctx) {
  const { format } = ctx;
  const states = [
    ['CPU', selfTime.execTimeCpu],
    ['wait', selfTime.execTimeWait],
    ['lock (sync)', selfTime.execTimeSync],
    ['network I/O', selfTime.execTimeNetworkIo],
    ['disk I/O', selfTime.execTimeDiskIo],
    ['suspension (GC)', selfTime.execTimeSuspension],
    ['other', selfTime.execTimeOther],
  ].filter(([, value]) => isNumber(value));
  const total = isNumber(selfTime.execTimeTotal) ? selfTime.execTimeTotal : sum(states.map(([, value]) => value));
  return states.map(([state, value]) => [state, format.duration(value), format.percent(share(value, total))]);
}

function histogramBlock(histogram, ctx) {
  const { format } = ctx;
  const counts = histogram.dataCount;
  const failed = histogram.dataFailedCount;
  const start = isNumber(histogram.startValue) ? histogram.startValue : 0;
  const width = histogram.slotWidth;
  const total = sum(counts);
  const peak = Math.max(...counts, 1);
  const last = counts.length - 1;
  const edge = (index) => format.duration(start + index * width);
  const labels = counts.map((_, i) => (i === last && last > 0 ? `≥ ${edge(i)}` : `${edge(i)} – ${edge(i + 1)}`));
  const labelWidth = Math.max(...labels.map(label => label.length));
  const lines = counts.map((count, i) => {
    const bar = count > 0 ? '█'.repeat(Math.max(1, Math.round((count / peak) * 24))) : '';
    return `${labels[i].padStart(labelWidth)} | ${bar.padEnd(24)} ${count} (${format.percent(share(count, total))})${failed[i] ? `, ${failed[i]} failed` : ''}`;
  });
  const tail = last > 0 && counts[last] > 0
    ? `Outlier tail: ${format.count(counts[last])} of ${format.count(total)} requests (${format.percent(share(counts[last], total))}) took ≥ ${edge(last)}${failed[last] ? `; ${failed[last]} of them failed` : ''}.`
    : null;
  return { total, failed: sum(failed), text: ['```', ...lines, '```'].join('\n'), tail, tailStartMicros: start + last * width };
}

const analyzeResponseTime = {
  name: 'analyze_response_time',
  description: [
    'Shows where the response time of a service goes and how it is distributed (Dynatrace response time analysis). Part 1, hotspots: average response time split into own code, calls to other services and database calls; code execution time by state (CPU, wait, lock, network and disk I/O, suspension); every downstream service and database with its contribution, call frequency and call time; and the single downstream requests / SQL statements that cost the most. Part 2, distribution: a text histogram of response times including failed requests, with the outlier tail called out.',
    '',
    'Start here for "why is this service (or one of its endpoints) slow". Pass `service` as an id or a name. ' + FILTER_NOTE + ' E.g. `response_time_min_ms: 2000` analyses only the slow requests, `request` one endpoint.',
    'It runs two analysis requests, one after the other. Follow up with `service_flow` for the full downstream tree, `top_database_statements` on a database listed here, `method_hotspots` for own-code time, or `list_traces` with `response_time_min_ms` for the outliers.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx),
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(15, 'downstream services, and downstream requests / statements', 100),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const limit = ctx.limit(args.limit, 15, 100);
    const query = { sci: service.entityId, servicefilter: ctx.servicefilter.encode(filter), ...time.analysisQuery };

    const hotspotEndpoint = '/rest/serviceanalysis/responsetime';
    const hotspots = await ctx.get(hotspotEndpoint, query, { label: `Response time hotspots of ${service.displayName}` });
    ctx.expectShape(hotspots, ['responseTimeAnalysisOverviewData'], `GET ${hotspotEndpoint}`);
    const overview = hotspots.responseTimeAnalysisOverviewData;
    const hierarchy = hotspots.responseTimeAnalysisCallHierarchyData;
    const hasHotspots = isNumber(overview.responseTime) && overview.responseTime > 0;
    if (hasHotspots) {
      ctx.expectShape(hotspots, [
        'responseTimeAnalysisCallHierarchyData.selfTimeData',
        'responseTimeAnalysisCallHierarchyData.callsToOtherServices.children[]',
        'responseTimeAnalysisCallHierarchyData.databaseUsage.children[]',
      ], `GET ${hotspotEndpoint}`);
    }

    const distributionEndpoint = '/rest/serviceanalysis/responsetimedistribution';
    const distribution = await ctx.get(distributionEndpoint, query, { label: `Response time distribution of ${service.displayName}` });
    const hasDistribution = distribution?.dataFound !== false;
    if (hasDistribution) {
      ctx.expectShape(distribution, ['histogram.dataCount[]', 'histogram.dataFailedCount[]', 'histogram.slotWidth'], `GET ${distributionEndpoint}`);
    }
    const histogram = hasDistribution ? histogramBlock(distribution.histogram, ctx) : null;
    const hasRequests = hasHotspots || (histogram && histogram.total > 0);

    const blocks = [];
    if (hasHotspots) {
      const total = overview.responseTime;
      const contribution = (value) => [format.duration(value), format.percent(share(value, total))];
      blocks.push(`Average response time **${format.duration(total)}**${histogram ? ` over ${format.count(histogram.total)} requests` : ''}.`);
      blocks.push(`## Where the time goes (per request)\n\n${format.table(['part', 'time', 'share'], [
        ['own code', ...contribution(overview.selfTimeResponseTimeContribution)],
        ['calls to other services', ...contribution(overview.callsToOtherServicesResponseTimeContribution)],
        ['database calls', ...contribution(overview.databaseUsageResponseTimeContribution)],
      ])}`);
      const execution = executionRows(hierarchy.selfTimeData, ctx);
      if (execution.length) blocks.push(`## Code execution time by state (per request)\n\n${format.table(['state', 'time', 'share'], execution)}`);

      const findings = (Array.isArray(overview.findings) ? overview.findings : []).map((finding) => {
        const subject = finding.entity ? `: ${format.truncate(oneLine(finding.entity), 120)}${finding.parentEntity ? ` (${oneLine(finding.parentEntity)})` : ''}` : '';
        return `- ${finding.type}${subject}: ${format.duration(finding.responseTimeContribution)} (${format.percent(share(finding.responseTimeContribution, total))})`;
      });
      if (findings.length) blocks.push(`## Top findings\n\n${findings.join('\n')}`);

      const services = downstreamServices(hierarchy);
      const cappedServices = format.cap(services, limit);
      const serviceRows = cappedServices.shown.map(node => [
        node.serviceId ?? node.id,
        node.kind,
        node.name ?? node.serviceName,
        format.duration(node.responseTimeContribution),
        format.percent(share(node.responseTimeContribution, total)),
        format.percent(node.callFrequency),
        format.number(node.averageNumInvocations),
        format.duration(node.averageResponseTime),
        format.percent(node.averageFailureRate),
      ]);
      blocks.push(`## Downstream services and databases\n\n${format.table(
        ['id', 'kind', 'name', 'time per request', 'share', 'called by % of requests', 'calls per calling request', 'avg call time', 'failure rate'],
        serviceRows,
      ) || '_This service calls no other service or database in this window._'}`);
      blocks.push(serviceRows.length ? format.assumedNote(['`callFrequency` ("called by % of requests") and `averageFailureRate` ("failure rate") are percentages (0–100)', 'the times of this analysis are microseconds, like the trace endpoints']) : null);
      blocks.push(format.omittedNote(cappedServices.omitted));

      const requests = services
        .flatMap(node => (Array.isArray(node.children) ? node.children : []).map(child => ({ ...child, kind: node.kind, parentName: node.name ?? node.serviceName })))
        .sort(descending('responseTimeContribution'));
      const cappedRequests = format.cap(requests, limit);
      const requestRows = cappedRequests.shown.map(node => [
        node.serviceMethodId ?? '',
        node.parentName,
        format.truncate(oneLine(node.serviceMethodName ?? node.name), 120),
        format.duration(node.responseTimeContribution),
        format.percent(share(node.responseTimeContribution, total)),
        format.number(node.averageNumInvocations),
        format.duration(node.averageResponseTime),
      ]);
      if (requestRows.length) {
        blocks.push(`## Most expensive downstream requests and statements\n\n${format.table(
          ['id', 'called service', 'request / statement', 'time per request', 'share', 'calls per calling request', 'avg call time'],
          requestRows,
        )}`);
        blocks.push(format.omittedNote(cappedRequests.omitted));
      }
    }
    if (histogram && histogram.total > 0) {
      blocks.push(`## Response time distribution (${format.count(histogram.total)} requests, ${format.count(histogram.failed)} failed)\n\n${histogram.text}`);
      blocks.push(histogram.tail);
    }

    const tailMs = histogram && histogram.tail ? Math.floor(histogram.tailStartMicros / 1000) : null;
    return format.sections(
      ctx.header(`Response time analysis of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter)] }),
      analysisWarning(ctx, hotspots.analysisState),
      hasRequests ? null : '_No requests in this window._',
      ...blocks,
      format.footer({
        next: hasRequests
          ? `call \`service_flow\` with \`service: "${service.entityId}"\` for the downstream tree, \`top_database_statements\` with a database id from the table, \`method_hotspots\` with \`service: "${service.entityId}"\` for own-code time${tailMs ? `, or \`list_traces\` with \`response_time_min_ms: ${tailMs}\` for the outliers` : ''}.`
          : null,
        link: ctx.link('#responsetimeanalysis', { params: { sci: service.entityId, timeframe: time.timeframe }, time }),
      }),
    );
  },
};

const flowChildren = (node) => (Array.isArray(node?.children) ? [...node.children].sort(descending('contributionPct')) : []);

function flowLine(node, depth, ctx) {
  const { format } = ctx;
  const title = `**${node.serviceName}** (${[node.serviceId, node.serviceType].filter(Boolean).join(', ')})`;
  const avg = format.duration(isNumber(node.avgCallTime) ? node.avgCallTime * 1000 : null);
  if (depth === 0) {
    return `${title}: ${format.count(node.transactionCount)} requests, avg response time ${avg}, ${format.count(node.failedTransactionCount)} failed`;
  }
  const facts = [
    `${format.percent(node.contributionPct)} of response time`,
    `called by ${format.percent(node.callPct)} of requests`,
    `${format.number(node.callsPerRequest)} calls per calling request`,
    `avg ${avg} per call`,
    `${format.count(node.callCount)} calls`,
    node.failedCallCount > 0 ? `${format.count(node.failedCallCount)} failed calls` : null,
    node.async ? 'async' : null,
    node.truncated ? 'truncated by Dynatrace' : null,
  ].filter(Boolean);
  return `${title}: ${facts.join(', ')}`;
}

const serviceFlow = {
  name: 'service_flow',
  description: [
    'Shows what a service calls (Dynatrace service flow): the downstream call tree of services, databases and external hosts as an indented tree. Each node has its contribution to the response time of the analysed service, the share of requests that make the call, calls per calling request, average time per call, call count and failed calls.',
    '',
    'Use it to see which dependency a slow or failing service spends its time in. Pass `service` as an id or a name; `max_depth` limits how many call levels are followed. ' + FILTER_NOTE,
    'Follow up with `analyze_response_time` or `service_flow` on a downstream id, `top_database_statements` on a database node, or `service_backtrace` for the opposite direction.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx),
      max_depth: { type: 'number', description: 'How many call levels below the service to show. Default 3, at most 20.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(40, 'tree nodes', 300),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const endpoint = '/rest/serviceanalysis/serviceflow';
    const data = await ctx.get(endpoint, {
      sci: service.entityId,
      serviceId: service.entityId,
      analysisMode: 'RESPONSE_TIME',
      servicefilter: ctx.servicefilter.encode(filter),
      ...time.analysisQuery,
    }, { label: `Service flow of ${service.displayName}` });
    ctx.expectShape(data, ['root.children[]'], `GET ${endpoint}`);

    const maxDepth = ctx.limit(args.max_depth, 3, 20, 'max_depth');
    const hasRequests = data.root.transactionCount > 0 || data.root.children.length > 0;
    const tree = format.tree(data.root, {
      childrenOf: flowChildren,
      line: (node, depth) => flowLine(node, depth, ctx),
      maxDepth,
      limit: ctx.limit(args.limit, 40, 300),
    });
    const truncation = [
      data.timeframeTruncated ? 'Dynatrace shortened the analysed timeframe' : null,
      data.purePathTruncated ? 'some traces were too large and were cut' : null,
    ].filter(Boolean);
    return format.sections(
      ctx.header(`Service flow of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter), `depth ${maxDepth}`] }),
      analysisWarning(ctx, data.analysisStateInfo, truncation),
      hasRequests ? tree.text : '_No requests in this window._',
      hasRequests && data.root.children.length === 0 ? '_This service calls no other service or database in this window._' : null,
      tree.notes,
      hasRequests ? format.assumedNote(['the average times of the tree are Dynatrace\'s `avgCallTime` read as milliseconds']) : null,
      format.footer({
        next: hasRequests ? 'call `analyze_response_time` or `service_flow` with a downstream id from the tree, `top_database_statements` for a Database node, or `service_backtrace` to see who calls this service.' : null,
        link: ctx.link('#serviceflow', { params: { sci: service.entityId, timeframe: time.timeframe }, time }),
      }),
    );
  },
};

const callerChildren = (node) => (Array.isArray(node?.callers) ? [...node.callers].sort(descending('childCallCount')) : []);

function callerLines(node, depth, ctx, { requestsPerCaller, callWord }) {
  const { format } = ctx;
  const runsOn = Array.isArray(node.runsOnNames) && node.runsOnNames.length && depth > 0 ? `, on ${node.runsOnNames.join(', ')}` : '';
  const title = `**${node.serviceName}** (${[node.serviceId, node.serviceType].filter(Boolean).join(', ')}${runsOn})`;
  if (depth === 0) {
    return `${title}: ${format.count(node.callCount)} ${callWord} received${node.errorCount > 0 ? `, ${format.count(node.errorCount)} failed` : ''}`;
  }
  const facts = [
    `${format.count(node.callCount)} requests`,
    `${format.count(node.childCallCount)} resulting ${callWord}`,
    `${format.count(node.directCallCount)} of the requests start here`,
    node.errorCount > 0 ? `${format.count(node.errorCount)} failed` : null,
    node.truncated ? 'truncated by Dynatrace' : null,
  ].filter(Boolean);
  const methods = requestsPerCaller > 0 && Array.isArray(node.methods) ? [...node.methods].sort(descending('childCallCount')) : [];
  const { shown, omitted } = format.cap(methods, requestsPerCaller);
  return [
    `${title}: ${facts.join(', ')}`,
    ...shown.map(method => `· ${format.truncate(oneLine(method.serviceMethodName), 120)} (${method.serviceMethodId}): ${format.count(method.callCount)} requests, ${format.count(method.childCallCount)} ${callWord}`),
    omitted ? `· … ${plural(omitted, 'more request')}` : null,
  ].filter(Boolean);
}

async function fetchBacktrace(ctx, service, filter, time, label) {
  const endpoint = '/rest/serviceanalysis/servicebacktrace';
  const data = await ctx.get(endpoint, {
    sci: service.entityId,
    serviceId: service.entityId,
    servicefilter: ctx.servicefilter.encode(filter),
    ...time.analysisQuery,
  }, { label });
  ctx.expectShape(data, ['root.callers[]', 'root.methods[]'], `GET ${endpoint}`);
  return data;
}

function backtraceWarning(ctx, data) {
  return analysisWarning(ctx, data.analysisStateInfo, [
    data.timeframeTruncated ? 'Dynatrace shortened the analysed timeframe' : null,
    data.purePathTruncated ? 'some traces were too large and were cut, so caller counts can be incomplete' : null,
  ]);
}

const serviceBacktrace = {
  name: 'service_backtrace',
  description: [
    'Shows who calls a service (Dynatrace service backtrace): the upstream caller tree, level by level, up to the services where the requests enter (web entry points, background tasks, cron jobs). Each caller has the number of its requests involved, the resulting calls into the analysed service, how many of its requests start there, and its top calling requests with their SERVICE_METHOD ids.',
    '',
    'Use it to find which upstream service, endpoint or job causes the load or the failures on a service or database. Pass `service` as an id or a name. ' + FILTER_NOTE + ' E.g. `request` backtraces one endpoint, `failed: true` only the failed calls.',
    'For one SQL statement use `statement_callers`. Follow up with `list_traces` on a caller with `request` set to a calling request.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx),
      max_depth: { type: 'number', description: 'How many caller levels above the service to show. Default 4, at most 20.' },
      requests_per_caller: { type: 'number', description: 'Calling requests listed under each caller, ranked by resulting calls. Default 3, at most 20.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(30, 'caller nodes', 300),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const data = await fetchBacktrace(ctx, service, filter, time, `Backtrace of ${service.displayName}`);

    const maxDepth = ctx.limit(args.max_depth, 4, 20, 'max_depth');
    const options = { requestsPerCaller: ctx.limit(args.requests_per_caller, 3, 20, 'requests_per_caller'), callWord: 'calls' };
    const hasCalls = data.root.callCount > 0 || data.root.callers.length > 0;
    const tree = format.tree(data.root, {
      childrenOf: callerChildren,
      line: (node, depth) => callerLines(node, depth, ctx, options),
      maxDepth,
      limit: ctx.limit(args.limit, 30, 300),
    });
    const called = format.cap([...data.root.methods].sort(descending('callCount')), 10);
    const calledRows = called.shown.map(method => [method.serviceMethodId, format.truncate(oneLine(method.serviceMethodName), 120), format.count(method.callCount)]);
    return format.sections(
      ctx.header(`Backtrace of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter), `depth ${maxDepth}`] }),
      backtraceWarning(ctx, data),
      hasCalls ? `## Callers (each level is called by the level below it)\n\n${tree.text}` : '_No calls to this service in this window._',
      hasCalls && data.root.callers.length === 0 ? '_No monitored caller: the requests enter at this service._' : null,
      tree.notes,
      calledRows.length ? `## Called requests of ${service.displayName}\n\n${format.table(['id', 'request', 'calls'], calledRows)}` : null,
      format.omittedNote(called.omitted, 'only the 10 most called requests are listed'),
      format.footer({
        next: hasCalls ? 'call `service_backtrace` again with `request` set to a called request (id or name) to backtrace only that request, or `list_traces` with `service` set to a caller id and `request` to one of its calling requests.' : null,
        link: ctx.link('#servicebacktrace', { params: { sci: service.entityId, timeframe: time.timeframe }, time }),
      }),
    );
  },
};

function dimensionPart(row, placeHolder) {
  return row.parts.find(part => part.placeHolder === placeHolder) || null;
}

function servicesByClass(rows) {
  const byClass = new Map();
  for (const row of rows) {
    const exceptionClass = dimensionPart(row, CLASS_PLACEHOLDER)?.name;
    const service = dimensionPart(row, SERVICE_PLACEHOLDER);
    if (!exceptionClass || !service) continue;
    if (!byClass.has(exceptionClass)) byClass.set(exceptionClass, []);
    byClass.get(exceptionClass).push({ id: service.id, name: service.name, count: row.totals.SUM });
  }
  for (const services of byClass.values()) services.sort(descending('count'));
  return byClass;
}

const topExceptions = {
  name: 'top_exceptions',
  description: [
    'Ranks the exception classes thrown in traced requests (Dynatrace multidimensional analysis "Exceptions overview"): per class the number of exceptions, Dynatrace\'s `LOAD`, `AVERAGE` and `MAX` aggregates of the exception count (read as: requests that had the exception, average and maximum per such request; that reading is not verified, so the columns keep Dynatrace\'s names), and, when no service is given, the services that throw it most with their ids.',
    '',
    'Start here for "which exceptions occur most". Call it without `service` for the whole environment, or with `service` (id or name) for one service. ' + FILTER_NOTE,
    'Follow up with `analyze_failures` on a service that throws the exception (not every exception fails a request), or `list_traces` with `raw_filters: [{ type: "EXCEPTION", values: ["<class>"] }]` for traces containing it.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx, 'Optional: only this service'),
      services_per_class: { type: 'number', description: 'Without `service`: how many services are named per exception class. Default 3, at most 20.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(20, 'exception classes', 100),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const scoped = typeof args.service === 'string' && args.service.trim() !== '';
    const service = scoped ? await resolveService(args, ctx, time) : null;
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const query = {
      metric: 'EXCEPTION_COUNT',
      aggregation: 'SUM',
      mergeServices: true,
      service,
      filter: hasRawFilter(filter, ctx, 'EXCEPTION') ? filter : withRawFilters(filter, [{ type: 'EXCEPTION', values: ['0'] }]),
      time,
    };

    const byClass = await ctx.mda({ ...query, dimension: CLASS_PLACEHOLDER, label: `Exception classes${service ? ` of ${service.displayName}` : ''}` });
    const classes = [...byClass.rows].sort((a, b) => (b.totals.SUM ?? 0) - (a.totals.SUM ?? 0));
    const { shown, omitted } = format.cap(classes, ctx.limit(args.limit, 20, 100));

    let services = new Map();
    let splitNote = null;
    if (!service && shown.length) {
      const split = await ctx.mda({ ...query, dimension: `${CLASS_PLACEHOLDER} ${SERVICE_PLACEHOLDER}`, label: 'Exception classes by service' });
      services = servicesByClass(split.rows);
      if (split.capNote) splitNote = `_The service split covers the top ${split.returned} of ${format.count(split.total)} class and service combinations, so a class can lack services._`;
    }
    const perClass = ctx.limit(args.services_per_class, 3, 20, 'services_per_class');
    const serviceCell = (name) => {
      const capped = format.cap(services.get(name) || [], perClass);
      return `${capped.shown.map(s => `${s.name} (${s.id}) ${format.count(s.count)}`).join('; ')}${capped.omitted ? `; +${capped.omitted} more` : ''}`;
    };
    const rows = shown.map(row => [
      `\`${row.name}\``,
      format.count(row.totals.SUM),
      format.count(row.totals.LOAD),
      format.number(row.totals.AVERAGE),
      format.count(row.totals.MAX),
      ...(service ? [] : [serviceCell(row.name)]),
    ]);
    const headers = ['exception class', 'exceptions (SUM)', 'LOAD', 'AVERAGE', 'MAX', ...(service ? [] : ['thrown by (exceptions)'])];
    return format.sections(
      ctx.header(service ? `Top exceptions of ${service.displayName}` : 'Top exceptions', { time, details: [service?.entityId, ctx.servicefilter.describe(filter), `${shown.length} of ${classes.length} classes`] }),
      format.warningLine(byClass.warnings),
      format.table(headers, rows) || '_No exceptions in traced requests in this window._',
      format.omittedNote(omitted),
      rows.length ? '_`exceptions` is the sum of EXCEPTION_COUNT. `LOAD`, `AVERAGE` and `MAX` are Dynatrace\'s own aggregate names: for time metrics `LOAD` is the number of requests, which would make these the requests that had the exception and the average and maximum exceptions per such request. That reading is not verified for this metric._' : null,
      byClass.capNote ? `_${byClass.capNote}, those with the most exceptions._` : null,
      splitNote,
      format.footer({
        next: rows.length
          ? (service
            ? `call \`analyze_failures\` with \`service: "${service.entityId}"\` to see which exceptions fail requests, or \`list_traces\` with that service and \`raw_filters: [{ type: "EXCEPTION", values: ["<class>"] }]\`.`
            : 'call `top_exceptions` or `analyze_failures` with `service` set to an id from the last column, or `list_traces` with `raw_filters: [{ type: "EXCEPTION", values: ["<class>"] }]`.')
          : null,
        link: ctx.link('ui/diagnostictools/mda', { params: { mdaId: 'exceptions' }, time }),
      }),
    );
  },
};

const CRON_SERVICE = 'CronJobs';
const CRON_LOOKBACK = 1440;
const CRON_SERVICE_LIMIT = 10;
const CRON_OMITTED_FILTERS = ['request', 'request_group_id', 'request_group_name', 'url_contains', 'http_code', 'http_method', 'request_kind'];

const GENERIC_JOB_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

const CRON_SORTS = {
  total_time: { label: 'total time', pick: job => job.total },
  avg: { label: 'average duration', pick: job => job.avg },
  max: { label: 'longest run', pick: job => job.max },
  executions: { label: 'executions', pick: job => job.executions },
  failures: { label: 'failed runs', pick: job => job.failed },
  cpu: { label: 'CPU time', pick: job => job.cpu },
};

function mergeJobs(results) {
  const jobs = new Map();
  for (const { service, rows } of results) {
    for (const row of rows) {
      const name = String(row.name);
      if (!jobs.has(name)) jobs.set(name, { name, executions: 0, failed: 0, total: 0, max: null, cpu: 0, sources: [] });
      const job = jobs.get(name);
      const calls = isNumber(row.calls) ? row.calls : 0;
      job.executions += calls;
      job.failed += isNumber(row.failureRate) ? Math.round((calls * row.failureRate) / 100) : 0;
      job.total += isNumber(row.total) ? row.total : 0;
      job.cpu += isNumber(row.cpu) ? row.cpu : 0;
      if (isNumber(row.max) && (job.max === null || row.max > job.max)) job.max = row.max;
      job.sources.push({ serviceId: service.entityId, id: row.id, calls });
    }
  }
  return [...jobs.values()].map(job => ({ ...job, avg: job.executions > 0 ? job.total / job.executions : null }));
}

const cronJobStatistics = {
  name: 'cron_job_statistics',
  description: [
    'Ranks cron jobs by how much time they take: per job the number of executions, failed runs, total time, average and longest run and CPU time, with the service and request ids needed to open single runs. The tool for "which cron jobs are the slowest / the most time-consuming / fail".',
    '',
    `It reads the requests of the service whose requests are the cron jobs. SAP Commerce (hybris) environments have such a service named \`${CRON_SERVICE}\`, the default for \`service\`; Dynatrace usually has several services with that name (one per process group or node), and this tool combines all of them, which a single \`list_service_requests\` call cannot. Pass another service name or one SERVICE id as \`service\` when the jobs live elsewhere. When no such service exists the tool says so and names the alternatives.`,
    `The default window is the last ${CRON_LOOKBACK / 60} hours. \`sort\`: total_time (default), avg, max, executions, failures, cpu. \`name\` keeps jobs whose name contains the text; \`response_time_min_ms\` and \`failed\` count only the long or the failed runs. A run is one trace and is counted with its full duration (verified for runs of over an hour); runs still executing at the end of the window may be missing. A row named after a method instead of a job (\`ServicelayerJob.performCronJob\`) collects the runs Dynatrace could not name; the output marks it.`,
    'Follow up with `list_traces` (`service` and `request` from the last column) for the single runs, then `get_trace` for what a run did.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: { type: 'string', description: `Name of the service whose requests are the cron jobs (every service with exactly this name is combined), or one SERVICE-… id. Default \`${CRON_SERVICE}\`.` },
      name: { type: 'string', description: 'Only cron jobs whose name contains this text (case-insensitive).' },
      sort: { type: 'string', enum: Object.keys(CRON_SORTS), description: 'Ranking, highest first: total_time (default), avg, max, executions, failures, cpu.' },
      ...ctx.schema.serviceFilter({ omit: CRON_OMITTED_FILTERS }),
      limit: ctx.schema.limit(25, 'cron jobs', 200),
      ...ctx.schema.time(CRON_LOOKBACK),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args, CRON_LOOKBACK);
    const sortName = typeof args.sort === 'string' && args.sort.trim() ? args.sort.trim().toLowerCase() : 'total_time';
    const sort = CRON_SORTS[sortName];
    if (!sort) throw new Error(`invalid \`sort\` ${JSON.stringify(args.sort)}. Use one of: ${Object.keys(CRON_SORTS).join(', ')}`);
    const reference = typeof args.service === 'string' && args.service.trim() ? args.service.trim() : CRON_SERVICE;
    const filter = ctx.servicefilter.fromArgs(Object.fromEntries(Object.entries(args).filter(([key]) => !CRON_OMITTED_FILTERS.includes(key))));
    const byId = ctx.entities.isId(reference);
    const found = byId
      ? { entities: [await ctx.entities.service(reference, { time })], totalCount: 1 }
      : await ctx.entities.list(`type("SERVICE"),entityName.equals(${ctx.entities.quote(reference)})`, { fields: ['properties.serviceType'], time, limit: CRON_SERVICE_LIMIT, label: `Finding the services named "${reference}"` });
    const services = found.entities;
    const title = `Cron jobs of ${byId ? services[0].displayName : reference}`;
    if (services.length === 0) {
      return format.sections(
        ctx.header(title, { time, details: ['0 services'] }),
        `_No service named "${reference}" was seen in this window, so there is nothing to rank._ This tool needs a Dynatrace service whose requests are the cron jobs (SAP Commerce environments have one named \`${CRON_SERVICE}\`).`,
        format.footer({
          next: 'find the service that runs the jobs with `list_services` (`service_type: "CUSTOM_SERVICE"` or `"BACKGROUND_ACTIVITY"`, or `name`) and pass its name or id as `service`; or check with `trace_statistics` and `list_definitions: true` whether a request attribute holds the job name and use it as `dimension` (e.g. `{RequestAttribute:CronJobName}`) with `aggregation: "SUM"`.',
          link: ctx.link('ui/services', { time }),
        }),
      );
    }

    const results = [];
    const failures = [];
    const warnings = new Set();
    let skipped = 0;
    for (const service of services) {
      const attempt = await ctx.attempt(() => ctx.serviceRequests(service, { filter, time, label: `Cron jobs of ${service.displayName} (${service.entityId})` }));
      if (attempt.note) {
        failures.push(`${service.entityId}: ${attempt.note}`);
        continue;
      }
      attempt.value.warnings.forEach(warning => warnings.add(warning));
      skipped += attempt.value.skipped || 0;
      results.push({ service, rows: attempt.value.rows });
    }
    if (results.length === 0) throw new Error(`Could not read the requests of ${services.length === 1 ? 'the service' : 'any of the services'} "${reference}": ${failures.join('; ')}`);

    const needle = typeof args.name === 'string' ? args.name.trim().toLowerCase() : '';
    const jobs = mergeJobs(results).filter(job => !needle || job.name.toLowerCase().includes(needle));
    const ranked = [...jobs].sort((a, b) => (sort.pick(b) ?? -Infinity) - (sort.pick(a) ?? -Infinity) || a.name.localeCompare(b.name));
    const { shown, omitted } = format.cap(ranked, ctx.limit(args.limit, 25, 200));
    const generic = shown.filter(job => GENERIC_JOB_NAME.test(job.name.trim()));
    const genericNote = generic.length
      ? `_${generic.map(job => `\`${job.name}\` (${format.count(job.executions)} executions)`).join(', ')} ${generic.length === 1 ? 'is' : 'are'} not one cron job: a row named after a method is the name Dynatrace falls back to for runs whose job name it could not determine, so it lumps together runs of different jobs. Call \`list_traces\` with the row's \`service\` and \`request\` ids to see the individual runs with their start time and duration._`
      : null;
    const rows = shown.map(job => [
      `${format.truncate(oneLine(job.name), 120)}${GENERIC_JOB_NAME.test(job.name.trim()) ? ' (runs Dynatrace could not name)' : ''}`,
      format.count(job.executions),
      format.count(job.failed),
      format.duration(job.total),
      format.duration(job.avg),
      format.duration(job.max),
      format.duration(job.cpu),
      job.sources.map(source => `${source.serviceId} ${source.id}${job.sources.length > 1 ? ` (${format.count(source.calls)})` : ''}`).join('; '),
    ]);
    const described = ctx.servicefilter.describe(filter);
    const combined = results.map(({ service, rows: own }) => `\`${service.entityId}\` (${plural(own.length, 'job')})`).join(', ');
    const empty = `_No cron job ran in this window${needle || described ? ' with these filters' : ''}._ Widen the time window (\`minutes_lookback\`)${needle || described ? ' or loosen the filters' : ''}.`;
    return format.sections(
      ctx.header(title, {
        time,
        details: [
          byId ? services[0].entityId : plural(results.length, 'service'),
          needle ? `name contains "${args.name.trim()}"` : null,
          described,
          `${shown.length} of ${jobs.length} jobs, by ${sort.label}`,
        ],
      }),
      format.warningLine([...warnings]),
      format.table(['cron job', 'executions', 'failed', 'total time', 'avg', 'max', 'CPU time', 'service and request id'], rows) || empty,
      format.omittedNote(omitted),
      genericNote,
      rows.length ? format.assumedNote(['the `failed` column is executions × Dynatrace\'s failure rate, read as a percentage (0–100), rounded']) : null,
      skipped && rows.length ? `_Dynatrace itself left out ${format.count(skipped)} further jobs before this table was built (which ones it keeps is not verified), so a job outside its list can rank higher by ${sort.label}. Narrow with \`response_time_min_ms\` or \`failed\`, or a shorter window, for a complete ranking._` : null,
      rows.length && results.length > 1 ? `Combined from ${combined}. A job that ran on several of them has one id pair per service, with its executions there in brackets.` : null,
      !byId && found.totalCount > services.length ? `_Only the first ${services.length} of ${found.totalCount} services named "${reference}" were read._` : null,
      failures.length ? `_Not included, because their requests could not be read: ${failures.join('; ')}_` : null,
      format.footer({
        next: rows.length ? 'call `list_traces` with `service` and `request` set to an id pair from the last column (add `response_time_min_ms` for the long runs, `failed: true` for the failed ones), then `get_trace` for what a run did.' : null,
        link: results.length === 1 ? ctx.link('#smgd', { params: { sci: results[0].service.entityId }, time }) : null,
      }),
      results.length > 1 ? serviceLinks(results.map(result => result.service), ctx, time) : null,
    );
  },
};

function serviceLinks(services, ctx, time) {
  return `Open in Dynatrace: ${services.map(service => `[${service.entityId}](${ctx.link('#smgd', { params: { sci: service.entityId }, time })})`).join(' · ')}`;
}

const DATABASE_GROUP_LIMIT = 20;
const STATEMENT_ROW_CAP = 100;

function mergeStatementRows(rows) {
  const statements = new Map();
  for (const row of rows) {
    if (!statements.has(row.name)) statements.set(row.name, { name: row.name, id: null, totals: { SUM: 0, LOAD: 0, MAX: undefined } });
    const { totals } = statements.get(row.name);
    totals.SUM += isNumber(row.totals.SUM) ? row.totals.SUM : 0;
    totals.LOAD += isNumber(row.totals.LOAD) ? row.totals.LOAD : 0;
    if (isNumber(row.totals.MAX) && !(totals.MAX >= row.totals.MAX)) totals.MAX = row.totals.MAX;
  }
  return [...statements.values()].map(statement => ({ ...statement, totals: { ...statement.totals, AVERAGE: statement.totals.LOAD > 0 ? statement.totals.SUM / statement.totals.LOAD : undefined } }));
}

async function combinedStatements(args, ctx, { name, services, totalCount, sort, sortName, time }) {
  const { format } = ctx;
  const filter = { ...ctx.servicefilter.fromArgs(args), requestKind: 'database', serviceName: name };
  const query = { metric: 'RESPONSE_TIME', dimension: REQUEST_PLACEHOLDER, aggregation: sort.aggregation, filter, time };
  const merged = await ctx.attempt(() => ctx.mda({ ...query, mergeServices: true, label: `Statements of all services named ${name}` }));
  const split = await ctx.attempt(() => ctx.mda({ ...query, mergeServices: false, label: `Statement ids per service named ${name}` }));
  if (!merged.value && !split.value) throw new Error(`Could not read the statements of the database services named "${name}": ${merged.note}`);

  const ids = new Set(services.map(service => service.entityId));
  const perService = (split.value?.rows || []).filter(row => row.serviceId && ids.has(row.serviceId));
  const pairs = new Map();
  for (const row of perService) {
    if (!pairs.has(row.name)) pairs.set(row.name, []);
    pairs.get(row.name).push({ serviceId: row.serviceId, id: row.id, executions: row.totals.LOAD });
  }
  const exact = Boolean(merged.value);
  const statements = (exact ? merged.value.rows : mergeStatementRows(perService))
    .sort((a, b) => (b.totals[sort.total] ?? 0) - (a.totals[sort.total] ?? 0));
  const { shown, omitted } = format.cap(statements, ctx.limit(args.limit, 20, STATEMENT_ROW_CAP));
  const rows = shown.map((row) => {
    const sql = oneLine(row.name);
    const sources = (pairs.get(row.name) || []).sort(descending('executions'));
    return [
      args.full_sql ? sql : format.truncate(sql, 160),
      format.duration(row.totals.SUM),
      format.count(row.totals.LOAD),
      format.duration(row.totals.AVERAGE),
      format.duration(row.totals.MEDIAN),
      format.duration(row.totals.P95),
      format.duration(row.totals.MAX),
      sources.map(source => `${source.serviceId} ${source.id ?? '(no id)'} (${format.count(source.executions)})`).join('; ') || 'not in the per-service rows',
    ];
  });
  const source = exact ? merged.value : split.value;
  const capNote = !source.capNote ? null : (sortName === 'total_time'
    ? `_${source.capNote}, those with the largest total time; the others are not part of this ranking._`
    : `_${source.capNote}, those with the largest total time, and this table re-sorts only those by ${sort.label}, so this is not the complete ranking by ${sort.label}. Narrow the filters or the time window until all statements fit._`);
  const withoutPairs = shown.filter(row => !pairs.has(row.name)).length;
  return format.sections(
    ctx.header(`Top database statements of ${name}`, { time, details: [`${plural(services.length, 'database service')} combined`, ctx.servicefilter.describe(ctx.servicefilter.fromArgs(args)), `by ${sort.label}`, `${shown.length} of ${statements.length}`] }),
    format.warningLine([...(source.warnings || [])]),
    format.table(['statement', 'total time', 'executions', 'avg', 'median', 'p95', 'max', 'service and statement id (executions there)'], rows) || '_No statements were executed on these database services in this window._',
    format.omittedNote(omitted),
    `Combined from ${services.map(service => `\`${service.entityId}\``).join(', ')}: every database service named "${name}" seen in this window. ${exact
      ? 'Dynatrace aggregated them by statement text in one request (executions and total time summed; average, median, p95 and max over all executions).'
      : `The request that lets Dynatrace aggregate them failed (${merged.note}), so the per-service rows were merged here by statement text: executions and total time summed, the average weighted by executions, the largest max; median and p95 cannot be merged and are left out.`}`,
    split.value
      ? `The last column comes from a second request split by service${split.value.capNote ? `, which Dynatrace cut to its top ${split.value.returned} statement and service rows` : ''}: one id pair per service that executed the statement${withoutPairs || split.value.capNote ? '; a statement or service beyond that cut has no pair here (pass one service id as `service` to list its statements)' : ''}.`
      : `_The ids per service are unavailable: ${split.note}_`,
    capNote,
    totalCount > services.length ? `_${totalCount} services are named "${name}"; the ${services.length} listed here were read, but Dynatrace's aggregation covers all of them._` : null,
    format.footer({
      next: rows.length ? 'call `statement_callers` or `slow_statement_executions` with `service` and `statement` set to an id pair from the last column (one service at a time; start with the pair that has the most executions).' : null,
      link: ctx.link('ui/diagnostictools/mda', { params: { mdaId: 'topdb' }, time }),
    }),
  );
}

async function listDatabaseServices(args, ctx, time) {
  const { format } = ctx;
  const { entities, totalCount } = await ctx.entities.list(`type("SERVICE"),serviceType("${DATABASE_SERVICE}")`, {
    fields: ['properties.databaseVendor', 'properties.databaseName'],
    time,
    limit: 100,
    label: 'Listing database services',
  });
  const rows = entities.map(e => [e.entityId, e.displayName, e.properties?.databaseVendor ?? '', e.properties?.databaseName ?? '']);
  return format.sections(
    ctx.header('Database services', { time, details: [`${rows.length} of ${totalCount}`] }),
    rows.length ? 'No `service` was given. Call `top_database_statements` again with one of these ids for that service alone, or with a name: when several database services share the name (one per calling process group), their statements are combined.' : '_No database service was seen in this window._',
    format.table(['id', 'name', 'vendor', 'database'], rows),
    format.omittedNote(totalCount - rows.length),
    format.footer({
      next: rows.length ? 'call `top_database_statements` with `service` set to one of these ids or names.' : null,
      link: ctx.link('ui/databases', { time }),
    }),
  );
}

const topDatabaseStatements = {
  name: 'top_database_statements',
  description: [
    'Lists the SQL statements of a database ranked by cost: per statement the total time spent, the average, median, 95th percentile and slowest execution, the number of executions, and the statement id (SERVICE_METHOD-…). The tool for "which SQL is slow / expensive".',
    '',
    'Pass `service` as the id or name of a database service. Dynatrace often has several database services with one name (one per calling process group): pass the name and their statements are combined by statement text in one table, with the service and statement id pairs each follow-up tool needs; pass an id for one of them alone. Combining costs two analysis requests whatever the number of services. Called without `service`, it lists the database services. `sort` ranks by `total_time` (default), `avg`, `max`, `p95` or `executions`. Dynatrace returns at most its 100 statements with the largest total time, so the other sorts re-order only those and the output says so when statements were cut: a rare slow statement can be missing from "slowest". SQL text is cut to a readable length; pass `full_sql: true` for the whole text. ' + FILTER_NOTE,
    'Follow up with `statement_callers` (which services, requests and cron jobs issue a statement) and `slow_statement_executions` (its slow executions with the calling traces), passing the same `service` and the statement id as `statement`.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: { type: 'string', description: 'The database service: a SERVICE-… id for one service, or a name. Every database service with exactly that name is combined; a name that matches one service, or only part of a name, behaves like an id.' },
      sort: { type: 'string', enum: Object.keys(STATEMENT_SORTS), description: 'Ranking: total_time (default), avg, max, p95 or executions.' },
      full_sql: { type: 'boolean', description: 'Print the complete SQL text instead of the first 160 characters. Default false.' },
      ...ctx.schema.serviceFilter(),
      limit: ctx.schema.limit(20, 'statements', 100),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    if (typeof args.service !== 'string' || args.service.trim() === '') return listDatabaseServices(args, ctx, time);
    const sortName = typeof args.sort === 'string' && args.sort.trim() ? args.sort.trim().toLowerCase() : 'total_time';
    const sort = STATEMENT_SORTS[sortName];
    if (!sort) throw new Error(`invalid \`sort\` ${JSON.stringify(args.sort)}. Use one of: ${Object.keys(STATEMENT_SORTS).join(', ')}`);
    const reference = args.service.trim();
    const named = ctx.entities.isId(reference)
      ? null
      : await ctx.entities.list(`type("SERVICE"),entityName.equals(${ctx.entities.quote(reference)})`, { fields: ['properties.serviceType'], time, limit: DATABASE_GROUP_LIMIT, label: `Finding the database services named "${reference}"` });
    const databases = (named?.entities || []).filter(entity => entity.properties?.serviceType === DATABASE_SERVICE);
    if (databases.length > 1) return combinedStatements(args, ctx, { name: reference, services: databases, totalCount: named.totalCount, sort, sortName, time });
    const service = named?.entities.length === 1 ? named.entities[0] : await resolveService(args, ctx, time);
    requireDatabase(service);
    const filter = await ctx.servicefilter.resolve(args, { service, time });
    const analysis = await ctx.mda({
      metric: 'RESPONSE_TIME',
      dimension: REQUEST_PLACEHOLDER,
      aggregation: sort.aggregation,
      service,
      filter,
      time,
      label: `Statements of ${service.displayName}`,
    });

    const statements = [...analysis.rows].sort((a, b) => (b.totals[sort.total] ?? 0) - (a.totals[sort.total] ?? 0));
    const { shown, omitted } = format.cap(statements, ctx.limit(args.limit, 20, 100));
    const rows = shown.map((row) => {
      const sql = oneLine(row.name);
      return [
        row.id ?? '',
        args.full_sql ? sql : format.truncate(sql, 160),
        format.duration(row.totals.SUM),
        format.count(row.totals.LOAD),
        format.duration(row.totals.AVERAGE),
        format.duration(row.totals.MEDIAN),
        format.duration(row.totals.P95),
        format.duration(row.totals.MAX),
      ];
    });
    const capNote = !analysis.capNote ? null : (sortName === 'total_time'
      ? `_${analysis.capNote}, those with the largest total time; the others are not part of this ranking._`
      : `_${analysis.capNote}, those with the largest total time, and this table re-sorts only those by ${sort.label}: a statement outside them (for example a rare but very slow one) can rank higher, so this is not the complete ranking by ${sort.label}. For single slow executions call \`list_traces\` with this service and \`response_time_min_ms\`; for a complete ranking narrow the filters or the time window until all statements fit._`);
    return format.sections(
      ctx.header(`Top database statements of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter), `by ${sort.label}`, `${shown.length} of ${statements.length}`] }),
      format.warningLine(analysis.warnings),
      format.table(['statement id', 'statement', 'total time', 'executions', 'avg', 'median', 'p95', 'max'], rows) || '_No statements were executed on this database service in this window._',
      format.omittedNote(omitted),
      capNote,
      analysis.foreign ? `_${plural(analysis.foreign, 'statement')} of other database services with the same name left out._` : null,
      format.footer({
        next: rows.length ? `call \`statement_callers\` or \`slow_statement_executions\` with \`service: "${service.entityId}"\` and \`statement\` set to an id from the table.` : null,
        link: ctx.link('ui/diagnostictools/mda', { params: { mdaId: 'topdb' }, time }),
      }),
    );
  },
};

function statementSchema() {
  return { type: 'string', description: 'The SQL statement: its SERVICE_METHOD-… id as printed by `top_database_statements`, or a part of its text (several matches return the candidates).' };
}

const STATEMENT_OMITTED_FILTERS = ['request'];

const statementCallers = {
  name: 'statement_callers',
  description: [
    'Finds what causes one SQL statement (Dynatrace backtrace of a database service filtered to the statement): the services that execute it, the exact requests, background tasks and cron jobs behind those services with their SERVICE_METHOD ids, and for each the number of requests and of resulting executions, followed by the upstream caller tree.',
    '',
    'Pass `service` (the database service, id or name) and `statement` (id from `top_database_statements`, or a part of the SQL text). ' + FILTER_NOTE + ' E.g. `response_time_min_ms` backtraces only the slow executions.',
    'Follow up with `slow_statement_executions` for single slow executions, or `list_traces` with `service` set to a caller id and `request` to a calling request.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx, 'The database service'),
      statement: statementSchema(),
      max_depth: { type: 'number', description: 'How many caller levels above the database to show in the tree. Default 4, at most 20.' },
      ...ctx.schema.serviceFilter({ omit: STATEMENT_OMITTED_FILTERS }),
      limit: ctx.schema.limit(20, 'calling requests in the table, and caller nodes in the tree', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service', 'statement'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    requireDatabase(service);
    const filter = await statementFilter(args, ctx, service, time);
    const statementId = filter.requestId;
    const data = await fetchBacktrace(ctx, service, filter, time, `Callers of ${statementId}`);

    const statement = data.root.methods.find(method => method.serviceMethodId === statementId) || data.root.methods[0] || null;
    const executions = statement?.callCount ?? data.root.callCount;
    const hasCalls = executions > 0 || data.root.callers.length > 0;
    const limit = ctx.limit(args.limit, 20, 200);
    const maxDepth = ctx.limit(args.max_depth, 4, 20, 'max_depth');
    const direct = callerChildren(data.root);
    const requests = direct
      .flatMap(caller => (Array.isArray(caller.methods) ? caller.methods : []).map(method => ({ ...method, callerName: caller.serviceName, callerId: caller.serviceId })))
      .sort(descending('childCallCount'));
    const capped = format.cap(requests, limit);
    const requestRows = capped.shown.map(method => [
      method.serviceMethodId,
      format.truncate(oneLine(method.serviceMethodName), 120),
      method.callerId,
      method.callerName,
      format.count(method.callCount),
      format.count(method.childCallCount),
    ]);
    const serviceRows = direct.map(caller => [caller.serviceId, caller.serviceName, caller.serviceType ?? '', format.count(caller.callCount), format.count(caller.childCallCount)]);
    const tree = format.tree(data.root, {
      childrenOf: callerChildren,
      line: (node, depth) => callerLines(node, depth, ctx, { requestsPerCaller: 0, callWord: 'executions' }),
      maxDepth,
      limit,
    });
    const sql = statement?.serviceMethodName ? `Statement: \`${format.truncate(oneLine(statement.serviceMethodName), 300)}\`` : null;
    return format.sections(
      ctx.header(`Callers of statement ${statementId}`, { time, details: [`${service.displayName} ${service.entityId}`, ctx.servicefilter.describe(withoutRequest(filter))] }),
      backtraceWarning(ctx, data),
      sql,
      hasCalls ? `**${format.count(executions)} executions** in this window${data.root.errorCount > 0 ? `, ${format.count(data.root.errorCount)} failed` : ''}.` : '_This statement was not executed in this window._',
      serviceRows.length ? `## Services that execute it\n\n${format.table(['id', 'service', 'type', 'requests', 'executions'], serviceRows)}` : null,
      requestRows.length ? `## Requests and jobs that execute it\n\n${format.table(['id', 'request / job', 'service id', 'service', 'requests', 'executions'], requestRows)}` : null,
      format.omittedNote(capped.omitted),
      hasCalls && data.root.callers.length > 0 ? `## Upstream caller tree\n\n${tree.text}` : null,
      hasCalls ? tree.notes : null,
      format.footer({
        next: hasCalls
          ? `call \`slow_statement_executions\` with the same \`service\` and \`statement: "${statementId}"\` for single slow executions, or \`list_traces\` with \`service\` set to a calling service id and \`request\` to a request id from the table.`
          : null,
        link: ctx.link('#servicebacktrace', { params: { sci: service.entityId, timeframe: time.timeframe }, time }),
      }),
    );
  },
};

const DEFAULT_SLOW_MS = 100;

const slowStatementExecutions = {
  name: 'slow_statement_executions',
  description: [
    'Lists the slow executions of one SQL statement on a database service, slowest first: start time, duration, rows returned, fetches, and the `traceId` and `callURI` of the trace each execution belongs to.',
    '',
    `Pass \`service\` (the database service, id or name), \`statement\` (id from \`top_database_statements\`, or a part of the SQL text) and optionally \`response_time_min_ms\` (default ${DEFAULT_SLOW_MS}). ` + FILTER_NOTE,
    'Follow up with `get_trace`, passing the traceId and callURI of a row as `trace_id` and `call_uri`, to see the request that issued the statement and everything else it did.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: serviceArgument(ctx, 'The database service'),
      statement: statementSchema(),
      ...ctx.schema.serviceFilter({ omit: STATEMENT_OMITTED_FILTERS }),
      response_time_min_ms: { type: 'number', description: `Only executions that took at least this many milliseconds. Default ${DEFAULT_SLOW_MS}.` },
      limit: ctx.schema.limit(20, 'executions', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['service', 'statement'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const service = await resolveService(args, ctx, time);
    requireDatabase(service);
    const resolved = await statementFilter(args, ctx, service, time);
    const statementId = resolved.requestId;
    const filter = { ...resolved, responseTimeMinMs: resolved.responseTimeMinMs ?? DEFAULT_SLOW_MS };
    const limit = ctx.limit(args.limit, 20, 200);
    const fetched = Math.max(limit, 100);
    const endpoint = '/rest/purepaths/list';
    const servicefilter = ctx.servicefilter.encode(filter);
    const data = await ctx.get(endpoint, {
      serviceId: service.entityId,
      servicefilter,
      purepathsLimit: fetched,
      purepathsDataSource: 'ALL',
      partialResult: false,
      ...time.analysisQuery,
    }, { label: `Slow executions of ${statementId}` });
    ctx.expectShape(data, ['analysisResult.purePathsList[]'], `GET ${endpoint}`);

    const executions = [...data.analysisResult.purePathsList]
      .sort((a, b) => (b.timingData?.responseTime ?? 0) - (a.timingData?.responseTime ?? 0));
    const { shown, omitted } = format.cap(executions, limit);
    const rows = shown.map((execution) => {
      const info = execution.infoData || {};
      return [
        format.utc(info.callStartTime, { millis: true }),
        format.duration(execution.timingData?.responseTime),
        info.failed ? 'yes' : '',
        format.count(execution.databaseData?.sqlRowsReturnedPerExecution),
        format.count(execution.databaseData?.sqlFetchesPerExecution),
        info.multiplicity > 1 ? info.multiplicity : '',
        info.traceIdHex ?? '',
        info.callURI ?? '',
      ];
    });
    const sql = executions[0]?.infoData?.dimension ? `Statement: \`${format.truncate(oneLine(String(executions[0].infoData.dimension).split('@_@')[0]), 300)}\`` : null;
    const traces = new Set(executions.map(execution => execution.infoData?.traceIdHex).filter(Boolean)).size;
    return format.sections(
      ctx.header(`Slow executions of statement ${statementId}`, { time, details: [`${service.displayName} ${service.entityId}`, ctx.servicefilter.describe(withoutRequest(filter))] }),
      format.warningLine(format.analysisWarnings(data.serviceAnalysisResultMetadata, data.serviceAnalysisResultDebugInfo)),
      sql,
      rows.length ? `${plural(executions.length, 'execution')} in ${plural(traces, 'trace')}, slowest first.` : `_No execution of this statement took ${filter.responseTimeMinMs} ms or longer in this window._ Lower \`response_time_min_ms\` or widen the time window.`,
      format.table(['start (UTC)', 'duration', 'failed', 'rows', 'fetches', 'repeats', 'traceId', 'callURI'], rows),
      format.omittedNote(omitted),
      executions.length >= fetched ? `_Dynatrace returned its limit of the ${fetched} newest matching executions, so "slowest first" covers only those and older, possibly slower ones exist. Raise \`response_time_min_ms\` or shorten the window until fewer than ${fetched} match._` : null,
      format.footer({
        next: rows.length ? 'call `get_trace` with `trace_id` and `call_uri` set to the traceId and callURI of a row (same time window) to open the trace that executed the statement, or `statement_callers` for the requests behind it.' : null,
        link: ctx.link(`ui/services/${service.entityId}/purepaths`, { params: { servicefilter }, time }),
      }),
    );
  },
};

export const tools = defineTools([
  analyzeFailures,
  analyzeResponseTime,
  serviceFlow,
  serviceBacktrace,
  topExceptions,
  cronJobStatistics,
  topDatabaseStatements,
  statementCallers,
  slowStatementExecutions,
]);
