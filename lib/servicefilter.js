export const SERVICE_FILTER_VERSION = '0';
export const VERSION_SEP = '\x1e';
export const FILTER_SEP = '\x10';
export const TYPE_SEP = '\x11';
export const VALUE_SEP = '\x14';
export const OPEN_MAX_MICROS = '4611686018427387';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS', 'CONNECT', 'PATCH'];

export const FILTER_TYPES = {
  RESPONSE_TIME: 0,
  CPU_TIME: 1,
  RESPONSE_CODE: 2,
  FAILED_STATE: 3,
  CALL_INSTANCE_ID: 5,
  HTTP_METHOD: 6,
  CALL_TREE: 7,
  CALL_URI: 8,
  CALL_METHOD_ID: 9,
  CALL_METHOD_GROUP_ID: 10,
  CALL_TAG: 15,
  WAIT_TIME: 19,
  SYNC_TIME: 20,
  SUSPENSION_TIME: 21,
  CALLEE: 22,
  CALLER: 23,
  PROXY: 24,
  CALL_SERVICE_TYPE: 26,
  SERVICE_ID: 27,
  EXCEPTION: 29,
  SERVICE_URL: 30,
  DATABASE_STATEMENT: 31,
  DATABASE_TABLE: 32,
  FLAWS: 33,
  DISK_IO_TIME: 34,
  NETWORK_IO_TIME: 35,
  NUMBER_OF_DB_CALLS: 37,
  NUMBER_OF_NON_DB_CALLS: 38,
  TIME_SPENT_IN_DB_CALLS: 39,
  TIME_SPENT_IN_NON_DB_CALLS: 40,
  TRACE_ID: 41,
  THREAD_NAME: 43,
  PROCESSING_TIME: 45,
  DATABASE_VENDOR: 46,
  DATABASE_NAME: 47,
  ENTITY_TAG: 48,
  SERVICE_NAME: 50,
  PG_NAME: 52,
  PG_TAG: 53,
  DATABASE_ROW_COUNT: 54,
  DATABASE_FETCH_COUNT: 55,
  WEBREQUEST_HOSTNAME: 57,
  KEY_REQUEST: 61,
  RELEASE: 62,
  BUILD: 63,
  STAGE: 64,
  PRODUCT: 65,
  SPAN_NAME: 67,
  SPAN_ATTRIBUTE: 68,
  ENTRY_POINT: 70,
};

export const VERIFIED_TYPES = [0, 2, 3, 6, 9, 10, 26, 30, 50];

export const REQUEST_KINDS = {
  web: ['2', '1'],
  database: ['0'],
};

const REQUEST_ID = /^SERVICE_METHOD-[0-9A-F]{16}$/;
const REQUEST_GROUP_ID = /^SERVICE_METHOD_GROUP-[0-9A-F]{16}$/;

export function isRequestReference(value) {
  return typeof value === 'string' && (REQUEST_ID.test(value.trim()) || REQUEST_GROUP_ID.test(value.trim()));
}

const TYPE_NAMES = Object.fromEntries(Object.entries(FILTER_TYPES).map(([name, id]) => [id, name]));
const CONTROL_CHARS = /[\x10\x11\x14\x1e]/;
const given = (v) => v !== undefined && v !== null && v !== '';

export function filterTypeName(id) {
  return TYPE_NAMES[id] || `TYPE_${id}`;
}

function typeId(type) {
  if (typeof type === 'number' && Number.isInteger(type) && type >= 0) return type;
  if (typeof type === 'string' && /^\d+$/.test(type.trim())) return parseInt(type.trim(), 10);
  if (typeof type === 'string' && FILTER_TYPES[type.trim().toUpperCase()] !== undefined) return FILTER_TYPES[type.trim().toUpperCase()];
  throw new Error(`unknown servicefilter type ${JSON.stringify(type)}. Use a numeric type id or one of: ${Object.keys(FILTER_TYPES).join(', ')}`);
}

function cleanValue(value, what) {
  const text = String(value);
  if (CONTROL_CHARS.test(text)) throw new Error(`${what} contains a reserved servicefilter control character`);
  return text;
}

function millisToMicros(ms, name) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`\`${name}\` must be a non-negative number of milliseconds, got ${JSON.stringify(ms)}`);
  }
  return String(Math.round(ms * 1000));
}

export function normalizeHttpCode(code) {
  const text = String(code).trim().toLowerCase();
  if (/^[1-5]\d\d$/.test(text)) return text;
  if (/^[1-5]xx$/.test(text)) return `${text[0]}00-${text[0]}99`;
  const range = text.match(/^([1-5]\d\d)\s*-\s*([1-5]\d\d)$/);
  if (range && Number(range[1]) <= Number(range[2])) return `${range[1]}-${range[2]}`;
  throw new Error(`invalid HTTP code filter ${JSON.stringify(code)}. Use a code ('404'), a class ('4xx') or a range ('400-499')`);
}

function httpMethodOrdinal(method) {
  const ordinal = HTTP_METHODS.indexOf(String(method).trim().toUpperCase());
  if (ordinal === -1) throw new Error(`invalid HTTP method ${JSON.stringify(method)}. Use one of: ${HTTP_METHODS.join(', ')}`);
  return String(ordinal);
}

function requestGroupValues(group) {
  const id = typeof group === 'string' ? group : group?.id;
  if (typeof id !== 'string' || !id.startsWith('SERVICE_METHOD_GROUP-')) {
    throw new Error(`request group id must look like SERVICE_METHOD_GROUP-…, got ${JSON.stringify(id)}`);
  }
  const values = [cleanValue(id, 'request group id')];
  if (typeof group === 'object' && given(group.name)) values.push(cleanValue(group.name, 'request group name'));
  return values;
}

export function buildFilters(input = {}) {
  const filters = [];
  const add = (type, values) => filters.push({ type, name: filterTypeName(type), values });

  if (given(input.responseTimeMinMs) || given(input.responseTimeMaxMs)) {
    const min = given(input.responseTimeMinMs) ? millisToMicros(input.responseTimeMinMs, 'responseTimeMinMs') : '0';
    const max = given(input.responseTimeMaxMs) ? millisToMicros(input.responseTimeMaxMs, 'responseTimeMaxMs') : OPEN_MAX_MICROS;
    if (max !== OPEN_MAX_MICROS && Number(min) > Number(max)) throw new Error('response time minimum is larger than the maximum');
    add(FILTER_TYPES.RESPONSE_TIME, [min, max]);
  }
  if (given(input.httpCode)) add(FILTER_TYPES.RESPONSE_CODE, [normalizeHttpCode(input.httpCode)]);
  if (given(input.failed)) {
    if (typeof input.failed !== 'boolean') throw new Error('`failed` must be true (failed only) or false (successful only)');
    add(FILTER_TYPES.FAILED_STATE, [input.failed ? '0' : '1']);
  }
  if (given(input.httpMethod)) add(FILTER_TYPES.HTTP_METHOD, [httpMethodOrdinal(input.httpMethod)]);
  if (given(input.requestId)) {
    if (typeof input.requestId !== 'string' || !input.requestId.startsWith('SERVICE_METHOD-')) {
      throw new Error(`request id must look like SERVICE_METHOD-…, got ${JSON.stringify(input.requestId)}`);
    }
    add(FILTER_TYPES.CALL_METHOD_ID, [cleanValue(input.requestId, 'request id')]);
  }
  if (given(input.requestGroup)) add(FILTER_TYPES.CALL_METHOD_GROUP_ID, requestGroupValues(input.requestGroup));
  if (given(input.urlContains)) add(FILTER_TYPES.SERVICE_URL, [cleanValue(input.urlContains, 'URL filter')]);

  for (const raw of Array.isArray(input.raw) ? input.raw : []) {
    const values = (Array.isArray(raw?.values) ? raw.values : [raw?.values]).filter(given);
    if (values.length === 0) throw new Error(`raw servicefilter entry for type ${JSON.stringify(raw?.type)} needs at least one value`);
    add(typeId(raw?.type), values.map(v => cleanValue(v, 'raw filter value')));
  }
  if (given(input.requestKind)) {
    const ordinals = REQUEST_KINDS[String(input.requestKind).trim().toLowerCase()];
    if (!ordinals) throw new Error(`invalid request kind ${JSON.stringify(input.requestKind)}. Use one of: ${Object.keys(REQUEST_KINDS).join(', ')}`);
    for (const ordinal of ordinals) add(FILTER_TYPES.CALL_SERVICE_TYPE, [ordinal]);
  }
  if (given(input.serviceName)) add(FILTER_TYPES.SERVICE_NAME, [cleanValue(input.serviceName, 'service name')]);
  return filters;
}

export function encodeServiceFilter(input = {}) {
  const filters = buildFilters(input);
  if (filters.length === 0) return undefined;
  const body = filters.map(f => `${f.type}${TYPE_SEP}${f.values.join(VALUE_SEP)}`).join(FILTER_SEP);
  return `${SERVICE_FILTER_VERSION}${VERSION_SEP}${body}`;
}

function microsToMillis(micros) {
  return Number(micros) / 1000;
}

function friendlyInput(filters) {
  const input = {};
  const raw = [];
  const kindOf = (index) => {
    const ordinals = [];
    while (filters[index + ordinals.length]?.type === FILTER_TYPES.CALL_SERVICE_TYPE && filters[index + ordinals.length].values.length === 1) ordinals.push(filters[index + ordinals.length].values[0]);
    return Object.keys(REQUEST_KINDS).find(kind => REQUEST_KINDS[kind].join() === ordinals.join()) || null;
  };
  for (let index = 0; index < filters.length; index++) {
    const { type, values } = filters[index];
    if (type === FILTER_TYPES.CALL_SERVICE_TYPE && input.requestKind === undefined && kindOf(index)) {
      input.requestKind = kindOf(index);
      index += REQUEST_KINDS[input.requestKind].length - 1;
    } else if (type === FILTER_TYPES.SERVICE_NAME && values.length === 1 && input.serviceName === undefined) {
      input.serviceName = values[0];
    } else if (type === FILTER_TYPES.RESPONSE_TIME && values.length === 2 && input.responseTimeMinMs === undefined && input.responseTimeMaxMs === undefined) {
      if (values[0] !== '0') input.responseTimeMinMs = microsToMillis(values[0]);
      if (values[1] !== OPEN_MAX_MICROS) input.responseTimeMaxMs = microsToMillis(values[1]);
      if (values[0] === '0' && values[1] === OPEN_MAX_MICROS) input.responseTimeMinMs = 0;
    } else if (type === FILTER_TYPES.RESPONSE_CODE && values.length === 1 && input.httpCode === undefined) {
      input.httpCode = values[0];
    } else if (type === FILTER_TYPES.FAILED_STATE && values.length === 1 && input.failed === undefined && (values[0] === '0' || values[0] === '1')) {
      input.failed = values[0] === '0';
    } else if (type === FILTER_TYPES.HTTP_METHOD && values.length === 1 && input.httpMethod === undefined && HTTP_METHODS[Number(values[0])]) {
      input.httpMethod = HTTP_METHODS[Number(values[0])];
    } else if (type === FILTER_TYPES.CALL_METHOD_ID && values.length === 1 && input.requestId === undefined) {
      input.requestId = values[0];
    } else if (type === FILTER_TYPES.CALL_METHOD_GROUP_ID && values.length <= 2 && input.requestGroup === undefined) {
      input.requestGroup = values.length === 2 ? { id: values[0], name: values[1] } : { id: values[0] };
    } else if (type === FILTER_TYPES.SERVICE_URL && values.length === 1 && input.urlContains === undefined) {
      input.urlContains = values[0];
    } else {
      raw.push({ type, values });
    }
  }
  if (raw.length) input.raw = raw;
  return input;
}

export function decodeServiceFilter(encoded) {
  if (!given(encoded)) return { version: null, filters: [], input: {} };
  const text = String(encoded);
  const split = text.indexOf(VERSION_SEP);
  if (split === -1) throw new Error('servicefilter has no version separator');
  const version = text.slice(0, split);
  const body = text.slice(split + 1);
  const filters = body === '' ? [] : body.split(FILTER_SEP).map((part) => {
    const at = part.indexOf(TYPE_SEP);
    if (at === -1) throw new Error(`servicefilter part has no type separator: ${JSON.stringify(part)}`);
    const type = Number(part.slice(0, at));
    if (!Number.isInteger(type)) throw new Error(`servicefilter type is not numeric: ${JSON.stringify(part.slice(0, at))}`);
    return { type, name: filterTypeName(type), values: part.slice(at + 1).split(VALUE_SEP) };
  });
  return { version, filters, input: friendlyInput(filters) };
}

export function describeServiceFilter(input = {}) {
  const parts = [];
  if (given(input.responseTimeMinMs) && given(input.responseTimeMaxMs)) parts.push(`response time ${input.responseTimeMinMs}–${input.responseTimeMaxMs} ms`);
  else if (given(input.responseTimeMinMs)) parts.push(`response time ≥ ${input.responseTimeMinMs} ms`);
  else if (given(input.responseTimeMaxMs)) parts.push(`response time ≤ ${input.responseTimeMaxMs} ms`);
  if (given(input.httpCode)) parts.push(`HTTP ${normalizeHttpCode(input.httpCode)}`);
  if (given(input.failed)) parts.push(input.failed ? 'failed only' : 'successful only');
  if (given(input.httpMethod)) parts.push(`method ${String(input.httpMethod).toUpperCase()}`);
  if (given(input.requestId)) parts.push(given(input.requestName) ? `request ${input.requestName} (${input.requestId})` : `request ${input.requestId}`);
  if (given(input.requestGroup)) {
    const group = typeof input.requestGroup === 'string' ? { id: input.requestGroup } : input.requestGroup;
    parts.push(`request group ${group.name ? `${group.name} (${group.id})` : group.id}`);
  }
  if (given(input.urlContains)) parts.push(`URL contains "${input.urlContains}"`);
  for (const raw of Array.isArray(input.raw) ? input.raw : []) {
    const values = Array.isArray(raw?.values) ? raw.values : [raw?.values];
    parts.push(`${filterTypeName(typeId(raw?.type))}=${values.join('|')}`);
  }
  if (given(input.requestKind)) parts.push(String(input.requestKind).toLowerCase() === 'database' ? 'database calls only' : 'web requests only');
  if (given(input.serviceName)) parts.push(`service name "${input.serviceName}"`);
  return parts.join(', ');
}

export function serviceFilterSchema({ omit = [] } = {}) {
  const schema = {
    response_time_min_ms: { type: 'number', description: 'Only requests whose response time is at least this many milliseconds.' },
    response_time_max_ms: { type: 'number', description: 'Only requests whose response time is at most this many milliseconds.' },
    http_code: { type: 'string', description: "HTTP response code filter: one code ('404'), a class ('4xx', '5xx') or a range ('400-599')." },
    failed: { type: 'boolean', description: 'true = only failed requests, false = only successful requests. Omit for both.' },
    http_method: { type: 'string', enum: HTTP_METHODS, description: 'HTTP method of the request.' },
    request: { type: 'string', description: "One request (endpoint, SQL statement, job) of `service`: its name or a part of the name (e.g. '/cart/checkout'), or its SERVICE_METHOD-… id. A name is looked up among the requests of `service` (one extra request), so it needs `service`; several matches return the candidates instead of guessing. An id works without a lookup." },
    request_group_id: { type: 'string', description: "A request type as a SERVICE_METHOD_GROUP-… id. For a 'Requests to unmonitored hosts' service this id is the target host (printed by list_service_requests; there the host name can also be passed as `request`)." },
    request_group_name: { type: 'string', description: 'Display name belonging to request_group_id, exactly as printed next to the id. Pass it together with request_group_id.' },
    url_contains: { type: 'string', description: "Only web requests whose URL contains this text. The quick way to filter by a URL path fragment (e.g. '/checkout') without knowing the service or the request: it works with or without `service`. It matches nothing for non-web requests (SQL statements, cron jobs, messaging, custom services), which have no URL; use `request` for those." },
    request_kind: { type: 'string', enum: Object.keys(REQUEST_KINDS), description: 'web = only requests of web request and web services (HTTP endpoints, including calls to unmonitored hosts); database = only SQL statements. Omit for every kind (also background activity, custom and messaging services).' },
    raw_filters: {
      type: 'array',
      description: `Escape hatch for servicefilter types without a dedicated argument. Each entry is {type, values}; type is a numeric id or one of ${Object.keys(FILTER_TYPES).filter(n => !VERIFIED_TYPES.includes(FILTER_TYPES[n])).join(', ')}. Value formats of these types are not verified; time values are microseconds.`,
      items: {
        type: 'object',
        properties: {
          type: { type: ['string', 'number'], description: 'Filter type id or name.' },
          values: { type: 'array', items: { type: 'string' }, description: 'Values of this filter, in order.' },
        },
        required: ['type', 'values'],
      },
    },
  };
  return Object.fromEntries(Object.entries(schema).filter(([name]) => !omit.includes(name)));
}

function millisArgument(value, name) {
  const number = typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
    throw new Error(`\`${name}\` must be a non-negative number of milliseconds, got ${JSON.stringify(value)}`);
  }
  return number;
}

function booleanArgument(value, name) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (text === true || text === 'true') return true;
  if (text === false || text === 'false') return false;
  throw new Error(`\`${name}\` must be true or false, got ${JSON.stringify(value)}`);
}

export function serviceFilterFromArgs(args = {}) {
  const input = {};
  if (given(args.response_time_min_ms)) input.responseTimeMinMs = millisArgument(args.response_time_min_ms, 'response_time_min_ms');
  if (given(args.response_time_max_ms)) input.responseTimeMaxMs = millisArgument(args.response_time_max_ms, 'response_time_max_ms');
  if (given(input.responseTimeMinMs) && given(input.responseTimeMaxMs) && input.responseTimeMinMs > input.responseTimeMaxMs) {
    throw new Error(`\`response_time_min_ms\` (${input.responseTimeMinMs}) is larger than \`response_time_max_ms\` (${input.responseTimeMaxMs})`);
  }
  if (given(args.http_code)) input.httpCode = args.http_code;
  if (given(args.failed)) input.failed = booleanArgument(args.failed, 'failed');
  if (given(args.http_method)) input.httpMethod = args.http_method;
  const request = given(args.request) ? String(args.request).trim() : '';
  if (request && !isRequestReference(request)) {
    throw new Error(`\`request\` "${request}" is a name: names are looked up among the requests of one service, so also pass \`service\`. Without a service use \`url_contains\` (web requests) or a SERVICE_METHOD-… id.`);
  }
  if (REQUEST_ID.test(request)) input.requestId = request;
  if (REQUEST_GROUP_ID.test(request) && given(args.request_group_id) && args.request_group_id !== request) {
    throw new Error('`request` and `request_group_id` name two different request groups; pass one of them');
  }
  const groupId = given(args.request_group_id) ? args.request_group_id : (REQUEST_GROUP_ID.test(request) ? request : null);
  if (groupId) {
    input.requestGroup = given(args.request_group_name) ? { id: groupId, name: args.request_group_name } : { id: groupId };
  } else if (given(args.request_group_name)) {
    throw new Error('`request_group_name` needs `request_group_id`');
  }
  if (given(args.url_contains)) input.urlContains = args.url_contains;
  if (given(args.request_kind)) input.requestKind = String(args.request_kind).trim().toLowerCase();
  if (given(args.raw_filters) && !Array.isArray(args.raw_filters)) throw new Error(`\`raw_filters\` must be a list of {type, values} entries, got ${JSON.stringify(args.raw_filters)}`);
  if (Array.isArray(args.raw_filters) && args.raw_filters.length) input.raw = args.raw_filters;
  return input;
}

export function matchRequest(contributors, text) {
  const wanted = String(text).trim().toLowerCase();
  const named = (contributors || []).filter(c => c && typeof c.id === 'string' && typeof c.name === 'string');
  const exact = named.filter(c => c.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  const candidates = exact.length ? exact : named.filter(c => c.name.toLowerCase().includes(wanted));
  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
}
