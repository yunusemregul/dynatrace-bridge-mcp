import { BRIDGE_NOTE, metricSelector, plural, truncateStart as shorten } from '../format.js';
import { defineTools } from '../context.js';

export const order = 20;

const { splitBy: split, eq, in: inSelector } = metricSelector;

const TYPE = {
  workload: 'CLOUD_APPLICATION',
  pod: 'CLOUD_APPLICATION_INSTANCE',
  container: 'CONTAINER_GROUP_INSTANCE',
  process: 'PROCESS_GROUP_INSTANCE',
  processGroup: 'PROCESS_GROUP',
  host: 'HOST',
  cluster: 'KUBERNETES_CLUSTER',
};

const DIM = {
  workload: 'dt.entity.cloud_application',
  pod: 'dt.entity.cloud_application_instance',
  container: 'dt.entity.container_group_instance',
  process: 'dt.entity.process_group_instance',
  host: 'dt.entity.host',
  disk: 'dt.entity.disk',
  containerName: 'k8s.container.name',
  pool: 'poolname',
};

const TARGETS = {
  workload: { type: TYPE.workload, word: 'workload' },
  pod: { type: TYPE.pod, word: 'pod' },
  process_group: { type: TYPE.processGroup, word: 'process group' },
  process: { type: TYPE.process, word: 'process' },
};

const WORKLOAD_FIELDS = ['properties.namespaceName', 'properties.cloudApplicationDeploymentTypes', 'toRelationships.isClusterOfCa'];

const POD_FIELDS = [
  'properties.cloudApplicationInstancePhase',
  'properties.nodeName',
  'properties.internalIpAddresses',
  'properties.containerRestartCount',
  'properties.resourceCreationTimestamp',
  'properties.requestsCPU',
  'properties.limitsCPU',
  'properties.requestsMemory',
  'properties.limitsMemory',
  'properties.desiredContainersCount',
  'properties.runningContainersCount',
  'properties.namespaceName',
  'properties.workloadName',
  'fromRelationships.isInstanceOf',
];

const CONTAINER_FIELDS = ['properties.containerNames', 'properties.containerImageName', 'fromRelationships.isCgiOfCai'];

const PROCESS_FIELDS = [
  'properties.softwareTechnologies',
  'properties.processType',
  'fromRelationships.isInstanceOf',
  'fromRelationships.isPgiOfCgi',
  'fromRelationships.isProcessOf',
];

const WORKLOAD_METRICS = {
  podsDesired: 'builtin:kubernetes.workload.pods_desired',
  cpuUsage: 'builtin:kubernetes.workload.cpu_usage',
  cpuRequests: 'builtin:kubernetes.workload.requests_cpu',
  cpuLimits: 'builtin:kubernetes.workload.limits_cpu',
  memoryWorkingSet: 'builtin:kubernetes.workload.memory_working_set',
  memoryRequests: 'builtin:kubernetes.workload.requests_memory',
  memoryLimits: 'builtin:kubernetes.workload.limits_memory',
};

const CONTAINER_METRICS = {
  cpuUsage: 'builtin:containers.cpu.usageMilliCores',
  cpuThrottled: 'builtin:containers.cpu.throttledMilliCores',
  memoryResident: 'builtin:containers.memory.residentSetBytes',
  memoryPercent: 'builtin:containers.memory.usagePercent',
  memoryLimit: 'builtin:containers.memory.limitBytes',
};

const POD_METRICS = {
  restarts: 'builtin:kubernetes.container.restarts',
  oomKills: 'builtin:kubernetes.container.oom_kills',
};

const PROCESS_METRICS = {
  cpu: 'builtin:tech.generic.cpu.usage',
  memory: 'builtin:tech.generic.mem.workingSetSize',
};

const HOST_METRICS = {
  cpu: 'builtin:host.cpu.usage',
  memory: 'builtin:host.mem.usage',
  disk: 'builtin:host.disk.usedPct',
};

const JVM_METRICS = {
  heapTotal: 'builtin:tech.jvm.memory.runtime.total',
  heapFree: 'builtin:tech.jvm.memory.runtime.free',
  heapMax: 'builtin:tech.jvm.memory.runtime.max',
  poolUsed: 'builtin:tech.jvm.memory.pool.used',
  gcSuspension: 'builtin:tech.jvm.memory.gc.suspensionTime',
  gcTime: 'builtin:tech.jvm.memory.gc.collectionTime',
  threads: 'builtin:tech.jvm.threads.count',
};

const NODEJS_METRICS = {
  heapUsed: 'builtin:tech.nodejs.v8heap.used',
  heapTotal: 'builtin:tech.nodejs.v8heap.total',
  rss: 'builtin:tech.nodejs.v8heap.rss',
  loopUtilization: 'builtin:tech.nodejs.uvLoop.utilization',
  loopLatency: 'builtin:tech.nodejs.uvLoop.loopLatency',
};

const RUNTIMES = {
  jvm: {
    title: 'JVM',
    selectors: [
      ...[JVM_METRICS.heapTotal, JVM_METRICS.heapFree, JVM_METRICS.heapMax, JVM_METRICS.gcSuspension, JVM_METRICS.gcTime, JVM_METRICS.threads].map(key => `${key}${split(DIM.process)}`),
      `${JVM_METRICS.poolUsed}${split(DIM.process, DIM.pool)}`,
    ],
    sections: [
      { title: 'Heap used (runtime total minus free)', key: 'heapUsed', unitOf: JVM_METRICS.heapTotal, unit: 'Byte' },
      { title: 'Heap max', key: JVM_METRICS.heapMax, unit: 'Byte', statsOnly: true },
      { title: 'Memory pools used', key: JVM_METRICS.poolUsed, unit: 'Byte', statsOnly: true },
      { title: 'GC suspension', key: JVM_METRICS.gcSuspension, unit: 'Percent' },
      { title: 'GC collection time', key: JVM_METRICS.gcTime, unit: 'MilliSecond', statsOnly: true },
      { title: 'Threads', key: JVM_METRICS.threads, unit: 'Count', statsOnly: true },
    ],
  },
  nodejs: {
    title: 'Node.js',
    selectors: Object.values(NODEJS_METRICS).map(key => `${key}${split(DIM.process)}`),
    sections: [
      { title: 'V8 heap used', key: NODEJS_METRICS.heapUsed, unit: 'Byte' },
      { title: 'V8 heap total', key: NODEJS_METRICS.heapTotal, unit: 'Byte', statsOnly: true },
      { title: 'Process memory (RSS)', key: NODEJS_METRICS.rss, unit: 'Byte', statsOnly: true },
      { title: 'Event loop utilization', key: NODEJS_METRICS.loopUtilization, unit: 'Percent' },
      { title: 'Event loop latency', key: NODEJS_METRICS.loopLatency, unit: 'NanoSecond', statsOnly: true },
    ],
  },
  generic: { title: 'Other', selectors: [], sections: [] },
};

const COMMON_RUNTIME_SECTIONS = [
  { title: 'CPU usage', key: PROCESS_METRICS.cpu, unit: 'Percent' },
  { title: 'Memory (working set)', key: PROCESS_METRICS.memory, unit: 'Byte', statsOnly: true },
];

const NEAR_LIMIT_PERCENT = 90;
const THROTTLE_MIN_MILLICORES = 100;
const THROTTLE_MIN_SHARE = 0.1;
const GC_SUSPENSION_PERCENT = 10;
const EVENT_LOOP_PERCENT = 90;
const MAX_RUNTIME_PROCESSES = 30;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const DAY_MS = 86400000;
const age = (millis, format) => (millis >= 2 * DAY_MS ? `${format.number(millis / DAY_MS)} d` : format.durationMs(millis));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const strip = (value, prefix) => (typeof value === 'string' ? value.replace(prefix, '') : '');
const refText = (ref) => (ref.name ? `\`${ref.id}\` ${ref.name}` : `\`${ref.id}\``);

function related(entity, side, relation) {
  return (entity?.[side]?.[relation] || []).map(r => (typeof r === 'string' ? r : r?.id)).filter(Boolean);
}

function workloadType(entity) {
  const types = [entity.properties?.cloudApplicationDeploymentTypes, entity.properties?.workloadType].flat();
  return [...new Set(types.filter(Boolean).map(t => strip(String(t), /^KUBERNETES_/)))].join(', ');
}

function technologyText(tech) {
  if (!tech) return '';
  return [tech.verbatimType || tech.type, tech.edition, tech.version].filter(Boolean).join(' ');
}

function technologiesText(list) {
  const texts = [...new Set((Array.isArray(list) ? list : []).map(technologyText).filter(Boolean))];
  return texts.filter(text => !texts.some(other => other !== text && other.startsWith(`${text} `))).join(', ');
}

async function resolveTarget(args, ctx, time, allowed, fields = {}) {
  const { key, entity } = await ctx.entities.resolveOne(args, Object.fromEntries(allowed.map(kind => [kind, TARGETS[kind].type])), { time, fields });
  return { kind: key, entity, word: TARGETS[key].word, title: `${TARGETS[key].word} ${entity.displayName}` };
}

async function listByRelation(ctx, type, relation, ids, options) {
  const { entities } = await ctx.entities.listByIds(ids, { ...options, selector: chunk => `type(${type}),${relation}(${ctx.entities.idSelector(chunk)})` });
  return entities;
}

function queryMetrics(ctx, { selectors, ...options }) {
  return ctx.metrics.query(selectors, options);
}

async function fetchEvents(ctx, entitySelector, time, label, limit = 1000) {
  return ctx.v2List('/rest/v2/events', { entitySelector, ...time.v2Query }, { itemsKey: 'events', limit, label });
}

async function optional(ctx, what, fallback, run) {
  const { value, note } = await ctx.attempt(run, fallback);
  return { value, note: note ? `_${what} unavailable: ${note}_` : null };
}

async function internalDetail(ctx, path, shape, time, label) {
  const endpoint = `GET ${path.replace(/[A-Z_]+-[0-9A-F]{16}/, '{id}')}`;
  const { value, note, status } = await ctx.attempt(async () => ctx.expectShape(await ctx.get(path, time.analysisQuery, { label }), shape, endpoint));
  if (!note) return { data: value, note: null };
  return { data: null, note: `_Note: ${status ? `the internal endpoint ${endpoint} answered HTTP ${status}.` : note} Showing the documented API data only._` };
}

function sumSeries(list) {
  const totals = new Map();
  for (const series of list) {
    series.timestamps.forEach((t, i) => {
      if (isNumber(series.values[i])) totals.set(t, (totals.get(t) || 0) + series.values[i]);
    });
  }
  const timestamps = [...totals.keys()].sort((a, b) => a - b);
  return { timestamps, values: timestamps.map(t => totals.get(t)) };
}

function subtractSeries(minuend, subtrahend) {
  const lookup = new Map(subtrahend.timestamps.map((t, i) => [t, subtrahend.values[i]]));
  return {
    timestamps: minuend.timestamps,
    values: minuend.timestamps.map((t, i) => (isNumber(minuend.values[i]) && isNumber(lookup.get(t)) ? minuend.values[i] - lookup.get(t) : null)),
  };
}

function statsOf(list, format) {
  if (!list || list.length === 0) return null;
  const merged = list.length === 1 ? list[0] : sumSeries(list);
  return format.seriesStats(merged.timestamps, merged.values);
}

function seriesWhere(metrics, key, dimension, value) {
  return (metrics.get(key) || []).filter(s => s.dimensionMap[dimension] === value);
}

function totalOf(list) {
  return list.reduce((total, series) => total + series.values.reduce((sum, v) => sum + (isNumber(v) ? v : 0), 0), 0);
}

function lastOccurrence(list) {
  let last = null;
  for (const series of list) {
    series.timestamps.forEach((t, i) => {
      if (isNumber(series.values[i]) && series.values[i] > 0 && (last === null || t > last)) last = t;
    });
  }
  return last;
}

function eventProperty(event, key, format) {
  return format.eventProperties(event)[key];
}

function parseTime(value, format) {
  if (isNumber(value)) return value > 0 ? value : null;
  return format.timestamp(value);
}

function eventsTable(events, ctx, limit) {
  const { format } = ctx;
  const sorted = [...events].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  const { shown, omitted } = format.cap(sorted, limit);
  const rows = shown.map(e => [
    format.utc(e.startTime),
    isNumber(e.endTime) && e.endTime > 0 ? format.utc(e.endTime) : 'open',
    e.eventType || '',
    format.truncate(e.title || eventProperty(e, 'dt.event.title', format) || '', 160),
    e.status || '',
  ]);
  return format.sections(
    format.table(['start (UTC)', 'end (UTC)', 'type', 'title', 'status'], rows),
    format.omittedNote(omitted, 'older events not shown; narrow the time window to see them'),
  );
}

function containerModels(containers, pods) {
  const podNames = new Map(pods.map(p => [p.entityId, p.displayName]));
  return containers.map((container) => {
    const podId = related(container, 'fromRelationships', 'isCgiOfCai')[0] ?? null;
    const podName = podNames.get(podId) ?? null;
    const names = Array.isArray(container.properties?.containerNames) ? container.properties.containerNames : [];
    const fromDisplayName = podName && container.displayName.startsWith(`${podName} `) ? container.displayName.slice(podName.length + 1) : container.displayName;
    const name = names.join(', ') || fromDisplayName;
    return {
      id: container.entityId,
      podId,
      podName,
      name,
      image: container.properties?.containerImageName ?? '',
      label: podName ? `${podName} / ${name}` : container.displayName,
    };
  });
}

const listWorkloads = {
  name: 'list_workloads',
  description: [
    'Lists Kubernetes workloads (deployments, stateful sets, daemon sets, jobs; Dynatrace entity type CLOUD_APPLICATION) with workload type, namespace, cluster, running versus desired pods, and average CPU and memory usage against the configured requests and limits over the window.',
    '',
    'Filter with `name` (case-insensitive substring), `namespace` (exact) and `cluster` (cluster name or KUBERNETES_CLUSTER id). Use it to find the workload id that `list_pods`, `pod_resources`, `pod_events` and `process_runtime` take, or to spot workloads running close to their limits.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Case-insensitive substring of the workload name.' },
      namespace: { type: 'string', description: 'Kubernetes namespace, exact name (case-insensitive).' },
      cluster: ctx.schema.entity('The Kubernetes cluster', 'KUBERNETES_CLUSTER-1234567890ABCDEF'),
      limit: ctx.schema.limit(25, 'workloads', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 25, 200);
    const name = text(args.name);
    const namespace = text(args.namespace);
    const cluster = text(args.cluster) ? await ctx.entities.resolve(args.cluster, { type: TYPE.cluster, time, what: 'cluster' }) : null;
    const selector = [
      `type(${TYPE.workload})`,
      name ? `entityName.contains(${ctx.entities.quote(name)})` : null,
      cluster ? `toRelationships.isClusterOfCa(entityId(${ctx.entities.quote(cluster.entityId)}))` : null,
    ].filter(Boolean).join(',');
    const { entities, totalCount, note: fieldsNote } = await ctx.entities.list(selector, { fields: WORKLOAD_FIELDS, time, limit: 500, label: 'Listing Kubernetes workloads' });
    const matching = namespace ? entities.filter(e => String(e.properties?.namespaceName ?? '').toLowerCase() === namespace.toLowerCase()) : entities;
    const { shown, omitted } = format.cap(matching, limit);
    const details = [
      name ? `name contains "${name}"` : null,
      namespace ? `namespace ${namespace}` : null,
      cluster ? `cluster ${cluster.displayName}` : null,
      `${shown.length} of ${matching.length}`,
    ];
    const link = ctx.link(`ui/entity/list/${TYPE.workload}`, { time });
    if (shown.length === 0) {
      return format.sections(
        ctx.header('Kubernetes workloads', { time, details }),
        '_No workloads matched in this window._ Loosen `name`, drop `namespace` / `cluster`, or widen the time window.',
        format.footer({ link }),
      );
    }

    const ids = shown.map(e => e.entityId);
    const scope = selector === `type(${TYPE.workload})` ? '' : inSelector(DIM.workload, selector);
    const [pods, metrics, clusterNames, units] = await Promise.all([
      listByRelation(ctx, TYPE.pod, 'fromRelationships.isInstanceOf', ids, {
        fields: ['properties.cloudApplicationInstancePhase', 'fromRelationships.isInstanceOf'],
        time,
        limit: 2000,
        label: 'Counting pods per workload',
      }),
      optional(ctx, 'Workload metrics', new Map(), () => queryMetrics(ctx, {
        selectors: Object.values(WORKLOAD_METRICS).map(key => `${key}${scope}${split(DIM.workload)}`),
        resolution: 'Inf',
        time,
        label: 'Reading workload CPU and memory',
      })),
      ctx.entities.names(shown.flatMap(e => related(e, 'toRelationships', 'isClusterOfCa')), { time }),
      ctx.metrics.units(Object.values(WORKLOAD_METRICS), { label: 'Reading workload metric units' }),
    ]);

    const running = new Map();
    for (const pod of pods) {
      if (pod.properties?.cloudApplicationInstancePhase !== 'RUNNING') continue;
      for (const workloadId of related(pod, 'fromRelationships', 'isInstanceOf')) running.set(workloadId, (running.get(workloadId) || 0) + 1);
    }
    const average = (key, id) => statsOf(seriesWhere(metrics.value, key, DIM.workload, id), format)?.avg;
    const cpu = (key, id) => units.formatter(key, 'MilliCores')(average(key, id));
    const memory = (key, id) => units.formatter(key, 'Byte')(average(key, id));
    const rows = shown.map((e) => {
      const clusterId = related(e, 'toRelationships', 'isClusterOfCa')[0];
      return [
        e.entityId,
        e.displayName,
        workloadType(e),
        e.properties?.namespaceName ?? '',
        clusterNames.get(clusterId) ?? clusterId ?? '',
        `${running.get(e.entityId) || 0} / ${format.number(average(WORKLOAD_METRICS.podsDesired, e.entityId))}`,
        cpu(WORKLOAD_METRICS.cpuUsage, e.entityId),
        cpu(WORKLOAD_METRICS.cpuRequests, e.entityId),
        cpu(WORKLOAD_METRICS.cpuLimits, e.entityId),
        memory(WORKLOAD_METRICS.memoryWorkingSet, e.entityId),
        memory(WORKLOAD_METRICS.memoryRequests, e.entityId),
        memory(WORKLOAD_METRICS.memoryLimits, e.entityId),
      ];
    });
    return format.sections(
      ctx.header('Kubernetes workloads', { time, details }),
      format.table(['id', 'workload', 'type', 'namespace', 'cluster', 'pods running / desired', 'CPU avg', 'CPU request', 'CPU limit', 'memory avg', 'memory request', 'memory limit'], rows),
      'CPU and memory are averages over the window (memory is the working set); desired pods is the window average, running pods counts pods in phase RUNNING.',
      fieldsNote,
      metrics.note,
      metrics.note ? null : units.note(),
      clusterNames.note,
      format.omittedNote(omitted),
      totalCount > entities.length ? `_Only the first ${entities.length} of ${totalCount} workloads were read; narrow with \`name\` or \`cluster\`._` : null,
      format.footer({
        next: 'call `list_pods` with `workload` set to an id for its pods, `pod_resources` for CPU / memory / throttling / OOM kills over time, or `pod_events` for its Kubernetes events.',
        link,
      }),
    );
  },
};

const listPods = {
  name: 'list_pods',
  description: [
    'Lists Kubernetes pods (Dynatrace entity type CLOUD_APPLICATION_INSTANCE) of a workload, or pods matching a name, with phase, node, IPs, restart count, age, CPU / memory requests and limits, and the containers in each pod with their ids.',
    '',
    'Pass `workload` (id or name, from `list_workloads`) and/or `name` (substring of the pod name). Follow up with `pod_resources` for usage over time, `pod_events` for Kubernetes events, or `process_runtime` with a pod id for JVM / Node.js metrics.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      workload: ctx.schema.entity('The workload whose pods to list', 'CLOUD_APPLICATION-1234567890ABCDEF'),
      name: { type: 'string', description: 'Case-insensitive substring of the pod name. Can be combined with `workload`.' },
      limit: ctx.schema.limit(50, 'pods', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const name = text(args.name);
    if (!text(args.workload) && !name) throw new Error('pass `workload` (id or name) and/or `name` (substring of the pod name). Find workloads with list_workloads.');
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 50, 200);
    const workload = text(args.workload) ? await ctx.entities.resolve(args.workload, { type: TYPE.workload, time, what: 'workload' }) : null;
    const selector = [
      `type(${TYPE.pod})`,
      workload ? `fromRelationships.isInstanceOf(entityId(${ctx.entities.quote(workload.entityId)}))` : null,
      name ? `entityName.contains(${ctx.entities.quote(name)})` : null,
    ].filter(Boolean).join(',');
    const { entities: pods, totalCount, note: fieldsNote } = await ctx.entities.list(selector, { fields: POD_FIELDS, time, limit, label: workload ? `Pods of ${workload.displayName}` : `Pods named "${name}"` });
    const title = workload ? `Pods of workload ${workload.displayName}` : 'Pods';
    const details = [workload?.entityId, name ? `name contains "${name}"` : null, `${pods.length} of ${totalCount}`];
    const link = workload ? ctx.link(`ui/entity/${workload.entityId}`, { time }) : ctx.link(`ui/entity/list/${TYPE.pod}`, { time });
    if (pods.length === 0) {
      return format.sections(
        ctx.header(title, { time, details }),
        '_No pods matched in this window._ Pods are only listed while Dynatrace saw them inside the window; widen it or loosen `name`.',
        format.footer({ link }),
      );
    }

    const containerOptions = { fields: CONTAINER_FIELDS, time, limit: 2000, label: 'Containers of the pods' };
    const containers = workload
      ? (await ctx.entities.list(`type(${TYPE.container}),fromRelationships.isCgiOfCa(entityId(${ctx.entities.quote(workload.entityId)}))`, containerOptions)).entities
      : await listByRelation(ctx, TYPE.container, 'fromRelationships.isCgiOfCai', pods.map(p => p.entityId), containerOptions);
    const shownIds = new Set(pods.map(p => p.entityId));
    const models = containerModels(containers, pods).filter(c => shownIds.has(c.podId));

    const milliCores = format.formatterForUnit('MilliCores');
    const podRows = pods.map((pod) => {
      const p = pod.properties || {};
      return [
        pod.entityId,
        pod.displayName,
        p.cloudApplicationInstancePhase ?? '',
        p.nodeName ?? '',
        (p.internalIpAddresses || []).join(', '),
        format.count(p.containerRestartCount),
        isNumber(p.resourceCreationTimestamp) ? age(time.toMs - p.resourceCreationTimestamp, format) : '-',
        `${format.count(p.runningContainersCount)} / ${format.count(p.desiredContainersCount)}`,
        `${milliCores(p.requestsCPU)} / ${milliCores(p.limitsCPU)}`,
        `${format.bytes(p.requestsMemory)} / ${format.bytes(p.limitsMemory)}`,
        ...(workload ? [] : [p.workloadName ?? related(pod, 'fromRelationships', 'isInstanceOf')[0] ?? '']),
      ];
    });
    const podHeaders = ['id', 'pod', 'phase', 'node', 'IPs', 'restarts', 'age', 'containers running / desired', 'CPU request / limit', 'memory request / limit', ...(workload ? [] : ['workload'])];
    const withImage = models.some(c => c.image);
    const containerRows = models
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(c => [c.id, c.podName, c.name, ...(withImage ? [c.image] : [])]);
    return format.sections(
      ctx.header(title, { time, details }),
      format.table(podHeaders, podRows),
      format.omittedNote(totalCount - pods.length),
      fieldsNote,
      containerRows.length ? `## Containers\n\n${format.table(['id', 'pod', 'container', ...(withImage ? ['image'] : [])], containerRows)}` : '_No containers reported for these pods in this window._',
      format.footer({
        next: 'call `pod_resources` with `pod` (or `workload`) for CPU, throttling, memory, OOM kills and restarts over time, `pod_events` for Kubernetes events, or `process_runtime` with `pod` for JVM / Node.js metrics.',
        link,
      }),
    );
  },
};

function resourceFindings({ pods, models, containerMetrics, podMetrics, units, format }) {
  const findings = [];
  const milliCores = format.formatterForUnit('MilliCores');
  const cpuInMilliCores = units.unit(CONTAINER_METRICS.cpuUsage, 'MilliCores') === 'MilliCores';
  const throttleInMilliCores = units.unit(CONTAINER_METRICS.cpuThrottled, 'MilliCores') === 'MilliCores';
  const memoryInPercent = units.unit(CONTAINER_METRICS.memoryPercent, 'Percent') === 'Percent';
  for (const pod of pods) {
    const phase = pod.properties?.cloudApplicationInstancePhase;
    if (phase && phase !== 'RUNNING' && phase !== 'SUCCEEDED') findings.push(`**Pod not running**: ${pod.displayName} is in phase ${phase}.`);
    const own = models.filter(c => c.podId === pod.entityId);
    const usage = statsOf(own.flatMap(c => seriesWhere(containerMetrics, CONTAINER_METRICS.cpuUsage, DIM.container, c.id)), format);
    const limit = pod.properties?.limitsCPU;
    if (cpuInMilliCores && usage && isNumber(limit) && limit > 0 && usage.max >= (limit * NEAR_LIMIT_PERCENT) / 100) {
      findings.push(`**CPU near limit**: pod ${pod.displayName} peaked at ${milliCores(usage.max)} of its ${milliCores(limit)} limit at ${format.utc(usage.maxAt)} (avg ${milliCores(usage.avg)}).`);
    }
  }
  for (const container of models) {
    const memory = statsOf(seriesWhere(containerMetrics, CONTAINER_METRICS.memoryPercent, DIM.container, container.id), format);
    if (memoryInPercent && memory && memory.max >= NEAR_LIMIT_PERCENT) {
      findings.push(`**Memory near limit**: ${container.label} reached ${format.percent(memory.max)} of its memory limit at ${format.utc(memory.maxAt)} (avg ${format.percent(memory.avg)}).`);
    }
    const throttled = statsOf(seriesWhere(containerMetrics, CONTAINER_METRICS.cpuThrottled, DIM.container, container.id), format);
    const usage = statsOf(seriesWhere(containerMetrics, CONTAINER_METRICS.cpuUsage, DIM.container, container.id), format);
    const share = throttled && usage && usage.avg > 0 ? throttled.avg / usage.avg : 0;
    if (throttled && throttleInMilliCores && (throttled.max >= THROTTLE_MIN_MILLICORES || share >= THROTTLE_MIN_SHARE)) {
      findings.push(`**CPU throttling**: ${container.label} was throttled by up to ${milliCores(throttled.max)} at ${format.utc(throttled.maxAt)} (avg ${milliCores(throttled.avg)}).`);
    }
  }
  if (!cpuInMilliCores || !throttleInMilliCores || !memoryInPercent) {
    findings.push('**Not every check ran**: Dynatrace reports a container metric in a unit this tool does not expect, so the CPU limit, throttling or memory limit checks that depend on it were skipped. Read the tables below instead.');
  }
  for (const [key, word] of [[POD_METRICS.oomKills, 'OOM kills'], [POD_METRICS.restarts, 'Restarts']]) {
    for (const series of podMetrics.get(key) || []) {
      const total = totalOf([series]);
      if (total <= 0) continue;
      const podName = pods.find(p => p.entityId === series.dimensionMap[DIM.pod])?.displayName ?? series.dimensionMap[DIM.pod] ?? 'unknown pod';
      const containerName = series.dimensionMap[DIM.containerName];
      findings.push(`**${word}**: ${format.count(total)} in ${podName}${containerName ? ` / ${containerName}` : ''}, last at ${format.utc(lastOccurrence([series]))}.`);
    }
  }
  return findings;
}

const podResources = {
  name: 'pod_resources',
  description: [
    'Shows the resource behaviour of the pods of a Kubernetes workload, or of one pod, over the time window: CPU usage, CPU throttling, memory (resident set per container, working set for the workload, usage in % of the limit), OOM kills and container restarts, per pod and per container, each as a summarised series (min / avg / max with its time / last / trend and a compact table over time).',
    '',
    'Start here for "why does this pod restart / get OOM-killed / run slow": it opens with findings that flag obvious trouble: usage near the limit, significant CPU throttling, OOM kills, restarts inside the window, pods not running. Pass exactly one of `workload` or `pod` (id or name; find workloads with `list_workloads`). Narrow the window around a peak with `time_from` / `time_to`, then check `pod_events` for what Kubernetes did at that time and `process_runtime` for the JVM / Node.js view.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      workload: ctx.schema.entity('The workload whose pods to analyse', 'CLOUD_APPLICATION-1234567890ABCDEF'),
      pod: ctx.schema.entity('A single pod', 'CLOUD_APPLICATION_INSTANCE-1234567890ABCDEF'),
      max_series: { type: 'number', description: 'Maximum containers summarised per metric, ranked by average. Default 10, at most 50.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const maxSeries = ctx.limit(args.max_series, 10, 50, 'max_series');
    const target = await resolveTarget(args, ctx, time, ['workload', 'pod'], { pod: POD_FIELDS });
    const isPod = target.kind === 'pod';
    const id = target.entity.entityId;
    const quoted = ctx.entities.quote(id);
    const containerSelector = `type(${TYPE.container}),fromRelationships.${isPod ? 'isCgiOfCai' : 'isCgiOfCa'}(entityId(${quoted}))`;
    const scope = eq(isPod ? DIM.pod : DIM.workload, id);
    const [podList, containerList, containerMetrics, podMetrics, units] = await Promise.all([
      isPod
        ? { entities: [target.entity] }
        : ctx.entities.list(`type(${TYPE.pod}),fromRelationships.isInstanceOf(entityId(${quoted}))`, { fields: POD_FIELDS, time, limit: 500, label: `Pods of ${target.entity.displayName}` }),
      ctx.entities.list(containerSelector, { fields: CONTAINER_FIELDS, time, limit: 2000, label: `Containers of ${target.entity.displayName}` }),
      queryMetrics(ctx, {
        selectors: Object.values(CONTAINER_METRICS).map(key => `${key}${split(DIM.container)}`),
        entitySelector: containerSelector,
        time,
        label: `Container CPU and memory of ${target.entity.displayName}`,
      }),
      queryMetrics(ctx, {
        selectors: [
          ...Object.values(POD_METRICS).map(key => `${key}${scope}${split(DIM.pod, DIM.containerName)}`),
          ...(isPod ? [] : [WORKLOAD_METRICS.cpuUsage, WORKLOAD_METRICS.memoryWorkingSet].map(key => `${key}${scope}${split(DIM.workload)}`)),
        ],
        time,
        label: `Restarts and OOM kills of ${target.entity.displayName}`,
      }),
      ctx.metrics.units([...Object.values(CONTAINER_METRICS), WORKLOAD_METRICS.cpuUsage, WORKLOAD_METRICS.memoryWorkingSet], { label: 'Reading container metric units' }),
    ]);
    const pods = podList.entities;
    const models = containerModels(containerList.entities, pods);
    const milliCores = format.formatterForUnit('MilliCores');
    const cpuUsage = units.formatter(CONTAINER_METRICS.cpuUsage, 'MilliCores');
    const cpuThrottled = units.formatter(CONTAINER_METRICS.cpuThrottled, 'MilliCores');
    const memoryResident = units.formatter(CONTAINER_METRICS.memoryResident, 'Byte');
    const memoryLimit = units.formatter(CONTAINER_METRICS.memoryLimit, 'Byte');
    const memoryPercent = units.formatter(CONTAINER_METRICS.memoryPercent, 'Percent');
    const header = ctx.header(`Resources of ${target.title}`, { time, details: [id, plural(pods.length, 'pod'), plural(models.length, 'container')] });
    const link = ctx.link(`ui/entity/${id}`, { time });
    const hasData = [...containerMetrics.values()].some(list => list.some(s => s.values.some(isNumber)));
    if (!hasData) {
      return format.sections(
        header,
        `_No container metrics were recorded for this ${target.word} in this window._ Check with \`list_pods\` that it had pods then, or widen the time window.`,
        format.footer({ link }),
      );
    }

    const containerSeries = (key, containerId) => seriesWhere(containerMetrics, key, DIM.container, containerId);
    const eventCount = (key, podId, containerName) => totalOf((podMetrics.get(key) || [])
      .filter(s => s.dimensionMap[DIM.pod] === podId && (containerName === undefined || s.dimensionMap[DIM.containerName] === containerName)));

    const podRows = pods.map((pod) => {
      const own = models.filter(c => c.podId === pod.entityId);
      const cpu = statsOf(own.flatMap(c => containerSeries(CONTAINER_METRICS.cpuUsage, c.id)), format);
      const throttled = statsOf(own.flatMap(c => containerSeries(CONTAINER_METRICS.cpuThrottled, c.id)), format);
      const memory = statsOf(own.flatMap(c => containerSeries(CONTAINER_METRICS.memoryResident, c.id)), format);
      return [
        pod.entityId,
        pod.displayName,
        pod.properties?.cloudApplicationInstancePhase ?? '',
        cpuUsage(cpu?.avg),
        cpuUsage(cpu?.max),
        milliCores(pod.properties?.limitsCPU),
        cpuThrottled(throttled?.max),
        memoryResident(memory?.avg),
        memoryResident(memory?.max),
        format.bytes(pod.properties?.limitsMemory),
        format.count(eventCount(POD_METRICS.oomKills, pod.entityId)),
        format.count(eventCount(POD_METRICS.restarts, pod.entityId)),
        format.count(pod.properties?.containerRestartCount),
      ];
    });
    const containerRows = models
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((container) => {
        const stats = (key) => statsOf(containerSeries(key, container.id), format);
        const cpu = stats(CONTAINER_METRICS.cpuUsage);
        const memory = stats(CONTAINER_METRICS.memoryResident);
        return [
          container.id,
          container.podName ?? '',
          container.name,
          cpuUsage(cpu?.avg),
          cpuUsage(cpu?.max),
          cpuThrottled(stats(CONTAINER_METRICS.cpuThrottled)?.max),
          memoryResident(memory?.avg),
          memoryResident(memory?.max),
          memoryLimit(stats(CONTAINER_METRICS.memoryLimit)?.last),
          memoryPercent(stats(CONTAINER_METRICS.memoryPercent)?.max),
          format.count(eventCount(POD_METRICS.oomKills, container.podId, container.name)),
          format.count(eventCount(POD_METRICS.restarts, container.podId, container.name)),
        ];
      });

    const labelled = (key) => (containerMetrics.get(key) || []).map((series) => {
      const model = models.find(c => c.id === series.dimensionMap[DIM.container]);
      const label = model?.label ?? series.label;
      return { ...series, label, shortLabel: shorten(label) };
    });
    const report = (title, key, formatter, { overTime = true } = {}) => {
      const series = labelled(key);
      const anyNonZero = series.some(s => s.values.some(v => isNumber(v) && v !== 0));
      if (!anyNonZero) return `## ${title}\n\nAll values were 0 in this window.`;
      const body = format.seriesReport(series, { format: formatter, maxSeries, buckets: 12, overTime });
      return `## ${title}\n\n${body}`;
    };
    const findings = resourceFindings({ pods, models, containerMetrics, podMetrics, units, format });
    const workloadTotals = isPod ? null : [
      '## Workload totals',
      [
        format.statsLine('CPU usage', statsOf(podMetrics.get(WORKLOAD_METRICS.cpuUsage), format), units.formatter(WORKLOAD_METRICS.cpuUsage, 'MilliCores')),
        format.statsLine('Memory working set', statsOf(podMetrics.get(WORKLOAD_METRICS.memoryWorkingSet), format), units.formatter(WORKLOAD_METRICS.memoryWorkingSet, 'Byte')),
      ].join('\n'),
    ].join('\n\n');

    return format.sections(
      header,
      `## Findings\n\n${findings.length
        ? findings.map(f => `- ${f}`).join('\n')
        : `No obvious trouble: no OOM kills or restarts in the window, memory below ${NEAR_LIMIT_PERCENT} % of the limits, no significant CPU throttling.`}`,
      `## Pods\n\n${format.table(['id', 'pod', 'phase', 'CPU avg', 'CPU max', 'CPU limit', 'throttled max', 'memory avg', 'memory max', 'memory limit', 'OOM kills', 'restarts', 'restarts (lifetime)'], podRows)}`,
      `## Containers\n\n${format.table(['id', 'pod', 'container', 'CPU avg', 'CPU max', 'throttled max', 'memory avg', 'memory max', 'memory limit', 'memory % of limit (max)', 'OOM kills', 'restarts'], containerRows)}`,
      units.note(),
      workloadTotals,
      report('CPU usage per container', CONTAINER_METRICS.cpuUsage, cpuUsage),
      report('CPU throttling per container', CONTAINER_METRICS.cpuThrottled, cpuThrottled),
      report('Memory (resident set) per container', CONTAINER_METRICS.memoryResident, memoryResident),
      report('Memory usage in % of the limit per container', CONTAINER_METRICS.memoryPercent, memoryPercent, { overTime: false }),
      format.footer({
        next: `narrow the window around a peak with \`time_from\` / \`time_to\`, call \`pod_events\` with the same ${target.kind} for probe failures, kills and scheduling at that time, or \`process_runtime\` for JVM / Node.js heap and GC.`,
        link,
      }),
    );
  },
};

function kubernetesEvent(event, defaultKind, format) {
  const properties = format.eventProperties(event);
  const entityType = event.entityId?.entityId?.type;
  return {
    reason: properties['dt.kubernetes.event.reason'] || event.eventType || 'UNKNOWN',
    message: String(properties['dt.kubernetes.event.message'] || event.title || '').trim(),
    kind: properties['dt.kubernetes.event.involved_object.kind'] || defaultKind[entityType] || entityType || '',
    first: parseTime(properties['dt.kubernetes.event.first_seen'], format) ?? parseTime(event.startTime, format),
    last: parseTime(properties['dt.kubernetes.event.last_seen'], format) ?? parseTime(event.endTime, format) ?? parseTime(event.startTime, format),
    count: Number(properties['dt.kubernetes.event.count']),
  };
}

function groupKubernetesEvents(events, defaultKind, format) {
  const described = new Map(events.map(event => [event, kubernetesEvent(event, defaultKind, format)]));
  const groups = format.groupEvents(events, event => [described.get(event).kind, described.get(event).reason, described.get(event).message], event => described.get(event));
  return groups.map((group) => {
    const counts = group.members.map(event => described.get(event).count).filter(Number.isFinite);
    const { kind, reason, message } = described.get(group.members[0]);
    return { kind, reason, message, records: group.count, kubernetesCount: counts.length ? Math.max(...counts) : null, first: group.first, last: group.last, entities: group.entities, open: group.open > 0 };
  });
}

function describeEventEntities(group) {
  const names = [...group.entities.values()];
  const kind = group.kind || 'entity';
  if (names.length === 0) return kind;
  if (names.length === 1) return `${kind} ${names[0]}`;
  return `${names.length} × ${kind}: ${names.slice(0, 2).join(', ')}${names.length > 2 ? `, +${names.length - 2} more` : ''}`;
}

const podEvents = {
  name: 'pod_events',
  description: [
    'Lists the Kubernetes events Dynatrace recorded for the pods of a workload and for the workload itself (or for one pod): readiness / liveness probe failures, container kills and back-offs, scheduling and image pull problems, mount failures, deployment spec changes. Identical events are collapsed by reason and message, with a count and the first and last time, newest first.',
    '',
    'Pass exactly one of `workload` or `pod` (id or name). Use it after `pod_resources` shows restarts, OOM kills or a pod that is not running, with the window narrowed to that time.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      workload: ctx.schema.entity('The workload whose pod and workload events to list', 'CLOUD_APPLICATION-1234567890ABCDEF'),
      pod: ctx.schema.entity('A single pod', 'CLOUD_APPLICATION_INSTANCE-1234567890ABCDEF'),
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
    const target = await resolveTarget(args, ctx, time, ['workload', 'pod']);
    const id = target.entity.entityId;
    const quoted = ctx.entities.quote(id);
    const selectors = target.kind === 'pod'
      ? [`entityId(${quoted})`]
      : [`type(${TYPE.pod}),fromRelationships.isInstanceOf(entityId(${quoted}))`, `entityId(${quoted})`];
    const results = await Promise.all(selectors.map(selector => fetchEvents(ctx, selector, time, `Kubernetes events of ${target.entity.displayName}`)));
    const events = results.flatMap(r => r.items);
    const truncated = results.some(r => r.truncated);
    const groups = groupKubernetesEvents(events, { [TYPE.pod]: 'Pod', [TYPE.workload]: 'Workload' }, format);
    const { shown, omitted } = format.cap(groups, limit);
    const header = ctx.header(`Kubernetes events of ${target.title}`, { time, details: [id, `${plural(events.length, 'event')} in ${plural(groups.length, 'group')}`] });
    const link = ctx.link(`ui/entity/${id}`, { time });
    if (groups.length === 0) {
      return format.sections(
        header,
        `_No events for this ${target.word} in this window._ Kubernetes events are short-lived; widen the time window, or check \`pod_resources\` for restarts and OOM kills.`,
        format.footer({ link }),
      );
    }
    const rows = shown.map(group => [
      format.utc(group.last),
      format.utc(group.first),
      group.records,
      group.kubernetesCount ?? '',
      group.reason,
      format.truncate(group.message, 200),
      describeEventEntities(group),
      group.open ? 'open' : 'closed',
    ]);
    return format.sections(
      header,
      format.table(['last seen (UTC)', 'first seen (UTC)', 'events', 'Kubernetes count', 'reason', 'message', 'on', 'status'], rows),
      '`events` is the number of Dynatrace events in the group, `Kubernetes count` the highest occurrence counter Kubernetes reported for one of them.',
      format.omittedNote(omitted, 'raise `limit` or narrow the time window to see them'),
      truncated ? '_More events exist than were read; narrow the time window for a complete picture._' : null,
      format.footer({
        next: `call \`pod_resources\` with the same ${target.kind} and a window around an event to see CPU, memory, OOM kills and restarts at that time, or \`list_pods\` for the current state of the pods.`,
        link,
      }),
    );
  },
};

function runtimeOf(process) {
  const types = new Set([
    ...(Array.isArray(process.properties?.softwareTechnologies) ? process.properties.softwareTechnologies.map(t => String(t?.type || '').toUpperCase()) : []),
    String(process.properties?.processType || '').toUpperCase(),
  ]);
  if (types.has('JAVA')) return 'jvm';
  if (types.has('NODE_JS') || types.has('NODEJS')) return 'nodejs';
  return 'generic';
}

async function processesOfTarget(target, ctx, time) {
  const id = target.entity.entityId;
  const options = { fields: PROCESS_FIELDS, time, limit: 500, label: `Processes of ${target.entity.displayName}` };
  if (target.kind === 'process') return [target.entity];
  if (target.kind === 'process_group') {
    return (await ctx.entities.list(`type(${TYPE.process}),fromRelationships.isInstanceOf(entityId(${ctx.entities.quote(id)}))`, options)).entities;
  }
  const relation = target.kind === 'pod' ? 'isCgiOfCai' : 'isCgiOfCa';
  const containers = await ctx.entities.list(`type(${TYPE.container}),fromRelationships.${relation}(entityId(${ctx.entities.quote(id)}))`, { time, limit: 2000, label: `Containers of ${target.entity.displayName}` });
  if (containers.entities.length === 0) return [];
  return listByRelation(ctx, TYPE.process, 'fromRelationships.isPgiOfCgi', containers.entities.map(c => c.entityId), options);
}

function runtimeSeries(runtime, metrics, names) {
  const named = (list) => (list || []).map((series) => {
    const processId = series.dimensionMap[DIM.process];
    const pool = series.dimensionMap[DIM.pool];
    const name = names.get(processId) ?? processId ?? series.label;
    const title = `${name}${pool ? ` / ${pool}` : ''}`;
    return { ...series, title, label: `${title} (${processId})`, shortLabel: shorten(title) };
  });
  const out = new Map([...metrics.entries()].map(([key, list]) => [key, named(list)]));
  if (runtime === 'jvm') {
    const free = metrics.get(JVM_METRICS.heapFree) || [];
    const used = (metrics.get(JVM_METRICS.heapTotal) || []).map((total) => {
      const match = free.find(s => s.dimensionMap[DIM.process] === total.dimensionMap[DIM.process]);
      return match ? { ...total, ...subtractSeries(total, match) } : null;
    }).filter(Boolean);
    out.set('heapUsed', named(used));
  }
  return out;
}

function runtimeFindings(runtime, series, units, format) {
  const findings = [];
  const inPercent = (key) => units.unit(key, 'Percent') === 'Percent';
  const peak = (key, processId) => statsOf((series.get(key) || []).filter(s => s.dimensionMap[DIM.process] === processId), format);
  if (runtime === 'jvm') {
    for (const used of series.get('heapUsed') || []) {
      const processId = used.dimensionMap[DIM.process];
      const usedStats = format.seriesStats(used.timestamps, used.values);
      const max = peak(JVM_METRICS.heapMax, processId);
      if (usedStats && max && max.max > 0 && usedStats.max >= (max.max * NEAR_LIMIT_PERCENT) / 100) {
        findings.push(`**Heap near max**: ${used.title} used ${format.bytes(usedStats.max)} of ${format.bytes(max.max)} at ${format.utc(usedStats.maxAt)}.`);
      }
    }
    for (const suspension of series.get(JVM_METRICS.gcSuspension) || []) {
      const stats = format.seriesStats(suspension.timestamps, suspension.values);
      if (inPercent(JVM_METRICS.gcSuspension) && stats && stats.max >= GC_SUSPENSION_PERCENT) {
        findings.push(`**High GC suspension**: ${suspension.title} was suspended ${format.percent(stats.max)} of the time at ${format.utc(stats.maxAt)} (avg ${format.percent(stats.avg)}).`);
      }
    }
  }
  if (runtime === 'nodejs') {
    for (const utilization of series.get(NODEJS_METRICS.loopUtilization) || []) {
      const stats = format.seriesStats(utilization.timestamps, utilization.values);
      if (inPercent(NODEJS_METRICS.loopUtilization) && stats && stats.max >= EVENT_LOOP_PERCENT) {
        findings.push(`**Event loop saturated**: ${utilization.title} reached ${format.percent(stats.max)} event loop utilization at ${format.utc(stats.maxAt)} (avg ${format.percent(stats.avg)}).`);
      }
    }
  }
  return findings;
}

const processRuntime = {
  name: 'process_runtime',
  description: [
    'Reports runtime metrics of the processes (Dynatrace PROCESS_GROUP_INSTANCE) running in a pod, a workload or a process group, or of one process. The technology is detected per process: JVM processes get heap usage, heap max, memory pools, GC suspension and GC time, and thread count; Node.js processes get V8 heap used / total, RSS, event loop utilization and latency; every process gets CPU usage and working set memory. Each metric is a summarised series (min / avg / max with its time / last / trend, and a table over time for the main ones).',
    '',
    'Pass exactly one of `pod`, `workload`, `process_group` or `process` (id or name). Use it when `pod_resources` shows memory growth or CPU saturation and you need to know whether heap, GC or the event loop is the cause. Follow up with `get_process` for callers, callees and hosted services.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      pod: ctx.schema.entity('The pod whose processes to analyse', 'CLOUD_APPLICATION_INSTANCE-1234567890ABCDEF'),
      workload: ctx.schema.entity('The workload whose processes to analyse', 'CLOUD_APPLICATION-1234567890ABCDEF'),
      process_group: ctx.schema.entity('A process group', 'PROCESS_GROUP-1234567890ABCDEF'),
      process: ctx.schema.entity('A single process', 'PROCESS_GROUP_INSTANCE-1234567890ABCDEF'),
      max_series: { type: 'number', description: 'Maximum series summarised per metric, ranked by average. Default 10, at most 50.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const maxSeries = ctx.limit(args.max_series, 10, 50, 'max_series');
    const target = await resolveTarget(args, ctx, time, ['pod', 'workload', 'process_group', 'process'], { process: PROCESS_FIELDS });
    const id = target.entity.entityId;
    const link = {
      process: () => ctx.link('#processdetails', { params: { id }, time }),
      process_group: () => ctx.link('#processgroupdetails', { params: { id }, time }),
    }[target.kind]?.() ?? ctx.link(`ui/entity/${id}`, { time });
    const processes = await processesOfTarget(target, ctx, time);
    if (processes.length === 0) {
      return format.sections(
        ctx.header(`Runtime metrics of ${target.title}`, { time, details: [id, '0 processes'] }),
        `_No monitored processes were found for this ${target.word} in this window._ Processes are only reported where OneAgent runs inside the containers; widen the time window or check \`list_pods\`.`,
        format.footer({ link }),
      );
    }

    const names = new Map(processes.map(p => [p.entityId, p.displayName]));
    const groups = Object.keys(RUNTIMES)
      .map(runtime => ({ runtime, processes: processes.filter(p => runtimeOf(p) === runtime) }))
      .filter(group => group.processes.length > 0);
    const selectorsOf = (group) => [...Object.values(PROCESS_METRICS).map(key => `${key}${split(DIM.process)}`), ...RUNTIMES[group.runtime].selectors];
    const [units, ...results] = await Promise.all([
      ctx.metrics.units(groups.flatMap(selectorsOf), { label: 'Reading runtime metric units' }),
      ...groups.map(group => ctx.metrics.queryForEntities(selectorsOf(group), group.processes.slice(0, MAX_RUNTIME_PROCESSES).map(p => p.entityId), {
        time,
        label: `${RUNTIMES[group.runtime].title} metrics of ${target.entity.displayName}`,
      })),
    ]);

    const findings = [];
    const blocks = groups.map((group, index) => {
      const definition = RUNTIMES[group.runtime];
      const series = runtimeSeries(group.runtime, results[index], names);
      findings.push(...runtimeFindings(group.runtime, series, units, format));
      const rows = group.processes.map(p => [
        p.entityId,
        p.displayName,
        technologiesText(p.properties?.softwareTechnologies),
        related(p, 'fromRelationships', 'isInstanceOf')[0] ?? '',
      ]);
      const empty = [];
      const sections = [...definition.sections, ...COMMON_RUNTIME_SECTIONS].map((section) => {
        const list = series.get(section.key) || [];
        if (!list.some(s => s.values.some(isNumber))) {
          empty.push(section.title);
          return null;
        }
        return `### ${section.title}\n\n${format.seriesReport(list, { format: units.formatter(section.unitOf || section.key, section.unit), maxSeries, buckets: 12, overTime: !section.statsOnly })}`;
      });
      return [
        `## ${definition.title} processes (${group.processes.length})`,
        format.table(['id', 'process', 'technologies', 'process group'], rows),
        group.processes.length > MAX_RUNTIME_PROCESSES ? `_Metrics cover the first ${MAX_RUNTIME_PROCESSES} processes only; pass a \`pod\` or \`process\` to narrow down._` : null,
        ...sections,
        empty.length ? `No data in this window for: ${empty.join(', ')}.` : null,
      ];
    });
    const counts = groups.map(group => `${group.processes.length} ${RUNTIMES[group.runtime].title}`).join(', ');
    return format.sections(
      ctx.header(`Runtime metrics of ${target.title}`, { time, details: [id, `${plural(processes.length, 'process')}: ${counts}`] }),
      findings.length ? `## Findings\n\n${findings.map(f => `- ${f}`).join('\n')}` : null,
      ...blocks.flat(),
      units.note(),
      format.footer({
        next: 'call `get_process` with a process id for its callers, callees, hosted services and events, `pod_resources` for the container limits these processes run under, or `method_hotspots` with the process group id for CPU hotspots.',
        link,
      }),
    );
  },
};

const TAG_LIMIT = 12;

function tagsText(tags, format) {
  const { shown, omitted } = format.cap((tags || []).map(format.tag), TAG_LIMIT);
  return `${shown.join(', ')}${omitted ? `, +${omitted} more (all of them with \`get_entity\`)` : ''}`;
}

function hostSummary(entity, internal, ctx, assumptions) {
  const { format } = ctx;
  if (internal?.hostAvailability?.totalDowntime > 0) assumptions.push('the availability `totalDowntime` is in milliseconds');
  const p = entity.properties || {};
  const os = [strip(internal?.osType, /^OS_TYPE_/) || p.osType, internal?.osVersion ?? p.osVersion].filter(Boolean).join(' ');
  const logical = internal?.logicalCores ?? p.logicalCpuCores;
  const cores = internal?.cores ?? p.cpuCores;
  const memory = internal?.totalMemoryBytes ?? p.physicalMemory;
  const ips = internal?.hostIps ?? p.ipAddress;
  const availability = internal?.hostAvailability;
  const downtimes = (Array.isArray(availability?.hostAvailabilityDetails) ? availability.hostAvailabilityDetails : [])
    .filter(d => d?.availabilityState && d.availabilityState !== 'AVAILABLE');
  return [
    `- Id: \`${entity.entityId}\``,
    os ? `- OS: ${os}` : null,
    isNumber(logical) || isNumber(cores) ? `- CPU: ${[isNumber(logical) ? `${logical} logical CPUs` : null, isNumber(cores) ? `${cores} cores` : null].filter(Boolean).join(', ')}` : null,
    isNumber(memory) ? `- Memory: ${format.bytes(memory)}` : null,
    Array.isArray(ips) && ips.length ? `- IPs: ${ips.join(', ')}` : null,
    internal?.monitoringMode || p.monitoringMode ? `- Monitoring mode: ${internal?.monitoringMode ?? p.monitoringMode}${internal?.agentVersion ? `, OneAgent ${internal.agentVersion}` : ''}` : null,
    internal?.kubernetesClusterName ? `- Kubernetes cluster: ${internal.kubernetesClusterName}` : null,
    internal?.cloud && !/UNKNOWN$/.test(internal.cloud) ? `- Cloud: ${strip(internal.cloud, /^CLOUD_TYPE_/)}` : null,
    isNumber(internal?.uptime) ? `- Uptime: ${format.durationMs(internal.uptime * 1000)}` : null,
    isNumber(internal?.lastSeen) ? `- Last seen: ${format.utc(internal.lastSeen)}` : (entity.lastSeenTms ? `- Last seen: ${format.utc(entity.lastSeenTms)}` : null),
    availability && isNumber(availability.availabilityPerc)
      ? `- Availability: ${format.percent(availability.availabilityPerc)} from ${format.utc(availability.timeframeStart)} to ${format.utc(availability.timeframeEnd)}, downtime ${format.durationMs(availability.totalDowntime)}${downtimes.length ? ` (${downtimes.slice(0, 5).map(d => `${d.availabilityState} ${format.utc(d.startTime)} → ${format.utc(d.endTime)}`).join('; ')})` : ''}`
      : null,
    isNumber(internal?.problemSectionData?.totalProblemCount) ? `- Open problems: ${internal.problemSectionData.totalProblemCount}` : null,
    entity.tags?.length ? `- Tags: ${tagsText(entity.tags, format)}` : null,
    entity.managementZones?.length ? `- Management zones: ${entity.managementZones.map(z => z.name || z.id).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

function hostProcessRows(internal, metrics, units, ctx, limit) {
  const { format } = ctx;
  const cpu = units.formatter(PROCESS_METRICS.cpu, 'Percent');
  const memory = units.formatter(PROCESS_METRICS.memory, 'Byte');
  const stats = (key, processId) => statsOf(seriesWhere(metrics, key, DIM.process, processId), format);
  const fromInternal = Array.isArray(internal?.processList) ? internal.processList.map(p => ({
    id: p.id,
    name: p.name,
    technology: p.mainTechnology?.verbatimType || p.unifiedProcessType || '',
    status: p.available === false ? 'unavailable' : `${p.status || ''}${p.restartPending === true ? ' (restart pending)' : ''}`,
    container: p.dockerContainerName || '',
  })) : null;
  const fromMetrics = () => {
    const seen = new Map();
    for (const series of [...(metrics.get(PROCESS_METRICS.cpu) || []), ...(metrics.get(PROCESS_METRICS.memory) || [])]) {
      const id = series.dimensionMap[DIM.process];
      if (id && !seen.has(id)) seen.set(id, { id, name: series.dimensionMap[`${DIM.process}.name`] ?? id, technology: '', status: '', container: '' });
    }
    return [...seen.values()];
  };
  const processes = (fromInternal ?? fromMetrics()).map(p => ({ ...p, cpu: stats(PROCESS_METRICS.cpu, p.id), memory: stats(PROCESS_METRICS.memory, p.id) }));
  processes.sort((a, b) => (b.cpu?.avg ?? -1) - (a.cpu?.avg ?? -1) || String(a.name).localeCompare(String(b.name)));
  const { shown, omitted } = format.cap(processes, limit);
  return {
    total: processes.length,
    unhealthy: processes.filter(p => p.status && p.status !== 'OK').length,
    omitted,
    rows: shown.map(p => [p.id, p.name, p.technology, p.status, cpu(p.cpu?.avg), cpu(p.cpu?.max), memory(p.memory?.avg), p.container]),
  };
}

const getHost = {
  name: 'get_host',
  description: [
    'Returns one host in detail: OS, CPU cores and memory, IPs, monitoring mode, availability and downtimes, open problems; CPU and memory usage over the window as summarised series and disk usage per disk; the processes running on it with their technology, status, CPU and memory use; and its recent events.',
    '',
    'Pass `host` as a HOST id or a host name (an ambiguous name returns the candidates). Kubernetes nodes are hosts too: the node name from `list_pods` works here. Follow up with `get_process` on a process id, or `query_metrics` with `entity_selector: entityId("<host id>")` for any other `builtin:host.*` metric.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      host: ctx.schema.entity('The host', 'HOST-1234567890ABCDEF'),
      process_limit: ctx.schema.limit(30, 'processes', 200),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['host'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const processLimit = ctx.limit(args.process_limit, 30, 200, 'process_limit');
    const host = await ctx.entities.resolve(args.host, { type: TYPE.host, fields: ['properties', 'tags', 'managementZones'], time, what: 'host' });
    const id = host.entityId;
    const scope = eq(DIM.host, id);
    const [units, hostMetrics, processMetrics, events, internal] = await Promise.all([
      ctx.metrics.units([...Object.values(HOST_METRICS), ...Object.values(PROCESS_METRICS)], { label: 'Reading host metric units' }),
      optional(ctx, 'Host metrics', new Map(), () => queryMetrics(ctx, {
        selectors: [`${HOST_METRICS.cpu}${scope}`, `${HOST_METRICS.memory}${scope}`, `${HOST_METRICS.disk}${scope}${split(DIM.disk)}:names`],
        time,
        label: `CPU, memory and disks of ${host.displayName}`,
      })),
      optional(ctx, 'Process metrics', new Map(), () => queryMetrics(ctx, {
        selectors: Object.values(PROCESS_METRICS).map(key => `${key}${split(DIM.process)}:names`),
        entitySelector: `type(${TYPE.process}),fromRelationships.isProcessOf(entityId(${ctx.entities.quote(id)}))`,
        time,
        label: `Processes of ${host.displayName}`,
      })),
      optional(ctx, 'Events', { items: [] }, () => fetchEvents(ctx, `entityId(${ctx.entities.quote(id)})`, time, `Events of ${host.displayName}`, 100)),
      internalDetail(ctx, `/rest/hosts/${id}`, ['id', 'processList[]'], time, `Host details of ${host.displayName}`),
    ]);

    const usage = [
      ...(hostMetrics.value.get(HOST_METRICS.cpu) || []).map(s => ({ ...s, label: 'CPU usage', shortLabel: 'CPU usage' })),
      ...(hostMetrics.value.get(HOST_METRICS.memory) || []).map(s => ({ ...s, label: 'Memory usage', shortLabel: 'Memory usage' })),
    ];
    const usagePercent = units.formatter(HOST_METRICS.cpu, 'Percent');
    units.unit(HOST_METRICS.memory, 'Percent');
    const diskPercent = units.formatter(HOST_METRICS.disk, 'Percent');
    const assumptions = [];
    const summary = hostSummary(host, internal.data, ctx, assumptions);
    const diskRows = (hostMetrics.value.get(HOST_METRICS.disk) || [])
      .map((series) => {
        const stats = format.seriesStats(series.timestamps, series.values);
        return stats ? [series.dimensionMap[`${DIM.disk}.name`] ?? series.dimensionMap[DIM.disk] ?? series.label, diskPercent(stats.avg), diskPercent(stats.max), diskPercent(stats.last), stats] : null;
      })
      .filter(Boolean)
      .sort((a, b) => b[4].max - a[4].max)
      .map(row => row.slice(0, 4));
    const processes = hostProcessRows(internal.data, processMetrics.value, units, ctx, processLimit);
    return format.sections(
      ctx.header(`Host ${host.displayName}`, { time, details: [id] }),
      summary,
      format.assumedNote(assumptions),
      internal.note,
      `## CPU and memory\n\n${usage.length ? format.seriesReport(usage, { format: usagePercent, buckets: 12 }) : 'No data points in this window.'}`,
      hostMetrics.note,
      units.note(),
      diskRows.length ? `## Disks\n\n${format.table(['disk', 'used avg', 'used max', 'used last'], diskRows)}` : null,
      processes.rows.length
        ? `## Processes (${processes.total}${processes.unhealthy ? `, ${processes.unhealthy} not OK` : ''})\n\n${format.table(['id', 'process', 'technology', 'status', 'CPU avg', 'CPU max', 'memory avg', 'container'], processes.rows)}`
        : '## Processes\n\n_No processes reported for this host in this window._',
      format.omittedNote(processes.omitted, 'processes ranked by average CPU; raise `process_limit` to see them'),
      processMetrics.note,
      events.value.items.length ? `## Events (${events.value.items.length})\n\n${eventsTable(events.value.items, ctx, 15)}` : '## Events\n\n_No events for this host in this window._',
      events.note,
      format.footer({
        next: `call \`get_process\` with a process id for its technology, callers / callees and services, or \`query_metrics\` with \`entity_selector: entityId("${id}")\` for other \`builtin:host.*\` metrics.`,
        link: ctx.link('#newhosts/hostdetails', { params: { id }, time }),
      }),
    );
  },
};

function referencesOf(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return { id: item, name: null };
      return { id: item?.id ?? item?.entityId ?? null, name: item?.displayName ?? item?.name ?? null };
    }).filter(ref => ref.id || ref.name).map(ref => ({ id: ref.id ?? ref.name, name: ref.id ? ref.name : null }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, name]) => ({ id, name: typeof name === 'string' ? name : (name?.displayName ?? name?.name ?? null) }));
  }
  return [];
}

function referenceSection(title, refs, ctx, limit = 25) {
  if (refs.length === 0) return null;
  const { shown, omitted } = ctx.format.cap(refs, limit);
  return `## ${title} (${refs.length})\n\n${shown.map(ref => `- ${refText(ref)}`).join('\n')}${omitted ? `\n- … ${omitted} more` : ''}`;
}

function withNames(ids, names) {
  return ids.map(id => ({ id, name: names.get(id) ?? null }));
}

function detailProperty(internal, type) {
  const entry = (Array.isArray(internal?.detailsProperties) ? internal.detailsProperties : []).find(d => d?.type === type);
  const values = Array.isArray(entry?.value) ? entry.value : (entry?.value && typeof entry.value === 'object' ? Object.values(entry.value) : []);
  return values.filter(v => typeof v === 'string' || typeof v === 'number').join(', ');
}

async function processModel(entity, internal, ctx, time) {
  const from = (relation) => related(entity, 'fromRelationships', relation);
  const to = (relation) => related(entity, 'toRelationships', relation);
  const containerIds = from('isPgiOfCgi');
  const pods = containerIds.length
    ? (await listByRelation(ctx, TYPE.pod, 'toRelationships.isCgiOfCai', containerIds, { fields: ['fromRelationships.isInstanceOf'], time, limit: 10, label: `Pod of ${entity.displayName}` })).slice(0, 10)
    : [];
  const fallback = {
    callers: to('isNetworkClientOf'),
    callees: from('isNetworkClientOf'),
    services: to('runsOnProcessGroupInstance'),
  };
  const workloadIds = pods.flatMap(p => related(p, 'fromRelationships', 'isInstanceOf'));
  const names = await ctx.entities.names([
    ...from('isProcessOf'), ...from('isInstanceOf'), ...containerIds, ...workloadIds,
    ...(internal ? [] : [...fallback.callers, ...fallback.callees, ...fallback.services]),
  ], { time });
  const technologies = internal ? technologiesText([internal.mainTechnology, ...(internal.softwareTechs || [])]) : technologiesText(entity.properties?.softwareTechnologies);
  const ports = internal?.listenPorts ?? entity.properties?.listenPorts;
  return {
    namesNote: names.note,
    assumptions: internal?.availability?.totalDowntime > 0 ? ['the availability `totalDowntime` is in milliseconds'] : [],
    summary: [
      `- Id: \`${entity.entityId}\``,
      '- Kind: process (PROCESS_GROUP_INSTANCE)',
      technologies ? `- Technology: ${technologies}` : null,
      internal?.appVersion ?? entity.properties?.appVersion ? `- Application version: ${internal?.appVersion ?? entity.properties.appVersion}` : null,
      from('isInstanceOf').length ? `- Process group: ${withNames(from('isInstanceOf'), names).map(refText).join(', ')}` : null,
      from('isProcessOf').length ? `- Host: ${withNames(from('isProcessOf'), names).map(refText).join(', ')}` : null,
      pods.length ? `- Pod: ${pods.map(p => refText({ id: p.entityId, name: p.displayName })).join(', ')}` : null,
      containerIds.length ? `- Container: ${withNames(containerIds, names).map(refText).join(', ')}` : null,
      workloadIds.length ? `- Workload: ${withNames([...new Set(workloadIds)], names).map(refText).join(', ')}${internal?.kubernetesNamespaceName ? `, namespace ${internal.kubernetesNamespaceName}` : ''}${internal?.kubernetesClusterName ? `, cluster ${internal.kubernetesClusterName}` : ''}` : null,
      Array.isArray(ports) && ports.length ? `- Listen ports: ${ports.join(', ')}` : null,
      internal?.availabilityState ? `- Availability: ${internal.availabilityState}${isNumber(internal.availability?.availabilityPerc) ? `, ${ctx.format.percent(internal.availability.availabilityPerc)} available, downtime ${ctx.format.durationMs(internal.availability.totalDowntime)}` : ''}` : null,
      isNumber(internal?.problemSectionData?.totalProblemCount) ? `- Open problems: ${internal.problemSectionData.totalProblemCount}` : null,
    ],
    services: internal ? referencesOf(internal.services) : withNames(fallback.services, names),
    callers: internal ? referencesOf(internal.processCallers) : withNames(fallback.callers, names),
    callees: internal ? referencesOf(internal.processCallees) : withNames(fallback.callees, names),
  };
}

async function processGroupModel(entity, internal, ctx, time) {
  const from = (relation) => related(entity, 'fromRelationships', relation);
  const to = (relation) => related(entity, 'toRelationships', relation);
  const fallback = {
    callers: to('isNetworkClientOfProcessGroup'),
    callees: from('isNetworkClientOfProcessGroup'),
    services: to('runsOn'),
    hosts: from('runsOn'),
    workloads: from('isPgOfCa'),
  };
  const names = internal ? new Map() : await ctx.entities.names(Object.values(fallback).flat(), { time });
  const technologies = internal
    ? technologiesText([internal.mainTechnology, ...(internal.secondaryTechnologies || [])])
    : technologiesText(entity.properties?.softwareTechnologies);
  const hosts = internal ? referencesOf(internal.hosts) : withNames(fallback.hosts, names);
  const workloads = internal ? referencesOf(internal.relatedKubernetesWorkloads) : withNames(fallback.workloads, names);
  const jvm = [detailProperty(internal, 'JVM_VENDOR'), detailProperty(internal, 'JVM_VERSION')].filter(Boolean).join(' ');
  const ports = detailProperty(internal, 'PORTS');
  return {
    namesNote: names.note ?? null,
    assumptions: [],
    summary: [
      `- Id: \`${entity.entityId}\``,
      '- Kind: process group (PROCESS_GROUP)',
      technologies ? `- Technology: ${technologies}` : null,
      jvm ? `- JVM: ${jvm}` : null,
      isNumber(internal?.numberOfPgis) ? `- Processes: ${internal.numberOfPgis}` : (to('isInstanceOf').length ? `- Processes: ${to('isInstanceOf').length}` : null),
      hosts.length ? `- Hosts (${hosts.length}): ${hosts.slice(0, 10).map(refText).join(', ')}${hosts.length > 10 ? `, +${hosts.length - 10} more` : ''}` : null,
      workloads.length ? `- Workload: ${workloads.map(refText).join(', ')}` : null,
      ports ? `- Listen ports: ${ports}` : null,
    ],
    services: internal ? referencesOf(internal.services) : withNames(fallback.services, names),
    callers: (internal ? referencesOf(internal.incoming) : withNames(fallback.callers, names)).filter(ref => ref.id !== entity.entityId),
    callees: (internal ? referencesOf(internal.outgoing) : withNames(fallback.callees, names)).filter(ref => ref.id !== entity.entityId),
  };
}

const getProcess = {
  name: 'get_process',
  description: [
    'Returns one process (PROCESS_GROUP_INSTANCE) or one process group (PROCESS_GROUP) in detail: technology and version, the host, pod, container and workload it runs in, the services it hosts, the processes that call it and that it calls, CPU and memory use over the window, and its events.',
    '',
    'Pass `process` as a PROCESS_GROUP_INSTANCE id, a PROCESS_GROUP id, or a name (an ambiguous name returns the candidates with their ids). Process ids come from `get_host`, `process_runtime` or `find_entities`. Follow up with `process_runtime` for JVM / Node.js metrics, or the service tools with a service id from the list.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      process: ctx.schema.entity('The process or process group', 'PROCESS_GROUP_INSTANCE-1234567890ABCDEF or PROCESS_GROUP-1234567890ABCDEF'),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['process'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const entity = await ctx.entities.resolve(args.process, {
      type: [TYPE.process, TYPE.processGroup],
      fields: ['properties', 'fromRelationships', 'toRelationships'],
      time,
      what: 'process',
    });
    const id = entity.entityId;
    const isGroup = entity.type === TYPE.processGroup || ctx.entities.typeOf(id) === TYPE.processGroup;
    const metricScope = isGroup
      ? {
        selectors: Object.values(PROCESS_METRICS).map(key => `${key}${split(DIM.process)}:names`),
        entitySelector: `type(${TYPE.process}),fromRelationships.isInstanceOf(entityId(${ctx.entities.quote(id)}))`,
      }
      : { selectors: Object.values(PROCESS_METRICS).map(key => `${key}${eq(DIM.process, id)}${split(DIM.process)}:names`) };
    const [units, internal, metrics, events] = await Promise.all([
      ctx.metrics.units(Object.values(PROCESS_METRICS), { label: 'Reading process metric units' }),
      isGroup
        ? internalDetail(ctx, `/rest/processes/processGroups/${id}`, ['id', 'incoming', 'outgoing', 'services', 'hosts'], time, `Process group details of ${entity.displayName}`)
        : internalDetail(ctx, `/rest/processes/${id}/processdetails`, ['id', 'processCallers[]', 'processCallees[]', 'services[]'], time, `Process details of ${entity.displayName}`),
      optional(ctx, 'Process metrics', new Map(), () => queryMetrics(ctx, { ...metricScope, time, label: `CPU and memory of ${entity.displayName}` })),
      optional(ctx, 'Events', { items: [] }, () => fetchEvents(ctx, `entityId(${ctx.entities.quote(id)})`, time, `Events of ${entity.displayName}`, 100)),
    ]);
    const model = isGroup ? await processGroupModel(entity, internal.data, ctx, time) : await processModel(entity, internal.data, ctx, time);
    const named = (key) => (metrics.value.get(key) || []).map((series) => {
      const processId = series.dimensionMap[DIM.process];
      const name = series.dimensionMap[`${DIM.process}.name`] ?? processId ?? entity.displayName;
      return { ...series, label: processId ? `${name} (${processId})` : name, shortLabel: shorten(name) };
    });
    const resource = (title, key, unit, overTime) => {
      const list = named(key);
      if (!list.some(s => s.values.some(isNumber))) return `### ${title}\n\nNo data points in this window.`;
      return `### ${title}\n\n${format.seriesReport(list, { format: units.formatter(key, unit), buckets: 12, overTime })}`;
    };
    return format.sections(
      ctx.header(`${isGroup ? 'Process group' : 'Process'} ${entity.displayName}`, { time, details: [id] }),
      model.summary.filter(Boolean).join('\n'),
      format.assumedNote(model.assumptions),
      model.namesNote,
      internal.note,
      referenceSection('Services', model.services, ctx),
      referenceSection('Called by', model.callers, ctx),
      referenceSection('Calls', model.callees, ctx),
      model.services.length + model.callers.length + model.callees.length === 0 ? '_No services, callers or callees reported for it in this window._' : null,
      `## Resource use${isGroup ? ' per process' : ''}`,
      resource('CPU usage', PROCESS_METRICS.cpu, 'Percent', true),
      resource('Memory (working set)', PROCESS_METRICS.memory, 'Byte', false),
      metrics.note,
      metrics.note ? null : units.note(),
      events.value.items.length ? `## Events (${events.value.items.length})\n\n${eventsTable(events.value.items, ctx, 15)}` : '## Events\n\n_No events in this window._',
      events.note,
      format.footer({
        next: `call \`process_runtime\` with \`${isGroup ? 'process_group' : 'process'}\` set to \`${id}\` for JVM / Node.js metrics, \`get_host\` with the host id, or the service tools with a service id from the list.`,
        link: ctx.link(isGroup ? '#processgroupdetails' : '#processdetails', { params: { id }, time }),
      }),
    );
  },
};

export const tools = defineTools([listWorkloads, listPods, podResources, podEvents, processRuntime, getHost, getProcess]);
