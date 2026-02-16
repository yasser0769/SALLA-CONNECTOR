import { createServer } from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID || "";
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET || "";
const SALLA_REDIRECT_URI = process.env.SALLA_REDIRECT_URI || "http://localhost:3000/callback";
const SALLA_BRANCH_ID = process.env.SALLA_BRANCH_ID || "";
const SALLA_QUANTITY_REASON_ID = process.env.SALLA_QUANTITY_REASON_ID || "";

const SALLA_API_BASE = "https://api.salla.dev/admin/v2";
const SALLA_ACCOUNTS_BASE = "https://accounts.salla.sa";

const SESSION_FILE = path.join(__dirname, ".salla-session.json");

let session = await loadSession();
let cachedQuantityReasonId = undefined;
const syncJobs = new Map();
const SYNC_JOB_TTL_MS = 60 * 60 * 1000;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveIndex(res);
    }

    if (req.method === "GET" && url.pathname === "/auth/salla") {
      return startAuth(url, res);
    }

    if (req.method === "GET" && url.pathname === "/callback") {
      return handleCallback(url, res);
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, {
        connected: Boolean(session.access_token),
        expires_at: session.expires_at || null,
        has_credentials: Boolean(SALLA_CLIENT_ID && SALLA_CLIENT_SECRET),
        redirect_uri: SALLA_REDIRECT_URI
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      session = {};
      await removeSessionFile();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/sync/progress") {
      return handleSyncProgress(url, res);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    }

    return sendText(res, 404, "Not Found");
  } catch (error) {
    return sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Salla sync server running on http://${HOST}:${PORT}`);
});

async function serveIndex(res) {
  const html = await readFile(path.join(__dirname, "index.html"), "utf8");
  return sendHtml(res, 200, html);
}

function startAuth(url, res) {
  if (!SALLA_CLIENT_ID || !SALLA_CLIENT_SECRET) {
    return sendJson(res, 400, {
      error: "missing_credentials",
      message: "SALLA_CLIENT_ID / SALLA_CLIENT_SECRET غير موجودة في .env"
    });
  }

  const state = randomUUID();
  session.oauth_state = state;
  persistSession().catch(() => {});

  const authUrl = new URL(`${SALLA_ACCOUNTS_BASE}/oauth2/auth`);
  authUrl.searchParams.set("client_id", SALLA_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", SALLA_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "offline_access");
  authUrl.searchParams.set("state", state);

  res.statusCode = 302;
  res.setHeader("Location", authUrl.toString());
  res.end();
}

async function handleCallback(url, res) {
  const error = url.searchParams.get("error");
  if (error) {
    return sendHtml(res, 400, `<h2>OAuth Error</h2><p>${escapeHtml(error)}</p>`);
  }

  const state = url.searchParams.get("state") || "";
  if (!state || state !== session.oauth_state) {
    return sendHtml(res, 400, "<h2>OAuth Error</h2><p>Invalid state.</p>");
  }

  const code = url.searchParams.get("code") || "";
  if (!code) {
    return sendHtml(res, 400, "<h2>OAuth Error</h2><p>Missing authorization code.</p>");
  }

  const tokenData = await exchangeCode(code);
  session = {
    ...session,
    ...normalizeTokenData(tokenData),
    oauth_state: ""
  };
  await persistSession();

  res.statusCode = 302;
  res.setHeader("Location", "/index.html?auth=success");
  res.end();
}

async function handleSync(req, res) {
  if (!session.access_token) {
    return sendJson(res, 401, { error: "not_authenticated", message: "اربط حساب سلة أولاً." });
  }

  const body = await readJsonBody(req, 20 * 1024 * 1024);
  const supplierItems = Array.isArray(body.supplierItems) ? body.supplierItems : [];
  const zeroMissingSku = Boolean(body.zeroMissingSku);
  const dryRun = body.dryRun !== false;
  const asyncMode = body.async !== false;

  if (!supplierItems.length) {
    return sendJson(res, 400, { error: "invalid_supplier_data", message: "supplierItems فارغ." });
  }

  const supplierMap = buildSupplierMap(supplierItems);
  const sallaRows = await fetchAllProductQuantities();
  const plan = buildSyncPlan({ supplierMap, sallaRows, zeroMissingSku });

  const payload = {
    dryRun,
    stats: plan.stats,
    previewRows: plan.previewRows.slice(0, 300),
    missingSupplierInSalla: plan.missingSupplierInSalla.slice(0, 300),
    failedPriceUpdates: [],
    failedQuantityUpdates: []
  };

  if (dryRun) {
    return sendJson(res, 200, payload);
  }

  if (asyncMode) {
    const job = createSyncJob(payload);
    runSyncJob(job, plan).catch((error) => {
      job.status = "failed";
      job.error = error.message;
      job.progress.phase = "failed";
      touchJob(job);
    });

    return sendJson(res, 202, {
      async: true,
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      stats: payload.stats
    });
  }

  const result = await executeSyncPlan(plan, payload);
  return sendJson(res, 200, result);
}

function handleSyncProgress(url, res) {
  purgeExpiredJobs();
  const jobId = cleanText(url.searchParams.get("job_id"));
  if (!jobId) {
    return sendJson(res, 400, { error: "missing_job_id", message: "job_id مطلوب." });
  }

  const job = syncJobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { error: "job_not_found", message: "المهمة غير موجودة أو انتهت صلاحيتها." });
  }

  touchJob(job);
  return sendJson(res, 200, {
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    stats: job.payload?.stats || {},
    result: job.status === "completed" ? job.payload : null,
    error: job.error || null
  });
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
      stock: Number.isFinite(stock) ? Math.max(0, stock) : 0
    });
  }

  map.duplicates = duplicates;
  return map;
}

function buildSyncPlan({ supplierMap, sallaRows, zeroMissingSku }) {
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
    let action = "unchanged";

    if (supplier) {
      matched += 1;
      action = "matched";
      targetQuantity = supplier.stock;
      if (supplier.price !== null) {
        targetPrice = supplier.price;
      }
    } else if (zeroMissingSku) {
      action = "zeroed";
      targetQuantity = 0;
      zeroed += 1;
    } else {
      continue;
    }

    const quantityChanged = isDifferentNumber(currentQuantity, targetQuantity);
    const priceChanged = supplier && supplier.price !== null ? isDifferentNumber(currentPrice, targetPrice) : false;

    if (quantityChanged) {
      const identifier = row.sku_id || row.id || null;
      const identifier_type = row.sku_id ? "variant_id" : "id";

      if (identifier) {
        const payloadItem = {
          identifier_type,
          "identifer-type": identifier_type,
          identifer_type: identifier_type,
          identifer: String(identifier),
          identifier: String(identifier),
          quantity: Math.max(0, toInteger(targetQuantity)),
          mode: "overwrite",
          unlimited_quantity: false
        };
        if (SALLA_BRANCH_ID) payloadItem.branch = SALLA_BRANCH_ID;
        if (SALLA_QUANTITY_REASON_ID) {
          const envReason = toFiniteNumber(SALLA_QUANTITY_REASON_ID);
          if (Number.isFinite(envReason)) payloadItem.reason_id = envReason;
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
        current_quantity: Number.isFinite(currentQuantity) ? currentQuantity : "",
        new_quantity: Number.isFinite(targetQuantity) ? Math.max(0, toInteger(targetQuantity)) : "",
        current_price: Number.isFinite(currentPrice) ? round2(currentPrice) : "",
        new_price: Number.isFinite(targetPrice) ? round2(targetPrice) : "",
        action
      });
    }
  }

  const missingSupplierInSalla = [];
  for (const [sku, entry] of supplierMap.entries()) {
    if (seenSallaSkus.has(sku)) continue;
    missingSupplierInSalla.push({
      sku: entry.sku,
      supplier_price: entry.price ?? "",
      supplier_stock: entry.stock ?? ""
    });
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
      missingSupplierInSalla: missingSupplierInSalla.length
    }
  };
}

async function executeSyncPlan(plan, payload, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const quantityResult = await applyQuantityUpdates(plan.quantityUpdates, {
    onStep: (step) => {
      if (onProgress) onProgress({ phase: "quantity", ...step });
    }
  });

  const priceResult = await applyPriceUpdates(plan.priceUpdates, {
    onStep: (step) => {
      if (onProgress) onProgress({ phase: "price", ...step });
    }
  });

  payload.failedPriceUpdates = priceResult.failed;
  payload.failedQuantityUpdates = quantityResult.failed;
  payload.stats.quantityUpdated = quantityResult.success;
  payload.stats.priceUpdated = priceResult.success;
  return payload;
}

function createSyncJob(payload) {
  purgeExpiredJobs();

  const totalQuantity = Number(payload?.stats?.plannedQuantityUpdates || 0);
  const totalPrice = Number(payload?.stats?.plannedPriceUpdates || 0);
  const total = totalQuantity + totalPrice;

  const job = {
    id: randomUUID(),
    status: "running",
    created_at: Date.now(),
    updated_at: Date.now(),
    error: null,
    payload: structuredClone(payload),
    progress: {
      phase: "starting",
      quantity: { total: totalQuantity, done: 0, failed: 0 },
      price: { total: totalPrice, done: 0, failed: 0 },
      total,
      done: 0,
      remaining: total,
      percent: total > 0 ? 0 : 100
    }
  };

  syncJobs.set(job.id, job);
  return job;
}

async function runSyncJob(job, plan) {
  try {
    touchJob(job);
    const finalPayload = await executeSyncPlan(plan, job.payload, {
      onProgress: (event) => applyJobProgressEvent(job, event)
    });
    job.payload = finalPayload;
    job.status = "completed";
    job.progress.phase = "completed";
    touchJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.progress.phase = "failed";
    touchJob(job);
  }
}

function applyJobProgressEvent(job, event) {
  if (!job || !job.progress) return;

  const phase = event?.phase === "price" ? "price" : "quantity";
  const success = Boolean(event?.success);
  if (success) {
    job.progress[phase].done += 1;
  } else {
    job.progress[phase].failed += 1;
  }

  const quantityProcessed = job.progress.quantity.done + job.progress.quantity.failed;
  const priceProcessed = job.progress.price.done + job.progress.price.failed;
  const done = quantityProcessed + priceProcessed;

  job.progress.phase = phase;
  job.progress.done = done;
  job.progress.remaining = Math.max(0, job.progress.total - done);
  job.progress.percent = job.progress.total > 0
    ? Math.min(100, Number(((done / job.progress.total) * 100).toFixed(1)))
    : 100;

  touchJob(job);
}

function touchJob(job) {
  job.updated_at = Date.now();
}

function purgeExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of syncJobs.entries()) {
    if (now - Number(job.updated_at || job.created_at || now) > SYNC_JOB_TTL_MS) {
      syncJobs.delete(jobId);
    }
  }
}

async function applyQuantityUpdates(updates, options = {}) {
  if (!updates.length) return { success: 0, failed: [] };

  const failed = [];
  let success = 0;
  const chunkSize = 100;
  const onStep = typeof options.onStep === "function" ? options.onStep : null;
  const defaultReasonId = await resolveQuantityReasonId();
  const prepared = updates.map((item) => ({
    ...item,
    ...(item.reason_id ? {} : (defaultReasonId ? { reason_id: defaultReasonId } : {}))
  }));

  for (let i = 0; i < prepared.length; i += chunkSize) {
    const chunk = prepared.slice(i, i + chunkSize);
    try {
      await apiFetch("/products/quantities/bulk", {
        method: "POST",
        body: { products: chunk }
      });
      success += chunk.length;
      if (onStep) {
        for (const item of chunk) onStep({ success: true, item });
      }
    } catch (error) {
      for (const item of chunk) {
        try {
          await apiFetch("/products/quantities/bulk", {
            method: "POST",
            body: { products: [item] }
          });
          success += 1;
          if (onStep) onStep({ success: true, item });
        } catch (singleError) {
          failed.push({
            identifier: item.identifer || item.identifier || "",
            identifier_type: item.identifer_type || item.identifier_type || "",
            message: singleError.message
          });
          if (onStep) onStep({ success: false, item, error: singleError.message });
        }
      }
    }
  }

  return { success, failed };
}

async function resolveQuantityReasonId() {
  if (SALLA_QUANTITY_REASON_ID) {
    const envId = toFiniteNumber(SALLA_QUANTITY_REASON_ID);
    return Number.isFinite(envId) ? envId : null;
  }

  if (cachedQuantityReasonId !== undefined) {
    return cachedQuantityReasonId;
  }

  try {
    const data = await apiFetch("/products/quantities/quantity-change-reason");
    const list = Array.isArray(data?.data) ? data.data : [];
    const candidate = list.find((x) => Number.isFinite(toFiniteNumber(x?.id)));
    cachedQuantityReasonId = candidate ? toFiniteNumber(candidate.id) : null;
    return cachedQuantityReasonId;
  } catch {
    cachedQuantityReasonId = null;
    return null;
  }
}

async function applyPriceUpdates(updates, options = {}) {
  const failed = [];
  let success = 0;
  const onStep = typeof options.onStep === "function" ? options.onStep : null;

  for (const update of updates) {
    try {
      await apiFetch(`/products/sku/${encodeURIComponent(update.sku)}/price`, {
        method: "POST",
        body: { price: update.price }
      });
      success += 1;
      if (onStep) onStep({ success: true, item: update });
    } catch (error) {
      failed.push({ sku: update.sku, message: error.message });
      if (onStep) onStep({ success: false, item: update, error: error.message });
    }
  }

  return { success, failed };
}

async function fetchAllProductQuantities() {
  const rows = [];
  const seenKeys = new Set();
  const requestedPerPage = 100;
  const maxPages = 2000;
  let page = 1;
  let lastSignature = "";
  let repeatedSignatureCount = 0;

  while (page <= maxPages) {
    const data = await apiFetch(`/products/quantities?page=${page}&per_page=${requestedPerPage}`);
    const chunk = extractDataArray(data);
    const addedCount = appendUniqueQuantityRows(rows, chunk, seenKeys);
    const pagination = extractPagination(data, page);

    const signature = buildPageSignature(chunk, pagination, page);
    if (signature && signature === lastSignature) {
      repeatedSignatureCount += 1;
    } else {
      repeatedSignatureCount = 0;
      lastSignature = signature;
    }

    if (Number.isFinite(pagination.nextPage) && pagination.nextPage > page) {
      page = pagination.nextPage;
      continue;
    }

    if (pagination.hasNext === true) {
      page += 1;
      continue;
    }

    if (
      Number.isFinite(pagination.totalPages) &&
      Number.isFinite(pagination.currentPage) &&
      pagination.currentPage < pagination.totalPages
    ) {
      page = pagination.currentPage + 1;
      continue;
    }

    if (chunk.length === 0) break;
    if (addedCount === 0) break;

    // Some APIs ignore per_page and return fixed-size pages with no pagination object.
    // Probe next page until we hit empty/repeated data.
    if (!pagination.isExplicit && repeatedSignatureCount < 2) {
      page += 1;
      continue;
    }

    break;
  }

  return rows;
}

function extractDataArray(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
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
  const id = cleanText(row?.id);
  const skuId = cleanText(row?.sku_id);
  const sku = normalizeSku(row?.sku);
  if (skuId) return `sku_id:${skuId}`;
  if (id && sku) return `id_sku:${id}:${sku}`;
  if (id) return `id:${id}`;
  if (sku) return `sku:${sku}`;
  return `raw:${JSON.stringify(row || {})}`;
}

function extractPagination(payload, fallbackPage) {
  const p1 = payload?.pagination || null;
  const p2 = payload?.meta?.pagination || null;
  const p3 = payload?.meta || null;
  const links = payload?.links || null;
  const src = p1 || p2 || p3 || {};

  const currentPage = toFiniteNumber(
    src.current_page ?? src.currentPage ?? src.page ?? src.current ?? fallbackPage
  );
  const totalPages = toFiniteNumber(
    src.total_pages ?? src.totalPages ?? src.last_page ?? src.lastPage
  );
  const nextPage = toFiniteNumber(src.next_page ?? src.nextPage ?? extractPageFromUrl(src.next_page_url));

  let hasNext = null;
  if (typeof src.has_more_pages === "boolean") hasNext = src.has_more_pages;
  else if (typeof src.hasMore === "boolean") hasNext = src.hasMore;
  else if (typeof src.has_next === "boolean") hasNext = src.has_next;
  else if (src.next_page_url) hasNext = true;
  else if (links && (links.next || links.next_page_url)) hasNext = true;
  else if (Number.isFinite(totalPages) && Number.isFinite(currentPage)) hasNext = currentPage < totalPages;

  const explicit =
    hasNext !== null ||
    Number.isFinite(totalPages) ||
    Number.isFinite(nextPage) ||
    Boolean(src.next_page_url) ||
    Boolean(links && (links.next || links.next_page_url));

  return {
    currentPage,
    totalPages,
    nextPage,
    hasNext,
    isExplicit: explicit
  };
}

function extractPageFromUrl(urlValue) {
  const raw = cleanText(urlValue);
  if (!raw) return NaN;
  try {
    const u = new URL(raw);
    return toFiniteNumber(u.searchParams.get("page"));
  } catch {
    const m = raw.match(/[?&]page=(\d+)/i);
    return m ? toFiniteNumber(m[1]) : NaN;
  }
}

function buildPageSignature(chunk, pagination, page) {
  const first = chunk[0] || {};
  const last = chunk[chunk.length - 1] || {};
  const firstKey = buildQuantityRowKey(first);
  const lastKey = buildQuantityRowKey(last);
  return `${page}|${pagination.currentPage || ""}|${chunk.length}|${firstKey}|${lastKey}`;
}

async function apiFetch(pathname, options = {}, retry = true) {
  await ensureAccessToken();

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${session.access_token}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${SALLA_API_BASE}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 401 && retry) {
    const refreshed = await refreshToken();
    if (refreshed) {
      return apiFetch(pathname, options, false);
    }
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Salla API ${response.status}: ${errText}`);
  }

  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function ensureAccessToken() {
  if (!session.access_token) {
    throw new Error("Salla token not found. Authenticate first.");
  }

  const exp = Number(session.expires_at || 0);
  if (exp && Date.now() + 60_000 > exp) {
    const refreshed = await refreshToken();
    if (!refreshed) {
      throw new Error("Failed to refresh access token.");
    }
  }
}

async function exchangeCode(code) {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", SALLA_CLIENT_ID);
  form.set("client_secret", SALLA_CLIENT_SECRET);
  form.set("redirect_uri", SALLA_REDIRECT_URI);
  form.set("code", code);

  const response = await fetch(`${SALLA_ACCOUNTS_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth exchange failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function refreshToken() {
  if (!session.refresh_token) return false;

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", SALLA_CLIENT_ID);
  form.set("client_secret", SALLA_CLIENT_SECRET);
  form.set("refresh_token", session.refresh_token);

  const response = await fetch(`${SALLA_ACCOUNTS_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString()
  });

  if (!response.ok) {
    return false;
  }

  const tokenData = await response.json();
  session = {
    ...session,
    ...normalizeTokenData(tokenData)
  };
  await persistSession();
  return true;
}

function normalizeTokenData(tokenData) {
  const expiresIn = Number(tokenData.expires_in || 3600);
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || session.refresh_token || "",
    token_type: tokenData.token_type || "Bearer",
    scope: tokenData.scope || "",
    expires_in: expiresIn,
    expires_at: Date.now() + expiresIn * 1000
  };
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Payload too large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

async function loadSession() {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    const raw = await readFile(SESSION_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function persistSession() {
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

async function removeSessionFile() {
  if (existsSync(SESSION_FILE)) {
    await unlink(SESSION_FILE);
  }
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function normalizeSku(v) {
  return cleanText(v).toLowerCase().replace(/\s+/g, "");
}

function cleanText(v) {
  return String(v ?? "").trim();
}

function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).replace(/,/g, "").trim();
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

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
