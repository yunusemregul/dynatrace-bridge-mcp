import { BRIDGE_NOTE, apiChanged, pointSeries as seriesOf } from '../format.js';
import { defineTools } from '../context.js';

export const order = 60;

const DASHBOARD_ORDER = 80;
const STATE_ORDER = ['RUNNING', 'LOCK', 'WAIT', 'NET_IO', 'DISK_IO'];
const STATE_LABELS = { RUNNING: 'running', LOCK: 'locking', WAIT: 'waiting', NET_IO: 'network I/O', DISK_IO: 'disk I/O' };
const DASHBOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID = /^[A-Z][A-Z0-9_]*-[0-9A-F]{16}$/;
const HOTSPOT_TARGETS = { service: 'SERVICE', process_group: 'PROCESS_GROUP' };
const CHART_TILE_TYPES = ['DATA_EXPLORER'];
const DEFAULT_TILE_DETAILS = 12;
const MAX_TILE_DETAILS = 30;
const PATH_SEGMENT = /^[A-Za-z0-9_.:-]+$/;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const sum = (values) => values.reduce((total, value) => total + (isNumber(value) ? value : 0), 0);
const ratio = (part, total) => (total > 0 ? part / total : null);
const lower = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const stateLabel = (state) => STATE_LABELS[state] || String(state).toLowerCase();
const stateRank = (state) => (STATE_ORDER.includes(state) ? STATE_ORDER.indexOf(state) : STATE_ORDER.length);

function stateBreakdown(samples, format) {
  return Object.entries(samples || {})
    .filter(([, value]) => isNumber(value) && value > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([state, value]) => `${stateLabel(state)} ${format.count(value)}`)
    .join(', ');
}

function featureDescription(metadata) {
  const name = metadata?.agentFeatureFlagName ? `"${metadata.agentFeatureFlagName}"` : 'this OneAgent feature';
  const needs = [
    metadata?.minAgentVersionNumber ? `OneAgent ${metadata.minAgentVersionNumber}+` : null,
    metadata?.processRestartRequired ? 'a process restart after enabling' : null,
  ].filter(Boolean);
  return needs.length ? `${name} (needs ${needs.join(' and ')})` : name;
}

async function resolveProcessGroup(args, ctx, time) {
  return ctx.entities.resolve(args.process_group, { type: 'PROCESS_GROUP', time, what: 'process_group' });
}

const cpuByProcessGroup = {
  name: 'cpu_by_process_group',
  description: [
    'Lists the process groups that consumed the most CPU in the window (Dynatrace continuous CPU profiling): CPU time, share of the total, CPU time spent in garbage collection, when the peak was, and which deeper analyses each process group supports.',
    '',
    'Start here for "which process burns the CPU". Follow up with `method_hotspots` (hot methods), `thread_analysis` (thread groups and states) or `memory_allocation_hotspots`, passing the PROCESS_GROUP id from the table as `process_group`. For CPU per endpoint use `trace_statistics` with `metric: "CPU_TIME"`.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Only process groups whose name, id or technology contains this text (case-insensitive).' },
      limit: ctx.schema.limit(20, 'process groups', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const data = await ctx.get('/rest/profiling/cpu/pgs', { gtf: time.gtf }, { label: 'CPU by process group' });
    ctx.expectShape(data, ['entries[]'], 'GET /rest/profiling/cpu/pgs');

    const text = lower(args.text);
    const matching = data.entries
      .filter(e => !text || `${e.name} ${e.id} ${e.tech}`.toLowerCase().includes(text))
      .sort((a, b) => (b.metricValue || 0) - (a.metricValue || 0));
    const { shown, omitted } = format.cap(matching, ctx.limit(args.limit, 20, 200));
    const cpuTime = format.formatterForUnit(data.aggregationUnit || 'MicroSecond');
    const total = sum(data.entries.map(e => e.metricValue));
    const rows = shown.map((e) => {
      const series = seriesOf(e.dataPoints);
      const stats = format.seriesStats(series.timestamps, series.values);
      const gc = Number(e.metadata?.METRIC_VALUE_GC);
      const supports = [
        e.methodHotSpotSupported ? 'hotspots' : null,
        e.threadAnalysisSupported ? 'threads' : null,
        e.memoryAllocationSupported ? 'memory' : null,
      ].filter(Boolean);
      return [
        e.id,
        e.name,
        e.tech || '',
        cpuTime(e.metricValue),
        format.percent(ratio(e.metricValue, total), { ratio: true }),
        Number.isFinite(gc) ? cpuTime(gc) : '-',
        stats ? format.utc(stats.maxAt, { seconds: false }) : '-',
        stats ? format.describeTrend(stats.trend) : '-',
        supports.join(', ') || '-',
      ];
    });
    const assumptions = [
      data.aggregationUnit ? null : 'the CPU time is in microseconds (Dynatrace named no unit)',
      shown.some(e => Number.isFinite(Number(e.metadata?.METRIC_VALUE_GC))) ? '`GC CPU time` (`metadata.METRIC_VALUE_GC`) is in the same unit as the CPU time' : null,
    ];
    return format.sections(
      ctx.header('CPU by process group', { time, details: [args.text ? `matching "${args.text}"` : null, `${shown.length} of ${matching.length}`] }),
      rows.length
        ? format.table(['id', 'process group', 'technology', 'CPU time', 'share', 'GC CPU time', 'peak at (UTC)', 'trend', 'supports'], rows)
        : '_No process group with CPU profiling data in this window._',
      rows.length ? `Total CPU time of the ${data.entries.length} process groups Dynatrace returned: ${cpuTime(total)}. Share is each group's CPU time divided by that total.` : null,
      rows.length ? format.assumedNote(assumptions) : null,
      data.tooManyMatchingItems ? '_Dynatrace reports more matching process groups than it returned._' : null,
      format.omittedNote(omitted),
      format.footer({
        next: rows.length
          ? 'call `method_hotspots`, `thread_analysis` or (for process groups that list `memory`) `memory_allocation_hotspots` with `process_group` set to an id from the table.'
          : null,
        link: ctx.link('ui/diagnostictools/profiling/cpu', { time }),
      }),
    );
  },
};

function hotspotModel(data, endpoint) {
  const byId = new Map(data.dataNodes.map(node => [String(node.id), node]));
  const root = byId.get(String(data.dataRootNodeId));
  if (!root) {
    throw apiChanged(endpoint, 'has no node for `dataRootNodeId`');
  }
  const children = (node) => (Array.isArray(node.childIds) ? node.childIds : []).map(id => byId.get(String(id))).filter(Boolean);
  const total = (node) => sum(Object.values(node.samples || {}));
  const self = (node) => {
    const kids = children(node);
    const out = {};
    for (const [state, value] of Object.entries(node.samples || {})) {
      if (!isNumber(value)) continue;
      const rest = value - sum(kids.map(kid => kid.samples?.[state]));
      if (rest > 0) out[state] = rest;
    }
    return out;
  };
  const name = (node) => [node.classPath, node.className, node.methodName].filter(Boolean).join('.') || node.fileName || '(unknown)';
  const api = (node) => node.apiInfo?.displayName || node.apiInfo?.id || '';
  const roots = children(root);
  const reported = data.overallStacktraceSamplesPerApi?.total;
  const grandTotal = isNumber(reported) && reported > 0 ? reported : sum(roots.map(total));
  return { roots, children, total, self, name, api, grandTotal };
}

function flatHotspots(model) {
  const methods = new Map();
  const visit = (node, onPath) => {
    const key = model.name(node);
    if (!methods.has(key)) methods.set(key, { name: key, api: model.api(node), self: 0, total: 0, states: {} });
    const entry = methods.get(key);
    for (const [state, value] of Object.entries(model.self(node))) {
      entry.states[state] = (entry.states[state] || 0) + value;
      entry.self += value;
    }
    const repeated = onPath.has(key);
    if (!repeated) {
      entry.total += model.total(node);
      onPath.add(key);
    }
    for (const child of model.children(node)) visit(child, onPath);
    if (!repeated) onPath.delete(key);
  };
  for (const node of model.roots) visit(node, new Set());
  return [...methods.values()].sort((a, b) => b.self - a.self || b.total - a.total);
}

function hotspotTree(model, { minShare, maxNodes, format }) {
  const lines = [];
  let cut = 0;
  const share = (value) => format.percent(ratio(value, model.grandTotal), { ratio: true });
  const selfTotal = (node) => sum(Object.values(model.self(node)));
  const significant = (node) => model.children(node)
    .filter(kid => model.total(kid) / model.grandTotal >= minShare)
    .sort((a, b) => model.total(b) - model.total(a));
  const walk = (node, depth) => {
    if (lines.length >= maxNodes) {
      cut++;
      return;
    }
    const indent = '  '.repeat(depth);
    const api = model.api(node);
    lines.push(`${indent}- ${share(model.total(node))} total, ${share(selfTotal(node))} self · ${model.name(node)}${api ? ` · ${api}` : ''} · ${format.count(model.total(node))} samples`);
    let kids = significant(node);
    let skipped = 0;
    while (kids.length === 1 && selfTotal(kids[0]) / model.grandTotal < minShare && significant(kids[0]).length === 1) {
      kids = significant(kids[0]);
      skipped++;
    }
    if (skipped) lines.push(`${indent}  - … ${skipped} frame${skipped === 1 ? '' : 's'} with a single callee and own share below the threshold skipped`);
    for (const kid of kids) walk(kid, depth + 1);
  };
  const top = model.roots
    .filter(node => model.total(node) / model.grandTotal >= minShare)
    .sort((a, b) => model.total(b) - model.total(a));
  for (const node of top) walk(node, 0);
  return { lines, cut };
}

const methodHotspots = {
  name: 'method_hotspots',
  description: [
    'Shows which methods a service or process group spends its time in, from Dynatrace code-level stack samples: sample share per API (framework / library group) and per thread state, then the hot methods.',
    '',
    '`view: "flat"` (default) ranks methods by self share (samples where the method itself was on top of the stack) and also gives the total share including callees. `view: "tree"` prints the call tree from the thread entry points downwards, pruned to branches above `min_share_percent`.',
    'By default only active states are counted (running on CPU, locking, network and disk I/O); `include_waiting: true` adds waiting threads.',
    '',
    'Pass exactly one of `service` or `process_group` (id or name; ids come from `list_services`, `trace_statistics` or `cpu_by_process_group`). Numbers are stack samples, not milliseconds; compare shares. Follow up with `thread_analysis` for the thread groups behind the samples.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      service: ctx.schema.entity('The service whose code to profile', 'SERVICE-1234567890ABCDEF'),
      process_group: ctx.schema.entity('The process group to profile', 'PROCESS_GROUP-1234567890ABCDEF'),
      view: { type: 'string', enum: ['flat', 'tree'], description: 'flat (default): top methods by self share. tree: pruned call tree.' },
      include_waiting: { type: 'boolean', description: 'Also count samples of waiting threads. Default false.' },
      text: { type: 'string', description: 'Flat view only: keep methods whose name or API contains this text (case-insensitive).' },
      min_share_percent: { type: 'number', description: 'Tree view only: hide branches below this share of all samples (0-100). Default 1.' },
      limit: ctx.schema.limit(20, 'methods (flat view, at most 200) or tree lines (tree view, default 40, at most 300)'),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const view = lower(args.view) || 'flat';
    if (view !== 'flat' && view !== 'tree') throw new Error(`invalid \`view\` ${JSON.stringify(args.view)}. Use flat or tree`);
    const minPercent = ctx.number(args.min_share_percent, 'min_share_percent', { fallback: 1, min: 0, max: 100 });
    const { key: target, entity } = await ctx.entities.resolveOne(args, HOTSPOT_TARGETS, { time });
    const path = `/rest/codelevelanalysis/methodhotspots/${entity.entityId}`;
    const endpoint = 'GET /rest/codelevelanalysis/methodhotspots/{id}';
    const data = await ctx.get(path, { showWaiting: String(args.include_waiting === true), ...time.analysisQuery }, { label: `Method hotspots of ${entity.displayName}` });
    ctx.expectShape(data, ['dataNodes[]', 'dataRootNodeId', 'overallStacktraceSamplesPerState'], endpoint);

    const model = hotspotModel(data, endpoint);
    const notes = format.analysisWarnings(data.baseAnalysisStateInfo);
    const header = ctx.header(`Method hotspots of ${entity.displayName}`, {
      time,
      details: [
        entity.entityId,
        `${view} view`,
        args.include_waiting === true ? 'waiting threads included' : 'waiting threads excluded',
        data.codelevelAnalysisMode ? `mode ${data.codelevelAnalysisMode}` : null,
        isNumber(data.numOfPGIs) ? `${data.numOfPGIs} process instances` : null,
      ],
    });
    const link = ctx.link('#methodhotspots', { params: { entityId: entity.entityId }, time });
    if (model.grandTotal <= 0) {
      return format.sections(
        header,
        `_No code-level samples for this ${target === 'service' ? 'service' : 'process group'} in the window${notes.length ? ` (${notes.join('; ')})` : ''}._ Widen the window, set \`include_waiting: true\`${target === 'service' ? ', or pass the process group instead of the service' : ''}.`,
        format.footer({ link }),
      );
    }

    const share = (value) => format.percent(ratio(value, model.grandTotal), { ratio: true });
    const states = Object.entries(data.overallStacktraceSamplesPerState)
      .filter(([, value]) => isNumber(value))
      .sort(([a], [b]) => stateRank(a) - stateRank(b))
      .map(([state, value]) => [stateLabel(state), format.count(value), share(value)]);
    const apiNames = new Map((data.overallStacktraceSamplesPerApi?.apis || []).map(api => [api.id, api.displayName || api.id]));
    const apis = Object.entries(data.overallStacktraceSamplesPerApi?.contribution || {})
      .filter(([, value]) => isNumber(value))
      .sort(([, a], [, b]) => b - a)
      .map(([id, value]) => [apiNames.get(id) || id, format.count(value), share(value)]);

    let body;
    let omittedNote;
    if (view === 'tree') {
      const { lines, cut } = hotspotTree(model, { minShare: minPercent / 100, maxNodes: ctx.limit(args.limit, 40, 300), format });
      body = `## Call tree (branches ≥ ${format.number(minPercent)} % of samples; callers above callees)\n\n${lines.join('\n') || '_No branch reaches the threshold; lower `min_share_percent`._'}`;
      omittedNote = cut ? `_${cut} more branch${cut === 1 ? '' : 'es'} cut off (raise \`limit\` or \`min_share_percent\`)_` : '';
    } else {
      const text = lower(args.text);
      const methods = flatHotspots(model).filter(m => !text || `${m.name} ${m.api}`.toLowerCase().includes(text));
      const { shown, omitted } = format.cap(methods, ctx.limit(args.limit, 20, 200));
      const rows = shown.map(m => [m.name, m.api, format.count(m.self), share(m.self), format.count(m.total), share(m.total), stateBreakdown(m.states, format)]);
      body = `## Hot methods${args.text ? ` matching "${args.text}"` : ''} (ranked by self samples)\n\n${format.table(['method', 'API', 'self', 'self share', 'total', 'total share', 'self by state'], rows) || '_No method matched._'}`;
      omittedNote = format.omittedNote(omitted);
    }

    return format.sections(
      header,
      format.warningLine(notes),
      `${format.count(model.grandTotal)} stack samples. Self = the method itself was executing; total = the method or anything it called.`,
      `## By thread state\n\n${format.table(['state', 'samples', 'share'], states)}`,
      apis.length ? `## By API\n\n${format.table(['API', 'samples', 'share'], apis)}` : null,
      body,
      omittedNote,
      format.footer({
        next: view === 'tree'
          ? 'call `method_hotspots` with `view: "flat"` for the ranked method list, or `thread_analysis` with the process group to see which thread groups produce these samples.'
          : 'call `method_hotspots` with `view: "tree"` to see who calls a hot method, `include_waiting: true` to add waiting time, or `thread_analysis` with the process group for the thread groups behind the samples.',
        link,
      }),
    );
  },
};

const threadAnalysis = {
  name: 'thread_analysis',
  description: [
    'Analyses the threads of a process group (Dynatrace continuous thread analysis): how many threads are in each state (running, locking, network I/O, disk I/O, optionally waiting), and the thread groups ranked by CPU time with their average thread count and state samples.',
    '',
    'Use it to see whether a process is CPU-bound, blocked on locks or stuck in I/O, and which thread pool is responsible. `state` keeps only thread groups seen in that state and ranks by it (e.g. `LOCK` for lock contention). Follow up with `method_hotspots` on the same process group for the methods.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      process_group: ctx.schema.entity('The process group', 'PROCESS_GROUP-1234567890ABCDEF'),
      include_waiting: { type: 'boolean', description: 'Also include waiting (idle) threads. Default false.' },
      state: { type: 'string', enum: STATE_ORDER, description: 'Only thread groups sampled in this state, ranked by its samples. Default: all, ranked by CPU time.' },
      limit: ctx.schema.limit(20, 'thread groups', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['process_group'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const group = await resolveProcessGroup(args, ctx, time);
    const data = await ctx.get(
      `/rest/codelevelanalysis/threadanalysis/${group.entityId}`,
      { showWaiting: String(args.include_waiting === true), ...time.analysisQuery },
      { label: `Thread analysis of ${group.displayName}` },
    );
    ctx.expectShape(data, ['analysisResult.threadAnalysisItems[]', 'analysisResult.overallStacktraceSamplesPerState'], 'GET /rest/codelevelanalysis/threadanalysis/{id}');

    const result = data.analysisResult;
    const metadata = data.serviceAnalysisResultMetadata;
    const state = String(args.state ?? '').trim().toUpperCase() || null;
    if (state && !STATE_ORDER.includes(state)) throw new Error(`invalid \`state\` ${JSON.stringify(args.state)}. Use one of: ${STATE_ORDER.join(', ')}`);
    const items = result.threadAnalysisItems;
    const totalCpu = sum(items.map(t => t.cpuTimeMillis));
    const ranked = state
      ? items.filter(t => (t.stacktraceSamplesPerState?.[state] || 0) > 0).sort((a, b) => b.stacktraceSamplesPerState[state] - a.stacktraceSamplesPerState[state])
      : [...items].sort((a, b) => (b.cpuTimeMillis || 0) - (a.cpuTimeMillis || 0));
    const { shown, omitted } = format.cap(ranked, ctx.limit(args.limit, 20, 200));
    const showMemory = shown.some(t => t.allocatedMemoryKB > 0);
    const rows = shown.map(t => [
      t.name,
      format.durationMs(t.cpuTimeMillis),
      format.percent(ratio(t.cpuTimeMillis, totalCpu), { ratio: true }),
      format.number(sum(Object.values(t.avgThreadsPerState || {}))),
      stateBreakdown(t.stacktraceSamplesPerState, format) || '-',
      ...(showMemory ? [format.bytes(t.allocatedMemoryKB * 1024)] : []),
      isNumber(t.seenOnPGIsAmount) ? t.seenOnPGIsAmount : '',
      t.nativeThread ? 'native' : 'managed',
    ]);

    const totalSamples = sum(Object.values(result.overallStacktraceSamplesPerState));
    const stateRows = Object.keys(result.overallStacktraceSamplesPerState)
      .sort((a, b) => stateRank(a) - stateRank(b))
      .map(key => [
        stateLabel(key),
        format.number(result.overallAvgThreadsPerState?.[key]),
        format.count(result.overallStacktraceSamplesPerState[key]),
        format.percent(ratio(result.overallStacktraceSamplesPerState[key], totalSamples), { ratio: true }),
      ]);
    const series = Object.entries(result.avgThreadsPerState || {})
      .sort(([a], [b]) => stateRank(a) - stateRank(b))
      .map(([key, points]) => ({ label: stateLabel(key), ...seriesOf(points) }));
    const disabled = metadata?.agentFeatureFlagActive === false;
    const notes = [
      disabled ? `${featureDescription(metadata)} is not enabled for this process group` : null,
      ...format.analysisWarnings(metadata),
    ];

    return format.sections(
      ctx.header(`Thread analysis of ${group.displayName}`, {
        time,
        details: [
          group.entityId,
          args.include_waiting === true ? 'waiting threads included' : 'waiting threads excluded',
          isNumber(result.numOfPGIs) ? `${result.numOfPGIs} process instances` : null,
        ],
      }),
      format.warningLine(notes),
      `${items.length} thread groups (${items.filter(t => t.nativeThread).length} native), ${format.durationMs(totalCpu)} CPU time in total.`,
      stateRows.length ? `## Threads by state\n\n${format.table(['state', 'avg threads', 'samples', 'share of samples'], stateRows)}` : null,
      `## Thread groups${state ? ` in state ${stateLabel(state)} (ranked by its samples)` : ' (ranked by CPU time)'}\n\n${
        format.table(['thread group', 'CPU time', 'CPU share', 'avg threads', 'samples by state', ...(showMemory ? ['allocated'] : []), 'instances', 'kind'], rows)
        || '_No thread group matched in this window._'}`,
      format.omittedNote(omitted),
      series.length ? `## Average threads per state over time\n\n${format.seriesReport(series, { buckets: 12 })}` : null,
      format.footer({
        next: `call \`method_hotspots\` with \`process_group: "${group.entityId}"\` for the methods behind the samples (add \`include_waiting: true\` when threads are mostly waiting), or narrow the window around a peak.`,
        link: ctx.link(`ui/diagnostictools/${group.entityId}/threadanalysis`, { time }),
      }),
    );
  },
};

function callerChain(node, depth = 3) {
  const names = [];
  let current = node;
  for (let i = 0; i < depth; i++) {
    const callers = Array.isArray(current?.children) ? current.children : [];
    if (callers.length === 0) break;
    current = callers.reduce((best, caller) => ((caller.allocationInfo?.allocationSize || 0) > (best.allocationInfo?.allocationSize || 0) ? caller : best), callers[0]);
    names.push(current.name);
  }
  return names;
}

function topTypes(types, format, max = 3) {
  return Object.entries(types || {})
    .sort(([, a], [, b]) => (b?.allocationSize || 0) - (a?.allocationSize || 0))
    .slice(0, max)
    .map(([type, info]) => `${type} ${format.bytes(info?.allocationSize)}`)
    .join(', ');
}

function typeTotals(nodes) {
  const totals = new Map();
  for (const node of nodes) {
    for (const [type, info] of Object.entries(node.types || {})) {
      if (!totals.has(type)) totals.set(type, { type, allocationSize: 0, allocationCount: 0, survivorSize: 0, survivorCount: 0 });
      const entry = totals.get(type);
      for (const key of ['allocationSize', 'allocationCount', 'survivorSize', 'survivorCount']) entry[key] += isNumber(info?.[key]) ? info[key] : 0;
    }
  }
  return [...totals.values()].sort((a, b) => b.allocationSize - a.allocationSize);
}

function profilingUnavailable(error, ctx) {
  return error instanceof ctx.BridgeError
    && error.code === 'HTTP_ERROR'
    && /not\s+(enabled|supported|available|activated)|disabled/i.test(`${error.message} ${error.detail || ''}`);
}

const MEMORY_DEFAULT_LOOKBACK = 15;
const MEMORY_MAX_BYTES = 48 * 1024 * 1024;

const memoryAllocationHotspots = {
  name: 'memory_allocation_hotspots',
  description: [
    'Shows where a process group allocates memory (Dynatrace continuous memory profiling, Java): total allocated and surviving bytes, allocation per API, the methods that allocate the most with their main callers and object types, and the most allocated types.',
    '',
    'Use it for high garbage-collection time or memory growth. `survivors_only: true` restricts to objects that survived a garbage collection (candidates for leaks and heap growth).',
    `The default window is the last ${MEMORY_DEFAULT_LOOKBACK} minutes because Dynatrace answers with a very large call tree for busy process groups; keep the window short.`,
    'When memory profiling is not enabled or not supported for the process group, or the answer is too large to relay, the tool says so and what to do. `cpu_by_process_group` lists `memory` for the process groups that support it.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      process_group: ctx.schema.entity('The process group', 'PROCESS_GROUP-1234567890ABCDEF'),
      survivors_only: { type: 'boolean', description: 'Only objects that survived a garbage collection. Default false.' },
      limit: ctx.schema.limit(15, 'allocating methods and types', 100),
      ...ctx.schema.time(MEMORY_DEFAULT_LOOKBACK),
      environment: ctx.schema.environment(),
    },
    required: ['process_group'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args, MEMORY_DEFAULT_LOOKBACK);
    const group = await resolveProcessGroup(args, ctx, time);
    const survivorsOnly = args.survivors_only === true;
    const header = ctx.header(`Memory allocation hotspots of ${group.displayName}`, {
      time,
      details: [group.entityId, survivorsOnly ? 'survivors only' : 'all allocations'],
    });
    const link = ctx.link(`ui/diagnostictools/${group.entityId}/memoryallocation`, { time });
    const unavailable = (reason) => format.sections(
      header,
      `_No allocation data: ${reason}_`,
      format.footer({ next: 'call `cpu_by_process_group` to see which process groups support memory profiling (they list `memory`), or `process_runtime` with this process group for heap and GC metrics.', link }),
    );

    let data;
    try {
      data = await ctx.get(
        `/rest/codelevelanalysis/memoryallocation/${group.entityId}`,
        { survivorsOnly: String(survivorsOnly), ...time.analysisQuery },
        { label: `Memory allocation of ${group.displayName}`, timeoutMs: 180000, maxBytes: MEMORY_MAX_BYTES },
      );
    } catch (error) {
      if (profilingUnavailable(error, ctx)) return unavailable(`memory profiling is not enabled for ${group.displayName} (Dynatrace: ${format.truncate(error.detail || error.message, 160)}).`);
      if (error instanceof ctx.BridgeError && error.code === 'RESPONSE_TOO_LARGE') {
        return format.sections(
          header,
          `_The allocation call tree of ${group.displayName} for this window is larger than the bridge relays (Dynatrace answers with more than 100 MB for busy process groups)._ Nothing is wrong with the process group; the window is too long.`,
          format.footer({ next: `call \`memory_allocation_hotspots\` again with a shorter window (e.g. \`minutes_lookback: ${Math.max(1, Math.floor(time.durationMs / 60000 / 3))}\`, or \`time_from\` / \`time_to\` a few minutes apart around the moment of interest)${survivorsOnly ? '' : ', or with `survivors_only: true`'}.`, link }),
        );
      }
      throw error;
    }
    ctx.expectShape(data, ['analysisResult.stacktree[]', 'analysisResult.overallAllocationInfo'], 'GET /rest/codelevelanalysis/memoryallocation/{id}');

    const result = data.analysisResult;
    const metadata = data.serviceAnalysisResultMetadata;
    const overall = result.overallAllocationInfo;
    const feature = featureDescription(metadata);
    if (metadata?.agentFeatureFlagActive === false) {
      return unavailable(`memory profiling is not enabled for ${group.displayName}: ${feature} is switched off.`);
    }
    if (result.stacktree.length === 0 && !(overall.allocationCount > 0)) {
      return unavailable(`Dynatrace recorded no allocations for ${group.displayName} in this window. Memory profiling ${feature} is not enabled or not supported for this process group's technology, or the processes were idle.`);
    }

    const limit = ctx.limit(args.limit, 15, 100);
    const basis = survivorsOnly ? 'survivorSize' : 'allocationSize';
    const share = (info) => format.percent(ratio(info?.[basis], overall[basis]), { ratio: true });
    const methods = [...result.stacktree].sort((a, b) => (b.allocationInfo?.[basis] || 0) - (a.allocationInfo?.[basis] || 0));
    const { shown, omitted } = format.cap(methods, limit);
    const methodRows = shown.map(node => [
      node.name,
      node.apiInfo?.displayName || '',
      format.bytes(node.allocationInfo?.allocationSize),
      share(node.allocationInfo),
      format.count(node.allocationInfo?.allocationCount),
      format.bytes(node.allocationInfo?.survivorSize),
      topTypes(node.types, format),
    ]);
    const callers = shown.slice(0, 5)
      .map(node => ({ node, chain: callerChain(node) }))
      .filter(({ chain }) => chain.length > 0)
      .map(({ node, chain }) => `- ${node.name} ← ${chain.join(' ← ')}`);
    const apiRows = (Array.isArray(result.apiStackTree) ? result.apiStackTree : [])
      .map(node => [
        node.apiInfo?.displayName || node.name,
        format.bytes(node.allocationInfo?.allocationSize),
        share(node.allocationInfo),
        format.count(node.allocationInfo?.allocationCount),
        format.bytes(node.allocationInfo?.survivorSize),
      ]);
    const types = format.cap(typeTotals(result.stacktree), limit);
    const typeRows = types.shown.map(t => [t.type, format.bytes(t.allocationSize), format.count(t.allocationCount), format.bytes(t.survivorSize), format.count(t.survivorCount)]);
    const gc = seriesOf(result.gcCount);
    const gcTotal = sum(gc.values);
    const notes = format.analysisWarnings(metadata);

    return format.sections(
      header,
      [
        `- Allocated: ${format.bytes(overall.allocationSize)} in ${format.count(overall.allocationCount)} objects`,
        `- Survived a garbage collection: ${format.bytes(overall.survivorSize)} in ${format.count(overall.survivorCount)} objects (${format.percent(ratio(overall.survivorSize, overall.allocationSize), { ratio: true })} of the allocated bytes)`,
        gc.values.length ? `- Garbage collections in the window: ${format.count(gcTotal)}` : null,
        isNumber(result.numOfPGIs) ? `- Process instances: ${result.numOfPGIs}` : null,
      ].filter(Boolean).join('\n'),
      format.warningLine(notes),
      apiRows.length ? `## By API\n\n${format.table(['API', 'allocated', 'share', 'objects', 'survived'], apiRows)}` : null,
      `## Top allocating methods (share of ${survivorsOnly ? 'surviving' : 'allocated'} bytes)\n\n${format.table(['allocating method', 'API', 'allocated', 'share', 'objects', 'survived', 'top types'], methodRows)}`,
      format.omittedNote(omitted),
      callers.length ? `## Main callers (allocating method ← caller ← caller)\n\n${callers.join('\n')}` : null,
      typeRows.length ? `## Most allocated types (within the ${result.stacktree.length} methods Dynatrace returned)\n\n${format.table(['type', 'allocated', 'objects', 'survived', 'surviving objects'], typeRows)}` : null,
      format.omittedNote(types.omitted, 'raise `limit` to see more types'),
      format.footer({
        next: survivorsOnly
          ? `call \`method_hotspots\` with \`process_group: "${group.entityId}"\` to see whether the allocating methods are also CPU hotspots.`
          : 'call `memory_allocation_hotspots` with `survivors_only: true` to focus on objects that stay on the heap, or `method_hotspots` for CPU hotspots of the same process group.',
        link,
      }),
    );
  },
};

function flattenScalars(value, prefix = '', depth = 0, out = []) {
  for (const [key, entry] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry === null || entry === undefined || entry === '') continue;
    if (Array.isArray(entry)) {
      if (entry.length && entry.every(item => typeof item !== 'object')) out.push([path, entry.join(', ')]);
    } else if (typeof entry === 'object') {
      if (depth < 2) flattenScalars(entry, path, depth + 1, out);
    } else {
      out.push([path, entry]);
    }
  }
  return out;
}

function describeCrash(item) {
  const fields = flattenScalars(item);
  const used = new Set();
  const take = (test) => {
    const hit = fields.find(([path, value]) => !used.has(path) && test(path.split('.').pop().toLowerCase(), value));
    if (!hit) return null;
    used.add(hit[0]);
    return hit[1];
  };
  const idOf = (type) => take((key, value) => typeof value === 'string' && ENTITY_ID.test(value) && value.startsWith(`${type}-`));
  const isName = (value) => typeof value === 'string' && !ENTITY_ID.test(value);
  const crash = {
    time: take((key, value) => isNumber(value) && value > 1e11 && /time|tms$|^start|^date/.test(key)),
    processId: idOf('PROCESS_GROUP_INSTANCE'),
    processGroupId: idOf('PROCESS_GROUP'),
    hostId: idOf('HOST'),
    podId: idOf('CLOUD_APPLICATION_INSTANCE'),
    process: take((key, value) => isName(value) && /^(process|pgi|processgroupinstance)(display)?name$|^process$/.test(key)),
    host: take((key, value) => isName(value) && /^host(display)?name$|^host$/.test(key)),
    pod: take((key, value) => isName(value) && /pod/.test(key)),
    signal: take((key) => /signal/.test(key)),
    exception: take((key) => /exception|reason|cause|crashtype/.test(key)),
    exitCode: take((key) => /exitcode|returncode/.test(key)),
  };
  if (!crash.process) crash.process = take((key, value) => isName(value) && /^(name|displayname|entityname)$/.test(key));
  crash.other = fields.filter(([path, value]) => !used.has(path) && typeof value !== 'boolean').slice(0, 6);
  return crash;
}

const listProcessCrashes = {
  name: 'list_process_crashes',
  description: [
    'Lists the process crashes Dynatrace detected in the window: time, crashed process, host or pod, and the signal or exception, with entity ids for follow-up. The field layout of this internal endpoint is not verified: the columns are matched by field name, and every field that was not recognised is printed under `details`, so nothing is hidden.',
    '',
    'Use it when a service became unavailable, a pod restarted, or a problem mentions a crash. Follow up with `get_process` / `get_host` on the ids, `pod_events` for Kubernetes restarts, or `list_problems` for the same window.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Only crashes whose process, host, pod, signal or exception contains this text (case-insensitive).' },
      limit: ctx.schema.limit(25, 'crashes', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const query = { gtf: time.gtf, gf: 'all' };
    const data = await ctx.get('/rest/globalAnalysis/processCrash', { crashfilter: 'false', ...query }, { label: 'Process crashes' });
    ctx.expectShape(data, ['crashItems[]'], 'GET /rest/globalAnalysis/processCrash');

    const crashes = data.crashItems.map(describeCrash);
    const ids = crashes.flatMap(c => [c.processId, c.processGroupId, c.hostId, c.podId]).filter(Boolean);
    const names = ids.length ? await ctx.entities.names(ids, { time }) : new Map();
    const named = (name, id) => {
      const label = name || names.get(id) || '';
      return [label, id ? `\`${id}\`` : ''].filter(Boolean).join(' ') || '-';
    };
    const text = lower(args.text);
    const all = crashes
      .map(c => ({
        time: c.time,
        cells: [
          c.time ? format.utc(c.time) : '-',
          named(c.process, c.processId || c.processGroupId),
          [named(c.host, c.hostId), c.pod || c.podId ? `pod ${named(c.pod, c.podId)}` : null].filter(part => part && part !== '-').join(', ') || '-',
          [c.signal, c.exception, c.exitCode !== null ? `exit code ${c.exitCode}` : null].filter(part => part !== null && part !== '').join(', ') || '-',
          c.other.map(([path, value]) => `${path}: ${format.truncate(value, 80)}`).join('; '),
        ],
      }))
      .filter(row => !text || row.cells.join(' ').toLowerCase().includes(text))
      .sort((a, b) => (b.time || 0) - (a.time || 0));
    const { shown, omitted } = format.cap(all, ctx.limit(args.limit, 25, 200));
    const total = isNumber(data.totalCrashCount) ? data.totalCrashCount : data.crashItems.length;

    let distribution = null;
    if (total > 0) {
      const chart = await ctx.attempt(() => ctx.get('/rest/globalAnalysis/globalAnalysisChart', { eventType: 'PGI_CRASHED_INFO', ...query }, { label: 'Process crashes over time' }));
      const series = seriesOf(chart.value?.dataPoints);
      const slots = series.timestamps
        .map((timestamp, i) => ({ timestamp, value: series.values[i] }))
        .filter(slot => slot.value > 0);
      if (chart.note) distribution = `_Crashes over time unavailable: ${format.truncate(chart.note, 200)}_`;
      else if (slots.length) distribution = `## Crashes over time\n\n${slots.map(slot => `- ${format.utc(slot.timestamp, { seconds: false })}: ${format.count(slot.value)}`).join('\n')}`;
    }

    return format.sections(
      ctx.header('Process crashes', { time, details: [args.text ? `matching "${args.text}"` : null, `${shown.length} of ${text ? all.length : total}`] }),
      shown.length
        ? format.table(['time (UTC)', 'process', 'host / pod', 'signal / exception', 'details'], shown.map(row => row.cells))
        : (total > 0 ? '_No crash matched the text._' : '_No process crashes in this window._'),
      format.omittedNote(omitted),
      shown.length ? format.assumedNote(['the columns were filled by matching the field names of the crash list (time, process, host, pod, signal, exception, exit code); fields that matched nothing are under `details` with their own names']) : null,
      names.note,
      distribution,
      format.footer({
        next: shown.length ? 'call `get_process` or `get_host` with an id from the table, `pod_events` for Kubernetes restarts around the crash time, or `list_problems` for the same window.' : null,
        link: ctx.link('#processcrashesglobal', { time }),
      }),
    );
  },
};

async function dashboardList(ctx) {
  const data = await ctx.get('/rest/dashboards/list', {}, { label: 'Listing dashboards' });
  ctx.expectShape(data, ['dashboards[]'], 'GET /rest/dashboards/list');
  return data.dashboards;
}

const listDashboards = {
  name: 'list_dashboards',
  order: DASHBOARD_ORDER,
  description: [
    'Lists the Dynatrace dashboards visible to the user: id, name, owner, last modification and tags. Filter with `text` (matches name, owner and tags).',
    '',
    'Follow up with `get_dashboard` (id or name) to see the tiles and the metric selectors behind the charts.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Only dashboards whose name, owner or tags contain this text (case-insensitive).' },
      limit: ctx.schema.limit(50, 'dashboards', 300),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const dashboards = await dashboardList(ctx);
    const text = lower(args.text);
    const matching = dashboards
      .filter(d => !text || `${d.name} ${d.owner} ${(d.tags || []).join(' ')}`.toLowerCase().includes(text))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const { shown, omitted } = format.cap(matching, ctx.limit(args.limit, 50, 300));
    const rows = shown.map(d => [
      d.id,
      d.name,
      d.owner || '',
      d.lastModified ? format.utc(d.lastModified, { seconds: false }) : '',
      (d.tags || []).join(', '),
      [d.preset ? 'preset' : null, d.userFavorite ? 'favorite' : null].filter(Boolean).join(', '),
    ]);
    return format.sections(
      ctx.header('Dashboards', { details: [args.text ? `matching "${args.text}"` : null, `${shown.length} of ${matching.length}`] }),
      format.table(['id', 'name', 'owner', 'modified (UTC)', 'tags', 'flags'], rows) || '_No dashboard matched._',
      format.omittedNote(omitted),
      format.footer({
        next: rows.length ? 'call `get_dashboard` with `dashboard` set to an id (or a unique name) for its tiles and metric selectors.' : null,
        link: ctx.link('ui/dashboards'),
      }),
    );
  },
};

async function resolveDashboardId(reference, ctx) {
  const value = String(reference).trim();
  if (DASHBOARD_ID.test(value)) return value;
  const dashboards = await dashboardList(ctx);
  const wanted = value.toLowerCase();
  const exact = dashboards.filter(d => String(d.name).toLowerCase() === wanted);
  const matches = exact.length ? exact : dashboards.filter(d => String(d.name).toLowerCase().includes(wanted));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) throw new Error(`No dashboard named "${value}" found. Call list_dashboards to see the available dashboards.`);
  throw new Error(`"${value}" matches ${matches.length} dashboards. Pass the id of the one you mean:\n${matches.slice(0, 20).map(d => `- \`${d.id}\` ${d.name} (owner ${d.owner || 'unknown'})`).join('\n')}`);
}

function expressionSelector(expression) {
  return String(expression).replace(/^resolution=[^&]*&/, '');
}

function tileQueries(config) {
  const queries = (Array.isArray(config?.queries) ? config.queries : []).map(q => ({
    id: q.id || '',
    enabled: q.enabled !== false,
    selector: typeof q.metricSelector === 'string' && q.metricSelector.trim() ? q.metricSelector.trim() : null,
    builder: [q.metric, q.spaceAggregation, Array.isArray(q.splitBy) && q.splitBy.length ? `split by ${q.splitBy.join(', ')}` : null].filter(Boolean).join(', '),
  }));
  if (queries.some(q => q.enabled && !q.selector)) {
    const known = new Set(queries.map(q => q.selector).filter(Boolean));
    const expressions = [...new Set((Array.isArray(config?.metricExpressions) ? config.metricExpressions : []).map(expressionSelector))]
      .filter(selector => selector && ![...known].some(k => selector.includes(k)));
    expressions.forEach((selector, i) => queries.push({ id: `expression ${i + 1}`, enabled: true, selector, builder: '' }));
  }
  return queries;
}

async function loadTileConfigs(dashboardId, tiles, ctx) {
  const configs = new Map();
  const failures = [];
  for (const tile of tiles) {
    if (!PATH_SEGMENT.test(String(tile.id))) {
      failures.push(`tile ${tile.id}: its id cannot be used in a request path`);
      continue;
    }
    const { value, note } = await ctx.attempt(() => ctx.get(`/rest/config/dashboards/${dashboardId}/tiles/${tile.id}`, {}, { label: `Dashboard tile ${tile.id}` }));
    if (note) failures.push(`tile ${tile.id}: ${ctx.format.truncate(note, 160)}`);
    else configs.set(tile.id, value && typeof value === 'object' ? ctx.format.maskSecrets(value) : {});
  }
  return { configs, failures };
}

async function runTileQuery(entry, time, ctx) {
  const { format } = ctx;
  const title = `### Tile ${entry.tile.id}${entry.title ? ` "${entry.title}"` : ''}, query ${entry.query.id}`;
  try {
    const data = await ctx.get('/rest/v2/metrics/query', { metricSelector: entry.query.selector, ...time.v2Query }, { label: `Running tile ${entry.tile.id} query ${entry.query.id}` });
    const series = format.metricSeries(data).flatMap(metric => metric.series);
    return `${title}\n\n${format.seriesReport(series, { buckets: 12, maxSeries: 5, columns: 3 })}`;
  } catch (error) {
    if (!(error instanceof ctx.BridgeError) || error.code !== 'HTTP_ERROR') throw error;
    return `${title}\nQuery failed: ${format.truncate(error.message, 300)}`;
  }
}

const getDashboard = {
  name: 'get_dashboard',
  order: DASHBOARD_ORDER,
  description: [
    'Shows one Dynatrace dashboard: owner, tags and every tile with its type and title, and for chart (Data Explorer) tiles the metric selectors behind them, so the same data can be read with `query_metrics`.',
    '',
    '`dashboard` is an id from `list_dashboards` or a name (an ambiguous name returns the candidates). Reading the queries of a chart tile costs one request to Dynatrace per tile, so only the first `tile_details` chart tiles (12 by default, at most 30) get their queries; the others are listed without them, and the output names the tile ids to pass as `tile` to read those next. `run_queries: true` executes up to `max_queries` of the tile selectors over the time window and prints each as summarised series.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      dashboard: { type: 'string', description: 'Dashboard id (UUID from `list_dashboards`) or name.' },
      run_queries: { type: 'boolean', description: 'Also run the tile metric selectors and print summarised series. Default false.' },
      max_queries: { type: 'number', description: 'Maximum number of tile queries to run with `run_queries`. Default 5, at most 20.' },
      tile: { type: 'array', items: { type: 'string' }, description: `Tile ids (from the tiles table) whose queries to read, at most ${MAX_TILE_DETAILS} per call. The table then lists only these tiles. Default: the first \`tile_details\` chart tiles in reading order.` },
      tile_details: { type: 'number', description: `How many chart tiles get their queries read when \`tile\` is not given; each costs one request to Dynatrace. Default ${DEFAULT_TILE_DETAILS}, at most ${MAX_TILE_DETAILS}.` },
      limit: ctx.schema.limit(60, 'tiles in the table', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['dashboard'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const id = await resolveDashboardId(args.dashboard, ctx);
    let data;
    try {
      data = await ctx.get(`/rest/dashboards/${id}`, {}, { label: `Dashboard ${id}` });
    } catch (error) {
      if (error instanceof ctx.BridgeError && error.code === 'HTTP_ERROR' && (error.status === 404 || error.status === 400)) {
        throw new Error(`No dashboard \`${id}\` found. Call list_dashboards to see the available dashboards.`);
      }
      throw error;
    }
    ctx.expectShape(data, ['tiles[]'], 'GET /rest/dashboards/{id}');

    const ordered = [...data.tiles].sort((a, b) => (a.bounds?.top ?? 0) - (b.bounds?.top ?? 0) || (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0));
    const isChart = (tile) => CHART_TILE_TYPES.includes(tile.tileType);
    const wantedIds = [...new Set((Array.isArray(args.tile) ? args.tile : []).map(tileId => String(tileId).trim()).filter(Boolean))];
    if (wantedIds.length > MAX_TILE_DETAILS) throw new Error(`\`tile\` takes at most ${MAX_TILE_DETAILS} tile ids per call, got ${wantedIds.length}`);
    const unknownIds = wantedIds.filter(tileId => !ordered.some(tile => String(tile.id) === tileId));
    if (unknownIds.length) {
      throw new Error(`\`tile\`: this dashboard has no tile ${unknownIds.join(', ')}. Its tile ids: ${format.truncate(ordered.map(tile => tile.id).join(', '), 600)}`);
    }
    const listed = wantedIds.length ? ordered.filter(tile => wantedIds.includes(String(tile.id))) : ordered;
    const { shown, omitted } = format.cap(listed, ctx.limit(args.limit, 60, 200));
    const charts = ordered.filter(isChart);
    const detailed = wantedIds.length ? listed.filter(isChart) : charts.slice(0, ctx.limit(args.tile_details, DEFAULT_TILE_DETAILS, MAX_TILE_DETAILS, 'tile_details'));
    const pending = charts.filter(tile => !detailed.includes(tile));
    const { configs, failures } = await loadTileConfigs(id, detailed, ctx);

    const entries = [];
    for (const tile of detailed) {
      const config = configs.get(tile.id);
      for (const query of config ? tileQueries(config) : []) entries.push({ tile, title: config?.customName || tile.name || config?.name || '', query });
    }
    const rows = shown.map((tile) => {
      const config = configs.get(tile.id);
      const title = config?.customName || tile.name || config?.name || '';
      const queries = entries.filter(entry => entry.tile === tile).map(entry => entry.query.id).join(', ');
      return [tile.id, tile.tileType, title, config?.visualConfig?.type || '', pending.includes(tile) ? 'not read' : queries];
    });
    const pendingIds = pending.map(tile => String(tile.id));
    const pendingNote = !pending.length ? null : (wantedIds.length
      ? `_${pending.length} other chart tiles of this dashboard were not read; call \`get_dashboard\` without \`tile\` for the list of all tiles._`
      : `_The queries of ${detailed.length} of ${charts.length} chart tiles were read (one request to Dynatrace per tile). To read the others call \`get_dashboard\` again with \`tile: [${pendingIds.slice(0, MAX_TILE_DETAILS).map(tileId => `"${tileId}"`).join(', ')}]\`${pendingIds.length > MAX_TILE_DETAILS ? ` (the next ${MAX_TILE_DETAILS} of ${pendingIds.length}; at most ${MAX_TILE_DETAILS} per call)` : ''}._`);
    const notCharts = wantedIds.length ? listed.filter(tile => !isChart(tile)) : [];
    const selectorLines = entries.map(({ tile, title, query }) => {
      const lead = `- Tile ${tile.id}${title ? ` "${title}"` : ''}, query ${query.id}${query.enabled ? '' : ' (disabled)'}: `;
      return query.selector ? `${lead}\`${query.selector}\`` : `${lead}no metric selector stored (${query.builder || 'query builder mode'})`;
    });

    const runnable = entries.filter(entry => entry.query.enabled && entry.query.selector);
    const toRun = args.run_queries === true ? format.cap(runnable, ctx.limit(args.max_queries, 5, 20, 'max_queries')) : { shown: [], omitted: 0 };
    const results = [];
    for (const entry of toRun.shown) results.push(await runTileQuery(entry, time, ctx));

    const types = [...new Set(data.tiles.map(tile => tile.tileType))].map(type => `${data.tiles.filter(tile => tile.tileType === type).length} ${type}`);
    return format.sections(
      ctx.header(`Dashboard: ${data.name || id}`, { time: args.run_queries === true ? time : null, details: [id, `${data.tiles.length} tiles`] }),
      [
        data.owner ? `- Owner: ${data.owner}` : null,
        data.lastModified ? `- Last modified: ${format.utc(data.lastModified)}` : null,
        Array.isArray(data.tags) && data.tags.length ? `- Tags: ${data.tags.join(', ')}` : null,
        data.timeframe ? `- Dashboard timeframe: ${data.timeframe}` : null,
        types.length ? `- Tile types: ${types.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      `## Tiles (reading order${wantedIds.length ? `, the ${listed.length} requested of ${ordered.length}` : ''})\n\n${format.table(['tile', 'type', 'title', 'chart', 'queries'], rows) || '_This dashboard has no tiles._'}`,
      format.omittedNote(omitted, 'raise `limit` (at most 200) to see more tiles'),
      pendingNote,
      notCharts.length ? `_${notCharts.map(tile => `Tile ${tile.id} is a ${tile.tileType} tile`).join('; ')}: only ${CHART_TILE_TYPES.join(', ')} tiles have queries._` : null,
      selectorLines.length ? `## Metric selectors behind the chart tiles\n\n${selectorLines.join('\n')}` : null,
      failures.length ? `_Tile definitions that could not be read: ${failures.join('; ')}_` : null,
      results.length ? `## Query results (${time.describe})\n\n${results.join('\n\n')}` : null,
      format.omittedNote(toRun.omitted, 'tile queries not run; raise `max_queries` (at most 20) or pass fewer tiles as `tile`'),
      format.footer({
        next: runnable.length
          ? 'call `query_metrics` with `selector` set to one of these selectors, optionally with another window or an `entity_selector`.'
          : null,
        link: ctx.link('#dashboard', { params: { id }, time: args.run_queries === true ? time : null }),
      }),
    );
  },
};

export const tools = defineTools([cpuByProcessGroup, methodHotspots, threadAnalysis, memoryAllocationHotspots, listProcessCrashes, listDashboards, getDashboard]);
