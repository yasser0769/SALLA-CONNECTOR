const {
  envConfig,
  sendJson,
  readSession,
  writeSession,
  tokenRequest,
  parseUpstreamResponse,
  debugId,
} = require('./_lib/salla');

const SALLA_BRANCH_ID = process.env.SALLA_BRANCH_ID || '';
const SALLA_QUANTITY_REASON_ID = process.env.SALLA_QUANTITY_REASON_ID || '';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const id = debugId();
  const config = envConfig();
  if (!config.clientId || !config.clientSecret || !config.appSecret) {
    return sendJson(res, 500, {
      error: 'Missing required env vars',
      missing: [
        !config.clientId ? 'SALLA_CLIENT_ID' : null,
        !config.clientSecret ? 'SALLA_CLIENT_SECRET' : null,
        !config.appSecret ? 'APP_SESSION_SECRET' : null,
      ].filter(Boolean),
      debug_id: id,
    });
  }

  let session = readSession(req, config);
  if (!session || !session.access_token) {
    return sendJson(res, 401, { error: 'Not connected. Connect first.', debug_id: id });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message, debug_id: id });
  }

  const supplierItems = Array.isArray(body && body.supplierItems) ? body.supplierItems : [];
  const zeroMissingSku = Boolean(body && body.zeroMissingSku);
  const dryRun = body && body.dryRun !== false;
  const mode = body && body.mode === 'chunk' ? 'chunk' : 'full';
  const requestedPage = Number(body && body.page) > 0 ? Number(body.page) : 1;
  const requestedPerPage = Number(body && body.per_page) > 0 ? Number(body.per_page) : 100;
  const perPage = Math.min(Math.max(requestedPerPage, 1), 100);

  if (!supplierItems.length) {
    return sendJson(res, 400, { error: 'supplierItems فارغ.', debug_id: id });
  }

  const adminBase = buildAdminBase(config.apiBase);

  async function refreshAccessToken() {
    if (!session || !session.refresh_token) return false;

    const refreshed = await tokenRequest(config, {
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    if (refreshed.status >= 400 || !refreshed.body || !refreshed.body.access_token) {
      return false;
    }

    session = {
      ...session,
      access_token: refreshed.body.access_token,
      refresh_token: refreshed.body.refresh_token || session.refresh_token,
      token_type: refreshed.body.token_type || 'Bearer',
      expires_in: refreshed.body.expires_in || session.expires_in || null,
      updated_at: Date.now(),
    };
    writeSession(res, config, session);
    return true;
  }

  async function apiFetch(pathname, options = {}, retry = true) {
    const headers = {
      Authorization: `Bearer ${session.access_token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };

    const resp = await fetch(`${adminBase}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let parsed = await parseUpstreamResponse(resp);
    if ((parsed.status === 401 || parsed.status === 403) && retry) {
      const ok = await refreshAccessToken();
      if (ok) return apiFetch(pathname, options, false);
    }

    return parsed;
  }

  try {
    const supplierMap = buildSupplierMap(supplierItems);

    if (mode === 'chunk') {
      const pageResult = await fetchQuantitiesPage(apiFetch, requestedPage, perPage, id);
      const plan = buildSyncPlan({
        supplierMap,
        sallaRows: pageResult.rows,
        zeroMissingSku,
        computeMissingSupplierInSalla: false,
      });
      const matchedSkus = collectMatchedSkus(pageResult.rows, supplierMap);

      const payload = {
        mode: 'chunk',
        dryRun,
        page: pageResult.page,
        per_page: perPage,
        next_page: pageResult.nextPage,
        total_pages: pageResult.totalPages,
        items_in_page: pageResult.rows.length,
        stats_chunk: {
          ...plan.stats,
          sallaSkus: pageResult.rows.length,
          page: pageResult.page,
          nextPage: pageResult.nextPage,
          totalPages: pageResult.totalPages,
        },
        matched_skus: matchedSkus,
        previewRows: plan.previewRows.slice(0, 120),
        failedPriceUpdates: [],
        failedQuantityUpdates: [],
      };

      if (!dryRun) {
        const defaultReasonId = await resolveQuantityReasonId(apiFetch);
        const quantityResult = await applyQuantityUpdates(apiFetch, plan.quantityUpdates, defaultReasonId);
        const priceResult = await applyPriceUpdates(apiFetch, plan.priceUpdates);
        payload.failedPriceUpdates = priceResult.failed;
        payload.failedQuantityUpdates = quantityResult.failed;
        payload.stats_chunk.quantityUpdated = quantityResult.success;
        payload.stats_chunk.priceUpdated = priceResult.success;
      }

      return sendJson(res, 200, payload);
    }

    const sallaRows = await fetchAllProductQuantities(apiFetch, id);
    const plan = buildSyncPlan({ supplierMap, sallaRows, zeroMissingSku });

    const payload = {
      dryRun,
      async: false,
      stats: plan.stats,
      previewRows: plan.previewRows.slice(0, 300),
      missingSupplierInSalla: plan.missingSupplierInSalla.slice(0, 300),
      failedPriceUpdates: [],
      failedQuantityUpdates: [],
    };

    if (dryRun) {
      return sendJson(res, 200, payload);
    }

    const defaultReasonId = await resolveQuantityReasonId(apiFetch);
    const quantityResult = await applyQuantityUpdates(apiFetch, plan.quantityUpdates, defaultReasonId);
    const priceResult = await applyPriceUpdates(apiFetch, plan.priceUpdates);

    payload.failedPriceUpdates = priceResult.failed;
    payload.failedQuantityUpdates = quantityResult.failed;
    payload.stats.quantityUpdated = quantityResult.success;
    payload.stats.priceUpdated = priceResult.success;

    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, 500, { error: error.message, debug_id: id });
  }
};

async function fetchQuantitiesPage(apiFetch, page, perPage, debugIdValue) {
  const upstream = await apiFetch(`/products/quantities?page=${page}&per_page=${perPage}`);
  if (upstream.status >= 400) {
    throw new Error(`Failed fetching quantities page=${page}: ${JSON.stringify(upstream.body || {}).slice(0, 300)}`);
  }

  const rows = extractDataArray(upstream.body);
  const pagination = extractPagination(upstream.body, page);
  const nextPage = deriveNextPage(pagination, page, rows.length, perPage);

  console.log(`[sync:${debugIdValue}] chunk page=${page} rows=${rows.length} next=${nextPage || 'none'}`);
  return {
    page,
    rows,
    nextPage,
    totalPages: Number.isFinite(pagination.totalPages) ? pagination.totalPages : null,
  };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function buildAdminBase(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  return base.endsWith('/admin/v2') ? base : `${base}/admin/v2`;
}

function normalizeSku(v) {
  return cleanText(v).toLowerCase().replace(/\s+/g, '');
}

function cleanText(v) {
  return String(v ?? '').trim();
}

function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).replace(/,/g, '').trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function toInteger(v) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n);
}

function round2(v) {
  return Number(v.toFixed(2));
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isDifferentNumber(a, b) {
  const aFinite = Number.isFinite(a);
  const bFinite = Number.isFinite(b);
  if (!aFinite && !bFinite) return false;
  if (!aFinite || !bFinite) return true;
  return Math.abs(a - b) > 0.00001;
}

function buildSupplierMap(items) {
  const map = new Map();
  let duplicates = 0;

  for (const item of items) {
    const rawSku = cleanText(item.sku);
    const sku = normalizeSku(rawSku);
    if (!sku) continue;

    if (map.has(sku)) duplicates += 1;

    const price = toNumber(item.price);
    const stock = toInteger(item.stock);
    map.set(sku, {
      sku: rawSku || sku,
      price: Number.isFinite(price) ? round2(price) : null,
      stock: Number.isFinite(stock) ? Math.max(0, stock) : 0,
    });
  }

  map.duplicates = duplicates;
  return map;
}

function buildSyncPlan({
  supplierMap,
  sallaRows,
  zeroMissingSku,
  computeMissingSupplierInSalla = true,
}) {
  const quantityUpdates = [];
  const priceUpdates = [];
  const previewRows = [];
  const seenSallaSkus = new Set();
  let matched = 0;
  let zeroed = 0;
  let withMissingIdentifier = 0;

  for (const row of sallaRows) {
    const skuRaw = cleanText(row.sku);
    const sku = normalizeSku(skuRaw);
    if (!sku) continue;
    seenSallaSkus.add(sku);

    const supplier = supplierMap.get(sku);
    const currentQuantity = toInteger(row.quantity);
    const currentPrice = toNumber(row.price);
    let targetQuantity = currentQuantity;
    let targetPrice = currentPrice;
    let action = 'unchanged';

    if (supplier) {
      matched += 1;
      action = 'matched';
      targetQuantity = supplier.stock;
      if (supplier.price !== null) targetPrice = supplier.price;
    } else if (zeroMissingSku) {
      action = 'zeroed';
      targetQuantity = 0;
      zeroed += 1;
    } else {
      continue;
    }

    const quantityChanged = isDifferentNumber(currentQuantity, targetQuantity);
    const priceChanged = supplier && supplier.price !== null ? isDifferentNumber(currentPrice, targetPrice) : false;

    if (quantityChanged) {
      const identifier = row.sku_id || row.id || null;
      const identifierType = row.sku_id ? 'variant_id' : 'id';
      if (identifier) {
        const payloadItem = {
          identifier_type: identifierType,
          identifer_type: identifierType,
          identifer: String(identifier),
          identifier: String(identifier),
          quantity: Math.max(0, toInteger(targetQuantity)),
          mode: 'overwrite',
          unlimited_quantity: false,
        };
        if (SALLA_BRANCH_ID) payloadItem.branch = SALLA_BRANCH_ID;
        if (SALLA_QUANTITY_REASON_ID) {
          const reason = toFiniteNumber(SALLA_QUANTITY_REASON_ID);
          if (Number.isFinite(reason)) payloadItem.reason_id = reason;
        }
        quantityUpdates.push(payloadItem);
      } else {
        withMissingIdentifier += 1;
      }
    }

    if (priceChanged && supplier && Number.isFinite(targetPrice)) {
      priceUpdates.push({ sku: skuRaw, price: round2(targetPrice) });
    }

    if (quantityChanged || priceChanged) {
      previewRows.push({
        sku: skuRaw,
        current_quantity: Number.isFinite(currentQuantity) ? currentQuantity : '',
        new_quantity: Number.isFinite(targetQuantity) ? Math.max(0, toInteger(targetQuantity)) : '',
        current_price: Number.isFinite(currentPrice) ? round2(currentPrice) : '',
        new_price: Number.isFinite(targetPrice) ? round2(targetPrice) : '',
        action,
      });
    }
  }

  const missingSupplierInSalla = [];
  if (computeMissingSupplierInSalla) {
    for (const [sku, entry] of supplierMap.entries()) {
      if (seenSallaSkus.has(sku)) continue;
      missingSupplierInSalla.push({
        sku: entry.sku,
        supplier_price: entry.price ?? '',
        supplier_stock: entry.stock ?? '',
      });
    }
  }

  return {
    quantityUpdates,
    priceUpdates,
    previewRows,
    missingSupplierInSalla,
    stats: {
      supplierSkus: supplierMap.size,
      duplicateSupplierSkus: supplierMap.duplicates || 0,
      sallaSkus: seenSallaSkus.size,
      matched,
      zeroed,
      plannedQuantityUpdates: quantityUpdates.length,
      plannedPriceUpdates: priceUpdates.length,
      missingIdentifierRows: withMissingIdentifier,
      missingSupplierInSalla: missingSupplierInSalla.length,
    },
  };
}

function collectMatchedSkus(rows, supplierMap) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const sku = normalizeSku(row && row.sku);
    if (!sku || !supplierMap.has(sku) || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
}

async function resolveQuantityReasonId(apiFetch) {
  if (SALLA_QUANTITY_REASON_ID) {
    const envId = toFiniteNumber(SALLA_QUANTITY_REASON_ID);
    if (Number.isFinite(envId)) return envId;
  }
  const upstream = await apiFetch('/products/quantities/quantity-change-reason');
  if (upstream.status >= 400) return null;
  const list = Array.isArray(upstream.body && upstream.body.data) ? upstream.body.data : [];
  const first = list.find((x) => Number.isFinite(toFiniteNumber(x && x.id)));
  return first ? toFiniteNumber(first.id) : null;
}

async function applyQuantityUpdates(apiFetch, updates, defaultReasonId) {
  if (!updates.length) return { success: 0, failed: [] };
  const failed = [];
  let success = 0;
  const chunkSize = 100;
  const prepared = updates.map((item) => ({
    ...item,
    ...(item.reason_id ? {} : (defaultReasonId ? { reason_id: defaultReasonId } : {})),
  }));

  for (let i = 0; i < prepared.length; i += chunkSize) {
    const chunk = prepared.slice(i, i + chunkSize);
    const upstream = await apiFetch('/products/quantities/bulk', {
      method: 'POST',
      body: { products: chunk },
    });

    if (upstream.status < 400) {
      success += chunk.length;
      continue;
    }

    for (const item of chunk) {
      const single = await apiFetch('/products/quantities/bulk', {
        method: 'POST',
        body: { products: [item] },
      });
      if (single.status < 400) {
        success += 1;
      } else {
        failed.push({
          identifier: item.identifer || item.identifier || '',
          identifier_type: item.identifer_type || item.identifier_type || '',
          message: JSON.stringify(single.body || {}).slice(0, 500),
        });
      }
    }
  }

  return { success, failed };
}

async function applyPriceUpdates(apiFetch, updates) {
  const failed = [];
  let success = 0;
  for (const update of updates) {
    const upstream = await apiFetch(`/products/sku/${encodeURIComponent(update.sku)}/price`, {
      method: 'POST',
      body: { price: update.price },
    });
    if (upstream.status < 400) {
      success += 1;
    } else {
      failed.push({
        sku: update.sku,
        message: JSON.stringify(upstream.body || {}).slice(0, 500),
      });
    }
  }
  return { success, failed };
}

async function fetchAllProductQuantities(apiFetch, debugIdValue) {
  const rows = [];
  const seenKeys = new Set();
  let page = 1;
  const perPage = 100;
  const maxPages = 2000;

  while (page <= maxPages) {
    const upstream = await apiFetch(`/products/quantities?page=${page}&per_page=${perPage}`);
    if (upstream.status >= 400) {
      throw new Error(`Failed fetching quantities page=${page}: ${JSON.stringify(upstream.body || {}).slice(0, 300)}`);
    }

    const chunk = extractDataArray(upstream.body);
    const added = appendUniqueQuantityRows(rows, chunk, seenKeys);
    const pagination = extractPagination(upstream.body, page);
    console.log(`[sync:${debugIdValue}] quantities page=${page} chunk=${chunk.length} added=${added}`);

    const nextPage = deriveNextPage(pagination, page, chunk.length, perPage);
    if (nextPage) {
      page = nextPage;
      continue;
    }
    if (chunk.length === 0 || added === 0) break;
    break;
  }

  return rows;
}

function deriveNextPage(pagination, page, chunkLength, perPage) {
  if (Number.isFinite(pagination.nextPage) && pagination.nextPage > page) {
    return pagination.nextPage;
  }
  if (pagination.hasNext === true) {
    return page + 1;
  }
  if (
    Number.isFinite(pagination.totalPages) &&
    Number.isFinite(pagination.currentPage) &&
    pagination.currentPage < pagination.totalPages
  ) {
    return pagination.currentPage + 1;
  }
  if (!pagination.isExplicit && chunkLength >= perPage) {
    return page + 1;
  }
  return null;
}

function extractDataArray(payload) {
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function appendUniqueQuantityRows(targetRows, incomingRows, seenKeys) {
  let added = 0;
  for (const row of incomingRows) {
    const key = buildQuantityRowKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    targetRows.push(row);
    added += 1;
  }
  return added;
}

function buildQuantityRowKey(row) {
  const id = cleanText(row && row.id);
  const skuId = cleanText(row && row.sku_id);
  const sku = normalizeSku(row && row.sku);
  if (skuId) return `sku_id:${skuId}`;
  if (id && sku) return `id_sku:${id}:${sku}`;
  if (id) return `id:${id}`;
  if (sku) return `sku:${sku}`;
  return `raw:${JSON.stringify(row || {})}`;
}

function extractPagination(payload, fallbackPage) {
  const p1 = payload && payload.pagination ? payload.pagination : null;
  const p2 = payload && payload.meta && payload.meta.pagination ? payload.meta.pagination : null;
  const p3 = payload && payload.meta ? payload.meta : null;
  const links = payload && payload.links ? payload.links : null;
  const src = p1 || p2 || p3 || {};

  const currentPage = toFiniteNumber(
    src.current_page ?? src.currentPage ?? src.page ?? src.current ?? fallbackPage
  );
  const totalPages = toFiniteNumber(
    src.total_pages ?? src.totalPages ?? src.last_page ?? src.lastPage
  );
  const nextPage = toFiniteNumber(src.next_page ?? src.nextPage ?? extractPageFromUrl(src.next_page_url));

  let hasNext = null;
  if (typeof src.has_more_pages === 'boolean') hasNext = src.has_more_pages;
  else if (typeof src.hasMore === 'boolean') hasNext = src.hasMore;
  else if (typeof src.has_next === 'boolean') hasNext = src.has_next;
  else if (src.next_page_url) hasNext = true;
  else if (links && (links.next || links.next_page_url)) hasNext = true;
  else if (Number.isFinite(totalPages) && Number.isFinite(currentPage)) hasNext = currentPage < totalPages;

  const explicit =
    hasNext !== null ||
    Number.isFinite(totalPages) ||
    Number.isFinite(nextPage) ||
    Boolean(src.next_page_url) ||
    Boolean(links && (links.next || links.next_page_url));

  return { currentPage, totalPages, nextPage, hasNext, isExplicit: explicit };
}

function extractPageFromUrl(urlValue) {
  const raw = cleanText(urlValue);
  if (!raw) return NaN;
  try {
    const u = new URL(raw);
    return toFiniteNumber(u.searchParams.get('page'));
  } catch {
    const m = raw.match(/[?&]page=(\d+)/i);
    return m ? toFiniteNumber(m[1]) : NaN;
  }
}
