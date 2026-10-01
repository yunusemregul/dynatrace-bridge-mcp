export const GET_ROUTES = [
  '/rest/v2/entities',
  '/rest/v2/entities/{id}',
  '/rest/v2/entityTypes',
  '/rest/v2/metrics',
  '/rest/v2/metrics/query',
  '/rest/v2/problems',
  '/rest/v2/problems/{id}',
  '/rest/v2/events',
  '/rest/v2/settings/schemas',
  '/rest/v2/settings/objects',
  '/rest/v2/settings/effectiveValues',
  '/rest/purepaths/list',
  '/rest/serviceanalysis/failure',
  '/rest/serviceanalysis/responsetime',
  '/rest/serviceanalysis/responsetimedistribution',
  '/rest/serviceanalysis/serviceflow',
  '/rest/serviceanalysis/servicebacktrace',
  '/rest/serviceanalysis/trace',
  '/rest/serviceanalysis/servicecalldetails',
  '/rest/mda2',
  '/rest/mda2/uiDefs',
  '/rest/services/servicecontributor',
  '/rest/codelevelanalysis/methodhotspots/{id}',
  '/rest/codelevelanalysis/threadanalysis/{id}',
  '/rest/codelevelanalysis/memoryallocation/{id}',
  '/rest/profiling/cpu/pgs',
  '/rest/globalAnalysis/processCrash',
  '/rest/globalAnalysis/globalAnalysisChart',
  '/rest/hosts/{id}',
  '/rest/processes/processGroups/{id}',
  '/rest/processes/{id}/processdetails',
  '/rest/problems/{id}',
  '/rest/problems/{id}/model',
  '/rest/dashboards/list',
  '/rest/dashboards/{id}',
  '/rest/config/dashboards/{id}/tiles/{id}',
];

export const DENIED_FRAGMENTS = ['apiTokens', 'credentials', 'memoryDumps', 'memorydump', 'tokens'];

const ID_SEGMENT = /^[A-Za-z0-9_.:-]+$/;

const MALFORMED = [
  [/%/, 'path contains a percent sign; encoded path segments are never allowed'],
  [/\.\./, 'path contains ".."'],
  [/\/\//, 'path contains "//"'],
  [/\\/, 'path contains a backslash'],
  [/[?#]/, 'path contains a query or fragment; pass parameters through `query`'],
  [/[\x00-\x20\x7f]/, 'path contains whitespace or control characters'],
];

const allow = () => ({ allowed: true });
const deny = (reason) => ({ allowed: false, reason });

export function matchesRoute(path, route) {
  const wanted = route.split('/');
  const given = path.split('/');
  if (wanted.length !== given.length) return false;
  return wanted.every((part, index) => (part === '{id}' ? ID_SEGMENT.test(given[index]) : part === given[index]));
}

export function checkRequest(method, path) {
  if (method !== 'GET') {
    return deny(`method ${String(method)} is not allowed; the bridge is read-only and sends only GET`);
  }
  if (typeof path !== 'string' || !path.startsWith('/rest/')) {
    return deny('path must be a string starting with /rest/');
  }
  for (const [pattern, reason] of MALFORMED) {
    if (pattern.test(path)) return deny(reason);
  }
  const lower = path.toLowerCase();
  const fragment = DENIED_FRAGMENTS.find(f => lower.includes(f.toLowerCase()));
  if (fragment) return deny(`paths containing "${fragment}" are never allowed`);
  return GET_ROUTES.some(route => matchesRoute(path, route)) ? allow() : deny(`GET ${path} is not on the read-only allow-list`);
}
