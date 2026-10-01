(() => {
  const GET_ROUTES = [
    "/rest/v2/entities",
    "/rest/v2/entities/{id}",
    "/rest/v2/entityTypes",
    "/rest/v2/metrics",
    "/rest/v2/metrics/query",
    "/rest/v2/problems",
    "/rest/v2/problems/{id}",
    "/rest/v2/events",
    "/rest/v2/settings/schemas",
    "/rest/v2/settings/objects",
    "/rest/v2/settings/effectiveValues",
    "/rest/purepaths/list",
    "/rest/serviceanalysis/failure",
    "/rest/serviceanalysis/responsetime",
    "/rest/serviceanalysis/responsetimedistribution",
    "/rest/serviceanalysis/serviceflow",
    "/rest/serviceanalysis/servicebacktrace",
    "/rest/serviceanalysis/trace",
    "/rest/serviceanalysis/servicecalldetails",
    "/rest/mda2",
    "/rest/mda2/uiDefs",
    "/rest/services/servicecontributor",
    "/rest/codelevelanalysis/methodhotspots/{id}",
    "/rest/codelevelanalysis/threadanalysis/{id}",
    "/rest/codelevelanalysis/memoryallocation/{id}",
    "/rest/profiling/cpu/pgs",
    "/rest/globalAnalysis/processCrash",
    "/rest/globalAnalysis/globalAnalysisChart",
    "/rest/hosts/{id}",
    "/rest/processes/processGroups/{id}",
    "/rest/processes/{id}/processdetails",
    "/rest/problems/{id}",
    "/rest/problems/{id}/model",
    "/rest/dashboards/list",
    "/rest/dashboards/{id}",
    "/rest/config/dashboards/{id}/tiles/{id}",
  ];

  const DENIED_FRAGMENTS = ["apiTokens", "credentials", "memoryDumps", "memorydump", "tokens"];
  const ID_SEGMENT = /^[A-Za-z0-9_.:-]+$/;

  const refuse = (reason) => ({ allowed: false, reason });

  function matchesRoute(path, route) {
    const wanted = route.split("/");
    const given = path.split("/");
    if (wanted.length !== given.length) return false;
    return wanted.every((part, index) => (part === "{id}" ? ID_SEGMENT.test(given[index]) : part === given[index]));
  }

  function pathProblem(path) {
    if (typeof path !== "string" || !path.startsWith("/rest/")) return "path must be a string starting with /rest/";
    if (path.includes("%")) return "path contains a percent sign; encoded path segments are never allowed";
    if (path.includes("..")) return "path contains ..";
    if (path.includes("//")) return "path contains //";
    if (path.includes("\\")) return "path contains a backslash";
    if (/[?#]/.test(path)) return "path contains a query or fragment; pass parameters in query";
    if (/[\x00-\x20\x7f]/.test(path)) return "path contains whitespace or control characters";
    return null;
  }

  function check(method, path) {
    if (method !== "GET") return refuse(`method ${String(method)} is not allowed; the bridge is read-only and sends only GET`);
    const problem = pathProblem(path);
    if (problem) return refuse(problem);
    const lowered = path.toLowerCase();
    const denied = DENIED_FRAGMENTS.find((fragment) => lowered.includes(fragment.toLowerCase()));
    if (denied) return refuse(`path contains "${denied}", which is always denied`);
    return GET_ROUTES.some((route) => matchesRoute(path, route))
      ? { allowed: true }
      : refuse("GET path is not on the read-only allow-list");
  }

  globalThis.DT_ALLOWLIST = Object.freeze({ check, routes: Object.freeze([...GET_ROUTES]) });
})();
