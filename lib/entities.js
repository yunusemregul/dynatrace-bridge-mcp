import { BridgeError } from './bridge.js';

const ENTITY_ID = /^[A-Z][A-Z0-9_]*-[0-9A-F]{16}$/;

export function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID.test(value.trim());
}

export function entityTypeOf(id) {
  return isEntityId(id) ? id.trim().slice(0, id.trim().lastIndexOf('-')) : null;
}

export function quoteSelectorValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function entityFields(fields) {
  const list = (Array.isArray(fields) ? fields : String(fields ?? '').split(','))
    .map(f => String(f).trim().replace(/^\+/, ''))
    .filter(Boolean);
  return list.length ? [...new Set(list)].map(f => `+${f}`).join(',') : undefined;
}

export const SELECTOR_BUDGET = 1500;

export function idSelector(ids) {
  return `entityId(${ids.map(quoteSelectorValue).join(',')})`;
}

export function chunkIds(ids, build = idSelector, budget = SELECTOR_BUDGET) {
  const chunks = [];
  let current = [];
  for (const id of [...new Set(ids || [])]) {
    if (current.length && build([...current, id]).length > budget) {
      chunks.push(current);
      current = [];
    }
    current.push(id);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const SOFT_FAILURES = ['HTTP_ERROR', 'POLL_TIMEOUT', 'TIMEOUT', 'RESPONSE_TOO_LARGE'];

function typeList(type) {
  return (Array.isArray(type) ? type : [type])
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim().toUpperCase());
}

function candidateLines(candidates) {
  return candidates.map(e => `- \`${e.entityId}\` ${e.displayName} (${e.type})`).join('\n');
}

export function createEntityHelpers({ dt, v2List }) {
  async function list(selector, { fields, time = null, limit = 50, sort = 'name', label = null } = {}) {
    const query = { entitySelector: selector, fields: entityFields(fields), sort, ...(time ? time.v2Query : {}) };
    const { items, totalCount } = await v2List('/rest/v2/entities', query, { itemsKey: 'entities', limit, label: label || `entities ${selector}` });
    return { entities: items, totalCount };
  }

  async function get(id, { fields, time = null, label = null } = {}) {
    const entityId = String(id).trim();
    try {
      const { data } = await dt(
        { path: `/rest/v2/entities/${entityId}`, query: { fields: entityFields(fields), ...(time ? time.v2Query : {}) } },
        { label: label || `entity ${entityId}` },
      );
      return data;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'HTTP_ERROR' && (error.status === 404 || error.status === 400)) {
        throw new Error(`No entity \`${entityId}\` found${time ? ` in ${time.describe}` : ''}. Check the id, widen the time window, or search with find_entities.`);
      }
      throw error;
    }
  }

  async function search(types, criterion, options) {
    const results = await Promise.all(types.map(type => list(`type(${quoteSelectorValue(type)}),${criterion}`, { ...options, limit: 20 })));
    return results.flatMap(r => r.entities);
  }

  async function resolve(ref, { type, fields, time = null, what = 'entity' } = {}) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`\`${what}\` is required: pass an entity id or a name`);
    const value = ref.trim();
    const types = typeList(type);
    if (isEntityId(value)) {
      if (types.length && !types.includes(entityTypeOf(value))) {
        throw new Error(`\`${value}\` is a ${entityTypeOf(value)} id, but this needs ${types.join(' or ')}`);
      }
      return get(value, { fields, time });
    }
    if (types.length === 0) {
      throw new Error(`"${value}" is not an entity id. To look an entity up by name, also pass its type (e.g. SERVICE, HOST, PROCESS_GROUP, CLOUD_APPLICATION), or find the id with find_entities.`);
    }
    const options = { fields, time, label: `find ${what} "${value}"` };
    const exact = await search(types, `entityName.equals(${quoteSelectorValue(value)})`, options);
    if (exact.length === 1) return exact[0];
    const matches = exact.length ? exact : await search(types, `entityName.contains(${quoteSelectorValue(value)})`, options);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`No ${types.join(' / ')} named "${value}" found${time ? ` in ${time.describe}` : ''}. Search with find_entities or widen the time window.`);
    }
    throw new Error(`"${value}" matches ${matches.length}${matches.length === 20 * types.length ? '+' : ''} entities. Pass the id of the one you mean:\n${candidateLines(matches)}`);
  }

  async function listByIds(ids, { selector = idSelector, limit = null, ...options } = {}) {
    const chunks = chunkIds(ids, selector);
    const results = await Promise.all(chunks.map(chunk => list(selector(chunk), { ...options, limit: limit ?? chunk.length })));
    const seen = new Map();
    for (const entity of results.flatMap(result => result.entities)) if (!seen.has(entity.entityId)) seen.set(entity.entityId, entity);
    return { entities: [...seen.values()], totalCount: results.reduce((total, result) => total + result.totalCount, 0), requests: chunks.length };
  }

  async function names(ids, { time = null } = {}) {
    const byType = new Map();
    for (const id of new Set((ids || []).filter(isEntityId))) {
      const type = entityTypeOf(id);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(id);
    }
    const found = new Map();
    const failures = [];
    await Promise.all([...byType.entries()].flatMap(([type, group]) => chunkIds(group).map(async (chunk) => {
      try {
        const { entities } = await list(idSelector(chunk), { time, limit: chunk.length, label: `names of ${chunk.length} ${type}` });
        for (const entity of entities) found.set(entity.entityId, entity.displayName);
      } catch (error) {
        if (!(error instanceof BridgeError) || !SOFT_FAILURES.includes(error.code)) throw error;
        failures.push({ type, count: chunk.length, message: String(error.message).replace(/\s+/g, ' ').trim() });
      }
    })));
    const failed = failures.reduce((total, failure) => total + failure.count, 0);
    found.note = failures.length
      ? `_The names of ${failed} ${failed === 1 ? 'entity' : 'entities'} (${[...new Set(failures.map(failure => failure.type))].join(', ')}) could not be looked up, so only ${failed === 1 ? 'its id is' : 'their ids are'} shown: ${failures[0].message.slice(0, 200)}_`
      : null;
    return found;
  }

  function service(ref, { time = null, fields = [], what = 'service' } = {}) {
    const wanted = (Array.isArray(fields) ? fields : String(fields ?? '').split(',')).map(f => String(f).trim().replace(/^\+/, '')).filter(Boolean);
    const withType = wanted.includes('properties') ? wanted : ['properties.serviceType', ...wanted];
    return resolve(ref, { type: 'SERVICE', fields: withType, time, what });
  }

  async function resolveOne(args, targets, { time = null, fields = {} } = {}) {
    const keys = Object.keys(targets);
    const given = keys.filter(key => typeof args?.[key] === 'string' && args[key].trim());
    if (given.length !== 1) throw new Error(`pass exactly one of ${keys.map(key => `\`${key}\``).join(', ')} (an entity id or a name).`);
    const key = given[0];
    const entity = await resolve(args[key], { type: targets[key], fields: fields[key], time, what: key });
    return { key, entity };
  }

  return { isId: isEntityId, typeOf: entityTypeOf, quote: quoteSelectorValue, fields: entityFields, idSelector, chunkIds, list, listByIds, get, resolve, service, resolveOne, names };
}
