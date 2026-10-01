import { BRIDGE_NOTE, maskNamed } from '../format.js';
import { defineTools } from '../context.js';

export const order = 0;

const ENTITY_TYPE_EXAMPLES = 'SERVICE, HOST, PROCESS_GROUP, PROCESS_GROUP_INSTANCE, CLOUD_APPLICATION (Kubernetes workload), CLOUD_APPLICATION_INSTANCE (pod), CONTAINER_GROUP_INSTANCE (container), KUBERNETES_CLUSTER, KUBERNETES_NODE, QUEUE';

function typeFromSelector(selector) {
  const match = String(selector || '').match(/type\(\s*"?([A-Za-z0-9_:.-]+)"?\s*\)/);
  return match ? match[1].toUpperCase() : null;
}

function valueAt(object, path) {
  return path.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), object);
}

function describeValue(value, ctx, { key = '', max = 120 } = {}) {
  const { format } = ctx;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && /Tms$|Timestamp$/.test(key)) return format.utc(value);
  if (typeof value !== 'object') return format.truncate(value, max);
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item && typeof item === 'object') {
        if (typeof item.id === 'string') return item.id;
        if (item.key !== undefined || item.stringRepresentation) return format.tag(item);
        if (typeof item.name === 'string') return item.name;
        return JSON.stringify(item);
      }
      return String(item);
    });
    const { shown, omitted } = format.cap(items, 5);
    return format.truncate(`${shown.join(', ')}${omitted ? ` (+${omitted} more)` : ''}`, max);
  }
  return format.truncate(JSON.stringify(value), max);
}

function requestedFields(fields) {
  return (Array.isArray(fields) ? fields : String(fields ?? '').split(','))
    .map(f => String(f).trim().replace(/^\+/, ''))
    .filter(Boolean);
}

function sessionCell(result) {
  if (!result) return '';
  return result.ok ? 'ok' : `${result.code}: ${result.message}`;
}

async function checkSessions(ctx, environments) {
  const results = new Map();
  await Promise.all(environments.map(async (env) => {
    try {
      await ctx.dt({ path: '/rest/v2/entityTypes', query: { pageSize: 1 }, timeoutMs: 30000 }, { environment: env.name, label: 'Checking the Dynatrace session' });
      results.set(env.name, { ok: true });
    } catch (error) {
      results.set(env.name, { ok: false, code: error.code || 'INTERNAL', message: error.message });
    }
  }));
  return results;
}

const bridgeStatus = {
  name: 'dynatrace_bridge_status',
  description: [
    'Reports whether the Dynatrace Bridge is usable: server version and whether a newer release exists, whether the browser extension is connected and its version (each browser when several are connected), and the Dynatrace environments configured in the extension (name, environment id, URL).',
    '',
    'Call this first when another Dynatrace tool fails with a connection, environment or session error, or when the user asks which environments are available. Works even when no extension is connected.',
    'Pass `check_session: true` to also run one small request per environment and see whether the browser is still logged in.',
    '',
    'Where to start with the other tools. All take `environment`. All except `get_problem`, `find_metrics`, `list_dashboards` and `read_settings` also take the time arguments `minutes_lookback` / `time_from` / `time_to` (timestamps without a zone are read as UTC); those four have no time window.',
    '- An incident, or "what is wrong": `list_problems`, then `get_problem` with the P- id.',
    '- A slow or failing service: `list_services` (`sort: "response_time"` or `"failure_rate"`) to find it, `service_overview`, then `analyze_response_time` or `analyze_failures`, then `list_traces` and `get_trace` for single requests.',
    '- Across all services, `trace_statistics` with `request_kind: "web"` and: slowest endpoints `aggregation: "P95"` (or `"AVERAGE"`) plus `min_calls: 20`; most time-consuming endpoints `aggregation: "SUM"`; most CPU `metric: "CPU_TIME"`, `aggregation: "SUM"`; most errors `metric: "FAILED_REQUEST_COUNT"` (a count metric, ranked by its `COUNT`).',
    '- Exceptions: `top_exceptions`. Slow or expensive SQL: `top_database_statements`. Slow or long-running cron jobs: `cron_job_statistics`.',
    '- Pod restarts, OOM kills, throttling: `list_workloads`, then `pod_resources` and `pod_events`. CPU or memory of a process: `cpu_by_process_group`, `method_hotspots`, `process_runtime`.',
    '- Anything else: `find_entities` for ids, `find_metrics` and `query_metrics` for the data behind any chart.',
  ].join('\n'),
  inputSchema: () => ({
    type: 'object',
    properties: {
      check_session: { type: 'boolean', description: 'Also verify each environment with one small read request. When no Dynatrace tab is open for an environment, the extension opens one in the foreground of the user\'s browser. Default false.' },
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const status = ctx.status();
    const lines = [
      '# Dynatrace Bridge status',
      '',
      `- Server: dynatrace-bridge-mcp ${status.serverVersion} (MCP http://${status.host}:${status.mcpPort}/mcp, extension WebSocket port ${status.port})`,
    ];
    if (status.updateAvailable) {
      lines.push(`- Update available: dynatrace-bridge-mcp ${status.latestVersion} has been released (this server is ${status.serverVersion}). Tell the user to restart their MCP client so that \`npx -y dynatrace-bridge-mcp@latest\` picks it up, then \`npx -y dynatrace-bridge-mcp@latest install-extension\` and reload the extension.`);
    }
    if (!status.connected) {
      lines.push('- Extension: **not connected**');
      lines.push('');
      lines.push(`Ask the user to open the browser where the Dynatrace Bridge extension is installed and check that its popup shows it as connected on port ${status.port}. If the extension is not installed: \`npx -y dynatrace-bridge-mcp install-extension\`, then load the folder it prints as an unpacked extension.`);
      if (status.environments.length) lines.push('', `Environments seen before the extension disconnected: ${status.environments.map(e => e.name).join(', ')}.`);
      return lines.join('\n');
    }
    const versionNote = status.extensionVersion === status.serverVersion ? '' : ' (differs from the server version)';
    const browsers = Array.isArray(status.connections) ? status.connections : [];
    lines.push(`- Extension: connected, version ${status.extensionVersion || 'unknown'}${versionNote}`);
    if (browsers.length > 1 || browsers.some(connection => !connection.ready)) {
      lines.push(`- Connected browsers: ${browsers.length}`);
      for (const connection of browsers) {
        const names = (connection.environments || []).map(env => env.name).join(', ') || 'none';
        lines.push(`  - #${connection.id}: extension ${connection.version || 'unknown version'}${connection.ready ? '' : ', not ready yet'}, connected ${format.utc(connection.connectedAt)}, environments: ${names}`);
      }
    }
    lines.push(`- Environments: ${status.environments.length}`);
    if (status.environments.length === 0) {
      lines.push('');
      lines.push('No environment is configured. Ask the user to open Dynatrace in the browser, click the Dynatrace Bridge extension icon and choose "Add this environment".');
      return lines.join('\n');
    }
    const sessions = args.check_session ? await checkSessions(ctx, status.environments) : null;
    const headers = ['name', 'environment id', 'URL', ...(sessions ? ['session'] : [])];
    const rows = status.environments.map((env, index) => [
      index === 0 ? `${env.name} (default)` : env.name,
      env.envId || '',
      `${env.origin}${env.basePath}/`,
      ...(sessions ? [sessionCell(sessions.get(env.name))] : []),
    ]);
    lines.push('', format.table(headers, rows), '');
    lines.push('Next: pass one of these names as `environment` to any tool (omit it for the default). Start with `list_problems` for incidents, `list_services` for services, or `find_entities` for any other entity.');
    return lines.join('\n');
  },
};

async function listEntityTypes(args, ctx) {
  const { format } = ctx;
  const limit = ctx.limit(args.limit, 300, 500);
  const { items, totalCount } = await ctx.v2List('/rest/v2/entityTypes', {}, { itemsKey: 'types', limit, label: 'Listing entity types' });
  const rows = items.map(t => [t.type, t.displayName || '']);
  return format.sections(
    ctx.header('Entity types', { details: [`${rows.length} of ${totalCount}`] }),
    format.table(['type', 'display name'], rows) || '_No entity types returned._',
    format.omittedNote(totalCount - rows.length),
    format.footer({
      next: 'call `find_entities` again with `type` set to one of these, optionally with `name`.',
      link: ctx.link(''),
    }),
  );
}

const findEntities = {
  name: 'find_entities',
  description: [
    'Searches Dynatrace monitored entities of any type and returns their ids and names. Use it to turn a name the user mentions into the entity id that other tools need, or to list what exists (services, hosts, process groups, Kubernetes workloads, pods, containers, queues, …).',
    '',
    `Give \`type\` (e.g. ${ENTITY_TYPE_EXAMPLES}) and optionally \`name\` (case-insensitive substring). For anything more specific pass a full Dynatrace \`selector\` (entitySelector syntax), e.g. \`type(CLOUD_APPLICATION_INSTANCE),fromRelationships.isInstanceOf(entityId("CLOUD_APPLICATION-1234567890ABCDEF"))\` for the pods of a workload, or \`type(SERVICE),tag("team:checkout")\`.`,
    'Called with neither `type` nor `selector`, it lists the entity types that exist in the environment.',
    '',
    'Only entities seen inside the time window are returned. Add `fields` (e.g. `tags`, `managementZones`, `properties.cloudApplicationInstancePhase`, `fromRelationships.runsOn`) for extra columns. Follow up with `get_entity` for all properties and relationships of one entity.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      type: { type: 'string', description: `Entity type, e.g. ${ENTITY_TYPE_EXAMPLES}. Ignored when \`selector\` is given.` },
      name: { type: 'string', description: 'Case-insensitive substring of the entity name. Combined with `type`; ignored when `selector` is given.' },
      selector: { type: 'string', description: 'Full Dynatrace entitySelector, used verbatim. Must contain a type(...) or entityId(...) criterion.' },
      fields: { type: 'array', items: { type: 'string' }, description: "Extra entity fields to fetch and show as columns, e.g. ['tags', 'properties.cloudApplicationInstancePhase', 'fromRelationships.runsOn', 'lastSeenTms']." },
      limit: ctx.schema.limit(50, 'entities (300 entity types when listing types)', 500),
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const hasSelector = typeof args.selector === 'string' && args.selector.trim() !== '';
    const hasType = typeof args.type === 'string' && args.type.trim() !== '';
    if (!hasSelector && !hasType) {
      if (args.name) throw new Error('`name` needs `type` (or use `selector`). Call find_entities without arguments to list the entity types.');
      return listEntityTypes(args, ctx);
    }
    const time = ctx.time(args);
    const limit = ctx.limit(args.limit, 50, 500);
    const type = hasSelector ? typeFromSelector(args.selector) : args.type.trim().toUpperCase();
    const selector = hasSelector
      ? args.selector.trim()
      : [`type(${ctx.entities.quote(type)})`, args.name ? `entityName.contains(${ctx.entities.quote(args.name)})` : null].filter(Boolean).join(',');
    const fields = requestedFields(args.fields);
    const { entities, totalCount } = await ctx.entities.list(selector, { fields, time, limit, label: `Finding ${type || 'entities'}${args.name ? ` named "${args.name}"` : ''}` });

    const mixedTypes = new Set(entities.map(e => e.type)).size > 1;
    const headers = ['id', 'name', ...(mixedTypes ? ['type'] : []), ...fields];
    const rows = entities.map(e => [
      e.entityId,
      e.displayName,
      ...(mixedTypes ? [e.type] : []),
      ...fields.map(field => describeValue(valueAt(e, field), ctx, { key: field })),
    ]);
    const empty = `_No entities matched in this window._ Check the type name (call find_entities without arguments to list types), loosen \`name\`, or widen the time window.`;
    return format.sections(
      ctx.header(`Entities: \`${selector}\``, { time, details: [`${rows.length} of ${totalCount}`] }),
      rows.length ? format.table(headers, rows) : empty,
      format.omittedNote(totalCount - rows.length),
      format.footer({
        next: rows.length ? 'call `get_entity` with an id for properties and relationships, or `query_metrics` with `entity_selector: entityId("<id>")` for its metrics.' : null,
        link: ctx.link(type ? `ui/entity/list/${type}` : '', { time }),
      }),
    );
  },
};

function relationshipLines(relationships, arrow, names, limit, ctx) {
  const { format } = ctx;
  return Object.entries(relationships || {})
    .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relation, targets]) => {
      const { shown, omitted } = format.cap(targets, limit);
      const listed = shown.map((target) => {
        const id = typeof target === 'string' ? target : target.id;
        return names.has(id) ? `\`${id}\` ${names.get(id)}` : `\`${id}\``;
      });
      return `- ${arrow} ${relation} (${targets.length}): ${listed.join(', ')}${omitted ? `, +${omitted} more` : ''}`;
    });
}

function shownRelationshipIds(entity, limit) {
  return [entity.fromRelationships, entity.toRelationships]
    .flatMap(relationships => Object.values(relationships || {}))
    .flatMap(targets => (Array.isArray(targets) ? targets.slice(0, limit) : []))
    .map(target => (typeof target === 'string' ? target : target?.id))
    .filter(Boolean);
}

const getEntity = {
  name: 'get_entity',
  description: [
    'Returns one Dynatrace entity in full: type, first/last seen, tags, management zones, all properties (for pods: phase, node, restarts, requests/limits; for services: technology, type; for hosts: OS, CPU, memory, …) and its relationships to other entities with their ids and names (runs on, calls, called by, is instance of, …).',
    '',
    'Pass `entity` as an id (e.g. SERVICE-1234567890ABCDEF) or as a name together with `type`. An ambiguous name returns the candidates. Use the related ids with `get_entity` again to walk the topology, or in `query_metrics` entity selectors.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      entity: ctx.schema.entity('The entity', 'HOST-1234567890ABCDEF'),
      type: { type: 'string', description: `Entity type, needed only when \`entity\` is a name. E.g. ${ENTITY_TYPE_EXAMPLES}.` },
      relationship_limit: { type: 'number', description: 'Maximum related entities listed per relationship. Default 10, at most 100.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['entity'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const relationshipLimit = ctx.limit(args.relationship_limit, 10, 100, 'relationship_limit');
    const fields = ['properties', 'tags', 'managementZones', 'fromRelationships', 'toRelationships', 'firstSeenTms', 'lastSeenTms'];
    const entity = await ctx.entities.resolve(args.entity, { type: args.type, fields, time });
    const names = await ctx.entities.names(shownRelationshipIds(entity, relationshipLimit).slice(0, 200), { time });

    const summary = [
      `- Id: \`${entity.entityId}\``,
      `- Type: ${entity.type}`,
      entity.firstSeenTms ? `- First seen: ${format.utc(entity.firstSeenTms)}` : null,
      entity.lastSeenTms ? `- Last seen: ${format.utc(entity.lastSeenTms)}` : null,
      entity.tags?.length ? `- Tags: ${entity.tags.map(format.tag).join(', ')}` : null,
      entity.managementZones?.length ? `- Management zones: ${entity.managementZones.map(z => z.name || z.id).join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const properties = Object.keys(entity.properties || {}).sort()
      .map(key => `- ${key}: ${describeValue(maskNamed(key, entity.properties[key], { opaque: false }), ctx, { key, max: 300 })}`);
    const relationships = [
      ...relationshipLines(entity.fromRelationships, '→', names, relationshipLimit, ctx),
      ...relationshipLines(entity.toRelationships, '←', names, relationshipLimit, ctx),
    ];

    return format.sections(
      ctx.header(`Entity: ${entity.displayName}`, { time, details: [entity.entityId] }),
      summary,
      properties.length ? `## Properties\n\n${properties.join('\n')}` : null,
      relationships.length ? `## Relationships\n\n→ this entity to the listed ones, ← the listed ones to this entity\n${relationships.join('\n')}` : null,
      names.note,
      format.footer({
        next: `call \`query_metrics\` with \`entity_selector: entityId("${entity.entityId}")\` for its metrics (find metric ids with \`find_metrics\`), or \`get_entity\` on a related id.`,
        link: ctx.link(`ui/entity/${entity.entityId}`, { time }),
      }),
    );
  },
};

const METRIC_FIELDS = 'displayName,unit,aggregationTypes,defaultAggregation,dimensionDefinitions,entityType';

const findMetrics = {
  name: 'find_metrics',
  description: [
    'Searches the Dynatrace metric catalogue and returns metric ids with unit, available aggregations, dimensions and the entity types they apply to. Use it before `query_metrics` whenever you are not sure of the exact metric id.',
    '',
    'Pass `text` for a free-text search over id, name and description (e.g. "response time", "container memory", "v8 heap"), and/or `selector` for an id pattern with a trailing wildcard (e.g. `builtin:service.*`, `builtin:containers.cpu.*`, `builtin:kubernetes.workload.*`, `builtin:tech.jvm.*`, `builtin:tech.nodejs.*`).',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Free-text search over metric id, display name and description.' },
      selector: { type: 'string', description: 'Metric id or id prefix with a trailing `*`, e.g. `builtin:service.*`. Several can be given comma-separated.' },
      describe: { type: 'boolean', description: 'Also print each metric\'s description. Default false.' },
      limit: ctx.schema.limit(50, 'metrics', 200),
      environment: ctx.schema.environment(),
    },
    required: [],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
    if (!text && !selector) {
      throw new Error('pass `text` (e.g. "response time") and/or `selector` (e.g. `builtin:service.*`). The full catalogue is too large to list.');
    }
    const limit = ctx.limit(args.limit, 50, 200);
    const query = {
      text: text || undefined,
      metricSelector: selector || undefined,
      fields: args.describe ? `${METRIC_FIELDS},description` : METRIC_FIELDS,
    };
    const { items, totalCount } = await ctx.v2List('/rest/v2/metrics', query, { itemsKey: 'metrics', limit, label: `Searching metrics ${[text, selector].filter(Boolean).join(' ')}` });
    const headers = ['metric id', 'name', 'unit', 'aggregations', 'dimensions', 'entity types', ...(args.describe ? ['description'] : [])];
    const rows = items.map(m => [
      `\`${m.metricId}\``,
      m.displayName || '',
      m.unit || '',
      (m.aggregationTypes || []).map(a => (a === m.defaultAggregation?.type ? `**${a}**` : a)).join(', '),
      (m.dimensionDefinitions || []).map(d => d.key).join(', '),
      (m.entityType || []).join(', '),
      ...(args.describe ? [format.truncate(m.description || '', 200)] : []),
    ]);
    const criteria = [text ? `text "${text}"` : null, selector ? `selector \`${selector}\`` : null].filter(Boolean).join(', ');
    return format.sections(
      ctx.header(`Metrics: ${criteria}`, { details: [`${rows.length} of ${totalCount}`] }),
      rows.length ? format.table(headers, rows) : '_No metrics matched._ Try a shorter `text`, or a broader `selector` such as `builtin:service.*`.',
      rows.length ? 'The default aggregation is bold.' : null,
      format.omittedNote(totalCount - rows.length),
      format.footer({
        next: rows.length ? 'call `query_metrics` with `selector` set to a metric id, optionally with an aggregation and split, e.g. `builtin:service.response.time:percentile(95):splitBy("dt.entity.service"):names`.' : null,
        link: ctx.link('ui/metrics'),
      }),
    );
  },
};

function descriptorFor(metricId, descriptors) {
  const exact = descriptors.find(d => d.metricId === metricId);
  if (exact) return exact;
  return descriptors
    .filter(d => typeof d.metricId === 'string' && metricId.startsWith(d.metricId))
    .sort((a, b) => b.metricId.length - a.metricId.length)[0] || null;
}

async function metricDescriptors(selector, ctx) {
  const { value, note } = await ctx.attempt(async () => (await ctx.v2List('/rest/v2/metrics', { metricSelector: selector, fields: 'displayName,unit' }, { itemsKey: 'metrics', limit: 100, label: 'Reading metric units' })).items, []);
  return { items: value, note };
}

const queryMetrics = {
  name: 'query_metrics',
  description: [
    'Runs a Dynatrace metric query (the data behind any chart) and returns each series summarised: min, avg, max with its timestamp, last value, trend, and a compact table of values over time. Values are converted to readable units (µs → ms/s, bytes → MiB/GiB) from the unit of the metric descriptor; when Dynatrace names no unit, or the descriptor cannot be read, the values are printed raw and the output says so. The descriptor describes the plain metric, so after a transformation that changes the unit (`:rate`, `:count`, arithmetic) read the numbers with that in mind.',
    '',
    '`selector` uses the Dynatrace metric selector language: a metric id plus optional transformations, e.g.',
    '- `builtin:service.response.time:percentile(95)`',
    '- `builtin:service.errors.total.rate:splitBy("dt.entity.service"):sort(value(avg,descending)):limit(10):names`',
    '- `builtin:containers.memory.residentSetBytes:splitBy("dt.entity.container_group_instance"):max:names`',
    'Several selectors can be given comma-separated. Append `:names` so entity names are shown next to their ids. Find metric ids with `find_metrics`.',
    '',
    'Scope to entities with `entity_selector` (entitySelector syntax), e.g. `entityId("SERVICE-1234567890ABCDEF")` or `type(HOST),entityName.contains("web")`. `resolution` sets the point spacing (`1m`, `5m`, `1h`, `1d`, or `Inf` for a single value over the window); by default Dynatrace picks one that fits the window.',
    '',
    BRIDGE_NOTE,
  ].join('\n'),
  inputSchema: (ctx) => ({
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Metric selector: metric id with optional transformations (:avg, :max, :percentile(95), :splitBy("dimension"), :filter(...), :sort(...), :limit(n), :names, :rate(1m), …).' },
      entity_selector: { type: 'string', description: 'Optional entitySelector limiting the entities the metric is read for, e.g. `entityId("HOST-1234567890ABCDEF")`.' },
      resolution: { type: 'string', description: "Point spacing: '1m', '5m', '1h', '1d', a point count like '60', or 'Inf' for one aggregated value. Default: chosen by Dynatrace for the window." },
      max_series: { type: 'number', description: 'Maximum series summarised per metric, ranked by average. Default 10, at most 50.' },
      ...ctx.schema.time(),
      environment: ctx.schema.environment(),
    },
    required: ['selector'],
  }),
  handler: async (args, ctx) => {
    const { format } = ctx;
    const time = ctx.time(args);
    const selector = String(args.selector).trim();
    const entitySelector = typeof args.entity_selector === 'string' && args.entity_selector.trim() ? args.entity_selector.trim() : undefined;
    const maxSeries = ctx.limit(args.max_series, 10, 50, 'max_series');
    const query = {
      metricSelector: selector,
      entitySelector,
      resolution: args.resolution ? String(args.resolution).trim() : undefined,
      ...time.v2Query,
    };
    const [data, descriptors] = await Promise.all([
      ctx.get('/rest/v2/metrics/query', query, { label: `Querying ${format.truncate(selector, 60)}` }),
      metricDescriptors(selector, ctx),
    ]);
    if (!Array.isArray(data?.result)) throw new Error('Unexpected response from /rest/v2/metrics/query: no `result` array.');

    const metrics = format.metricSeries(data);
    const blocks = metrics.map((metric) => {
      const descriptor = descriptorFor(metric.metricId, descriptors.items);
      const unit = descriptor?.unit && descriptor.unit !== 'Unspecified' ? descriptor.unit : null;
      const title = [descriptor?.displayName, unit ? `unit ${unit}` : 'unit unknown, raw values', `${metric.series.length} series`].filter(Boolean).join(', ');
      return [
        `## \`${metric.metricId}\` (${title})`,
        format.seriesReport(metric.series, { format: format.formatterForUnit(unit), maxSeries }),
        metric.warnings.length ? `Warnings: ${metric.warnings.join('; ')}` : null,
      ];
    });
    const hasData = metrics.some(m => m.series.some(s => s.values.some(v => typeof v === 'number')));
    const details = [
      entitySelector ? `entities \`${entitySelector}\`` : null,
      data.resolution ? `resolution ${data.resolution}` : null,
    ];
    return format.sections(
      ctx.header(`Metrics: \`${selector}\``, { time, details }),
      descriptors.note ? `_Units are unknown, so every value below is the raw number Dynatrace returned: the metric descriptors could not be read (${format.truncate(descriptors.note, 200)})._` : null,
      ...blocks,
      Array.isArray(data.warnings) && data.warnings.length ? `Warnings: ${data.warnings.join('; ')}` : null,
      hasData ? null : 'Nothing was recorded for this selector in the window. Check the metric id with `find_metrics`, loosen `entity_selector`, or widen the time window.',
      format.footer({
        next: hasData
          ? 'narrow the window around a peak with `time_from` / `time_to`, split by another dimension with `:splitBy(...)`, or call `get_entity` on an entity id from the series.'
          : null,
        link: ctx.link('ui/data-explorer', { time }),
      }),
    );
  },
};

export const tools = defineTools([bridgeStatus, findEntities, getEntity, findMetrics, queryMetrics]);
