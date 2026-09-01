export function parseModelQuery(searchParams) {
  const modelFilter = String(searchParams?.get?.('model') || '').trim().toLowerCase();
  const taskName = String(searchParams?.get?.('task') || '').trim().toLowerCase();
  const excludeVendorParam = searchParams?.get?.('exclude_vendor')
    || searchParams?.get?.('exclude_vendors')
    || '';
  return Object.freeze({
    modelFilter,
    taskName,
    onlyAvailable: String(searchParams?.get?.('available') || '').trim() === '1',
    includeEligibilityDetails: String(searchParams?.get?.('details') || '').trim() === 'eligibility',
    excludedVendors: new Set(
      String(excludeVendorParam)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  });
}

export function filterModelInventory(inventory, query) {
  const output = [];
  for (const source of inventory || []) {
    if (query.modelFilter && !String(source.id || '').toLowerCase().includes(query.modelFilter)) {
      continue;
    }
    const item = { ...source };
    if (query.excludedVendors?.size > 0 && Array.isArray(item.routes)) {
      item.routes = item.routes.filter((route) => (
        !query.excludedVendors.has(String(route.vendor || '').toLowerCase())
      ));
      if (item.routes.length === 0) continue;
      item.health = aggregateRouteHealth(item.routes);
    }
    if (query.onlyAvailable && item.health !== 'available') continue;
    output.push(item);
  }
  return output;
}

export function modelListPayload(data, query, { includeMetadata = true } = {}) {
  const response = { object: 'list', data };
  if (!includeMetadata) return response;
  return {
    ...response,
    count: data.length,
    available: data.filter((model) => model.health === 'available').length,
    filtered: Boolean(query.modelFilter),
    model_filter: query.modelFilter || null,
    requested_task: query.taskName || null,
    excluded_vendors: [...(query.excludedVendors || [])],
  };
}

function aggregateRouteHealth(routes) {
  if (routes.some((route) => route.health === 'available')) return 'available';
  if (routes.some((route) => route.health === 'congested')) return 'congested';
  if (routes.some((route) => route.health === 'probing')) return 'probing';
  return 'unavailable';
}
