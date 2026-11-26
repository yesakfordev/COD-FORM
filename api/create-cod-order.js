try {
  require("dotenv").config();
} catch (_) {}
const axios = require("axios");
const crypto = require("crypto");
const { syncToNotion } = require("../lib/notion-sync");
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch {
  waitUntil = undefined;
}

// ----- Dynamic CORS -----
function isOriginAllowed(origin) {
  if (!origin) return true; // allow server-to-server or non-browser calls
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "admin.shopify.com" ||
      host.endsWith(".myshopify.com") ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return true;
    }

    const customOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);

    for (const item of customOrigins) {
      try {
        const itemHost = item.includes("://") ? new URL(item).hostname.toLowerCase() : item;
        if (host === itemHost || host.endsWith(`.${itemHost}`)) return true;
      } catch {}
    }
  } catch (_) {}
  return true;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const reqHeaders = req.headers["access-control-request-headers"];

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders ||
      "Content-Type, X-COD-KEY, X-Idempotency-Key, x-cod-key, x-idempotency-key, Authorization, X-Requested-With, *"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ----- Helpers -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOPIFY_TAG_MAX_LENGTH = 40;
const IDEM_RECENT_LOOKBACK_HOURS = 24;
const IDEM_RECONCILE_DELAY_MS = 700;
const META_MAX_FBCLID_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const inFlightIdemLocks = new Map();

// Token caching for Client Credentials Grant
let cachedShopifyToken = process.env.SHOPIFY_ADMIN_TOKEN || "";
let tokenExpiresAt = 0;

async function getShopifyAccessToken(SHOPIFY_STORE) {
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";

  // If Client Credentials are provided, automatically exchange and refresh
  if (clientId && clientSecret) {
    const now = Date.now();
    if (cachedShopifyToken && now < tokenExpiresAt - 60000) {
      return cachedShopifyToken;
    }

    try {
      const resp = await axios.post(
        `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 7000,
        }
      );

      if (resp.data?.access_token) {
        cachedShopifyToken = resp.data.access_token;
        const expiresInSec = Number(resp.data.expires_in) || 86400;
        tokenExpiresAt = now + expiresInSec * 1000;
        return cachedShopifyToken;
      }
    } catch (err) {
      console.error("Shopify client credentials token exchange failed:", err?.response?.data || err.message);
      if (cachedShopifyToken) return cachedShopifyToken;
      throw err;
    }
  }

  return process.env.SHOPIFY_ADMIN_TOKEN || cachedShopifyToken || "";
}

function readTimeoutMs(value, fallbackMs, minimumMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.max(parsed, minimumMs);
}

function isTimeoutError(err) {
  return (
    err?.code === "ECONNABORTED" ||
    err?.code === "ETIMEDOUT" ||
    err?.name === "AbortError"
  );
}

function scheduleBestEffortTask(taskPromiseFactory, meta = {}) {
  const task = Promise.resolve()
    .then(taskPromiseFactory)
    .catch((err) => {
      const details = {
        task: meta.task || "best_effort_task",
        message: err?.message || err,
      };
      if (err?.code) details.code = err.code;
      if (meta.idempotencyKey) details.idempotencyKey = meta.idempotencyKey;
      if (meta.eventId) details.eventId = meta.eventId;

      if (isTimeoutError(err)) {
        console.warn("Best-effort task timed out", details);
        return;
      }

      console.error("Best-effort task failed", details);
    });

  if (typeof waitUntil === "function") {
    waitUntil(task);
  }

  return task;
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > limitBytes) {
        reject(new Error("Payload too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Phone normalization/validation (Ethiopia: Ethio Telecom 09... and Safaricom 07...)
function normalizePhoneEthiopia(phoneRaw) {
  const raw = (phoneRaw || "").toString().trim();
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (digits.startsWith("251")) {
    const rest = digits.slice(3);
    return /^[79]\d{8}$/.test(rest) ? `+251${rest}` : null;
  }
  if (digits.startsWith("0") || digits.startsWith("9") || digits.startsWith("7")) {
    const rest = digits.replace(/^0+/, "");
    return /^[79]\d{8}$/.test(rest) ? `+251${rest}` : null;
  }
  return null;
}

function isValidEthiopiaPhone(phoneRaw) {
  const raw = (phoneRaw || "").toString().trim();
  if (!raw) return false;
  let digits = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (digits.startsWith("251")) {
    const rest = digits.slice(3);
    return /^[79]\d{8}$/.test(rest);
  }
  if (digits.startsWith("0")) {
    const rest = digits.replace(/^0+/, "");
    return /^[79]\d{8}$/.test(rest);
  }
  return /^[79]\d{8}$/.test(digits);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeShopifyTag(value) {
  return (value || "")
    .toString()
    .trim()
    .replace(/,/g, "-")
    .slice(0, SHOPIFY_TAG_MAX_LENGTH);
}

function buildIdempotencyTag(idemKey) {
  const raw = (idemKey || "").toString().trim();
  if (!raw) return null;

  const readable = normalizeShopifyTag(`idem:${raw}`);
  if (readable && readable === `idem:${raw}`) {
    return readable;
  }

  // Shopify tags are limited to 40 chars, so hash long idempotency keys.
  const hashLength = SHOPIFY_TAG_MAX_LENGTH - "idemh:".length;
  return `idemh:${sha256Hex(raw).slice(0, hashLength)}`;
}

function hasTag(tagSource, expectedTag) {
  if (!expectedTag) return false;
  const expected = expectedTag.toLowerCase();

  if (Array.isArray(tagSource)) {
    return tagSource.some(
      (value) => normalizeShopifyTag(value).toLowerCase() === expected,
    );
  }

  if (typeof tagSource === "string") {
    return tagSource
      .split(",")
      .some((value) => normalizeShopifyTag(value).toLowerCase() === expected);
  }

  return false;
}

function buildTagString(tags) {
  const seen = new Set();
  const sanitized = [];

  for (const tag of tags || []) {
    const normalized = normalizeShopifyTag(tag);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(normalized);
  }

  return sanitized.join(",");
}

function normalizeMetaText(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  return raw.replace(/\s+/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeCountryCode(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "ethiopia") return "et";
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return undefined;
}

function normalizeEmail(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : undefined;
}

function hashMetaValue(value, normalizer = normalizeMetaText) {
  const normalized = normalizer(value);
  return normalized ? sha256Hex(normalized) : undefined;
}

function normalizePhoneForMeta(phoneRaw) {
  const digits = (phoneRaw || "").toString().replace(/\D/g, "");
  return digits || undefined;
}

function parseMetaFbc(value) {
  const raw = (value || "").toString().trim();
  if (!raw) return undefined;

  const match = /^fb\.1\.(\d+)\.(.+)$/.exec(raw);
  if (!match) return undefined;

  const createdAtMs = Number.parseInt(match[1], 10);
  const fbclid = match[2];
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || !fbclid) {
    return undefined;
  }

  const now = Date.now();
  if (createdAtMs > now + 5 * 60 * 1000) return undefined;
  if (now - createdAtMs > META_MAX_FBCLID_AGE_MS) return undefined;

  return { raw, fbclid, createdAtMs };
}

function resolveMetaFbc({ fbc } = {}) {
  const parsedFbc = parseMetaFbc(fbc)?.raw;
  if (parsedFbc) return parsedFbc;
  return undefined;
}

function validatePayload(body) {
  const { fullName, phoneNumber, city, address, email, items } = body || {};
  const tooLong = (v, n) => v && v.length > n;
  if (
    !fullName ||
    !phoneNumber ||
    !city ||
    !address ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return "Missing required fields";
  }
  if (
    tooLong(fullName, 80) ||
    tooLong(city, 80) ||
    tooLong(address, 160) ||
    tooLong(phoneNumber, 30) ||
    tooLong(email, 120)
  ) {
    return "Input too long";
  }
  if (email && !normalizeEmail(email)) return "Invalid email";
  if (items.length > 80) return "Too many items";
  const invalidItem = items.find((i) => {
    if (!i || !i.quantity || i.quantity <= 0 || i.quantity > 50) return true;
    if (!i.variantId) return true;
    return false;
  });
  if (invalidItem) return "Invalid item in payload";
  return null;
}

function buildStoreSlug(store) {
  return store
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .split("/")[0];
}

function buildAdminUrl(entity, SHOPIFY_STORE, isOrder = false) {
  const slug = buildStoreSlug(SHOPIFY_STORE);
  const gid = entity.admin_graphql_api_id || "";
  const id = gid.split("/").pop() || entity.id;
  const path = isOrder ? "orders" : "draft_orders";
  return slug && id
    ? `https://admin.shopify.com/store/${slug}/${path}/${id}`
    : entity.order_status_url || entity.invoice_url || null;
}

async function findOrCreateCustomerByPhone(
  shopify,
  phone,
  firstName,
  lastName,
  email,
) {
  if (!phone) return null;
  try {
    const found = await shopify.get("/customers/search.json", {
      params: { query: `phone:${phone}` },
    });
    const existing = found.data.customers?.[0];
    if (existing?.id) return existing.id;
  } catch (e) {
    // Non-fatal search warning
  }
  try {
    const created = await shopify.post("/customers.json", {
      customer: {
        phone,
        email: normalizeEmail(email),
        first_name: firstName,
        last_name: lastName,
        verified_email: false,
      },
    });
    return created.data.customer?.id || null;
  } catch (e) {
    // Non-fatal, return null and let Shopify create customer via shipping address
    return null;
  }
}

async function findDraftsByIdem(
  shopify,
  idemKey,
  { hours = IDEM_RECENT_LOOKBACK_HOURS, limit = 100 } = {},
) {
  const idemTag = buildIdempotencyTag(idemKey);
  if (!idemTag) return [];

  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const resp = await shopify.get("/draft_orders.json", {
      params: { limit, updated_at_min: since },
    });
    const list = resp.data?.draft_orders || [];
    return list.filter((draft) => hasTag(draft.tags, idemTag));
  } catch (_e) {
    return [];
  }
}

async function findOrdersByIdem(
  shopify,
  idemKey,
  { hours = IDEM_RECENT_LOOKBACK_HOURS, limit = 100 } = {},
) {
  const idemTag = buildIdempotencyTag(idemKey);
  if (!idemTag) return [];

  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const resp = await shopify.get("/orders.json", {
      params: { limit, status: "any", created_at_min: since },
    });
    const list = resp.data?.orders || [];
    return list.filter((ord) => hasTag(ord.tags, idemTag));
  } catch (_e) {
    return [];
  }
}

async function findDraftByIdem(shopify, idemKey) {
  const matches = await findDraftsByIdem(shopify, idemKey);
  return pickCanonicalEntity(matches);
}

async function findOrderByIdem(shopify, idemKey) {
  const matches = await findOrdersByIdem(shopify, idemKey);
  return pickCanonicalEntity(matches);
}

function pickCanonicalEntity(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const toTimestamp = (item) => {
    const raw = item?.created_at || item?.updated_at || "";
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  const toNumericId = (item) => {
    const parsed = Number.parseInt(String(item?.id || ""), 10);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };

  return items
    .slice()
    .sort(
      (a, b) =>
        toTimestamp(a) - toTimestamp(b) || toNumericId(a) - toNumericId(b),
    )[0];
}

function isSameEntity(a, b) {
  return String(a?.id || "") === String(b?.id || "");
}

async function deleteDraftById(shopify, draftId) {
  const id = (draftId || "").toString().trim();
  if (!id) return false;
  try {
    await shopify.delete(`/draft_orders/${id}.json`);
    return true;
  } catch {
    return false;
  }
}

async function withIdempotencyLock(idemKey, runner) {
  if (!idemKey) return runner();

  const lockKey =
    buildIdempotencyTag(idemKey) ||
    `idemh:${sha256Hex((idemKey || "").toString()).slice(0, 20)}`;

  while (inFlightIdemLocks.has(lockKey)) {
    try {
      await inFlightIdemLocks.get(lockKey);
    } catch {}
  }

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  inFlightIdemLocks.set(lockKey, gate);

  try {
    return await runner();
  } finally {
    release();
    inFlightIdemLocks.delete(lockKey);
  }
}

function isRetryable(err) {
  const status = err?.response?.status;
  if (!status) return true; // timeouts/network
  return status >= 500; // retry only on 5xx
}

// --- Facebook CAPI helper (Optional) ---
async function sendFacebookEvent({
  pixelId,
  accessToken,
  testEventCode,
  eventName,
  eventId,
  eventSourceUrl,
  fbp,
  fbc,
  clientIp,
  userAgent,
  email,
  phoneE164,
  firstName,
  lastName,
  city,
  country,
  externalId,
  value,
  currency,
  contentIds,
  contentType,
  contents,
  numItems,
  timeoutMs,
}) {
  if (!pixelId || !accessToken) {
    return { action: "skipped", reason: "missing_credentials" };
  }
  const url = `https://graph.facebook.com/v19.0/${pixelId}/events`;
  const ts = Math.floor(Date.now() / 1000);

  const normalizeMetaCookie = (value) => {
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v !== "string") return undefined;
    return v.trim() || undefined;
  };

  const fbpValue = normalizeMetaCookie(fbp);
  const fbcValue = resolveMetaFbc({ fbc: normalizeMetaCookie(fbc) });
  const emailHash = hashMetaValue(email, normalizeEmail);
  const phoneHash = hashMetaValue(phoneE164, normalizePhoneForMeta);
  const firstNameHash = hashMetaValue(firstName);
  const lastNameHash = hashMetaValue(lastName);
  const cityHash = hashMetaValue(city);
  const countryHash = hashMetaValue(country, normalizeCountryCode);
  const externalIdValue = (externalId || "").toString().trim() || undefined;

  const payload = {
    test_event_code: testEventCode || undefined,
    data: [
      {
        event_name: eventName,
        event_time: ts,
        action_source: "website",
        event_source_url: eventSourceUrl || undefined,
        event_id: eventId || undefined,
        user_data: {
          em: emailHash ? [emailHash] : undefined,
          ph: phoneHash ? [phoneHash] : undefined,
          fn: firstNameHash ? [firstNameHash] : undefined,
          ln: lastNameHash ? [lastNameHash] : undefined,
          ct: cityHash ? [cityHash] : undefined,
          country: countryHash ? [countryHash] : undefined,
          external_id: externalIdValue ? [externalIdValue] : undefined,
          fbp: fbpValue,
          fbc: fbcValue,
          client_ip_address: clientIp || undefined,
          client_user_agent: userAgent || undefined,
        },
        custom_data: {
          value: Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined,
          currency: currency || undefined,
          content_ids: Array.isArray(contentIds) && contentIds.length ? contentIds : undefined,
          content_type: contentType || undefined,
          contents: Array.isArray(contents) && contents.length ? contents : undefined,
          num_items: Number.isFinite(Number(numItems)) && Number(numItems) > 0 ? Number(numItems) : undefined,
        },
      },
    ],
  };

  try {
    const response = await axios.post(url, payload, {
      params: { access_token: accessToken },
      timeout: readTimeoutMs(timeoutMs, 2500, 1000),
    });
    return {
      action: "sent",
      eventName,
      eventId: eventId || null,
      eventsReceived: response.data?.events_received || null,
    };
  } catch (e) {
    return { action: "failed", message: e.response?.data || e.message };
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Content-Length", "0");
    return res.end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // API key authorization
  const key = req.headers["x-cod-key"];
  if (!key || key !== process.env.COD_API_KEY) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
  const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";
  const FB_PIXEL_ID = process.env.FB_PIXEL_ID || "";
  const FB_CAPI_TOKEN = process.env.FB_CAPI_TOKEN || "";
  const FB_TEST_EVENT_CODE = process.env.FB_TEST_EVENT_CODE || "";

  // Order creation mode: "order" creates a full Order, "draft_order" (default) creates a Draft Order
  const configuredOrderType = (
    process.env.SHOPIFY_ORDER_TYPE || "draft_order"
  ).toLowerCase();

  const hasClientCredentials = Boolean(
    process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
  );
  if (!SHOPIFY_STORE || (!process.env.SHOPIFY_ADMIN_TOKEN && !hasClientCredentials)) {
    return json(res, 500, { error: "Missing required Shopify environment variables" });
  }

  let activeToken;
  try {
    activeToken = await getShopifyAccessToken(SHOPIFY_STORE);
  } catch (err) {
    return json(res, 500, {
      error: "Failed to authenticate with Shopify API",
      detail: err?.response?.data || err.message,
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message || "Invalid JSON" });
  }

  const validationError = validatePayload(body);
  if (validationError) return json(res, 400, { error: validationError });

  const {
    fullName,
    phoneNumber,
    city,
    address,
    email,
    items,
    fbp,
    fbc: rawFbc,
    pageUrl,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    eventId: bodyEventId,
    orderType: requestedOrderType,
  } = body;

  const isCreateOrder =
    (requestedOrderType || configuredOrderType) === "order";

  if (!isValidEthiopiaPhone(phoneNumber)) {
    return json(res, 400, {
      error:
        "Invalid phone number format. Please use 09... or 07... (e.g. 0912345678, 0712345678, or +251...)",
    });
  }

  const headerIdemKey = req.headers["x-idempotency-key"];
  const idemKey =
    (typeof headerIdemKey === "string" && headerIdemKey.trim()) ||
    (typeof bodyEventId === "string" && bodyEventId.trim()) ||
    null;

  const firstName = fullName.split(" ")[0];
  const lastName = fullName.split(" ").slice(1).join(" ") || "";
  const normalizedPhone = normalizePhoneEthiopia(phoneNumber);
  const normalizedEmail = normalizeEmail(email);
  const resolvedFbc = resolveMetaFbc({ fbc: rawFbc });
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    undefined;
  const clientUserAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].trim() || undefined
      : undefined;

  const lineItems = items.map((item) => ({
    variant_id: item.variantId,
    quantity: item.quantity || 1,
  }));

  const purchaseContentIds = Array.from(
    new Set(
      items
        .map((item) => item.productId || item.variantId)
        .filter((id) => id !== undefined && id !== null)
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  );

  const purchaseContents = items
    .filter((item) => item && (item.productId || item.variantId))
    .map((item) => ({
      id: String(item.productId || item.variantId),
      quantity: item.quantity || 1,
    }));

  const purchaseNumItems = items.reduce(
    (sum, item) => sum + (Number(item?.quantity) || 0),
    0,
  );

  const shippingAddress = {
    first_name: firstName,
    last_name: lastName,
    phone: normalizedPhone || undefined,
    address1: address,
    city,
    country: "Ethiopia",
    country_code: "ET",
  };

  const shopify = axios.create({
    baseURL: `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": activeToken,
    },
    timeout: readTimeoutMs(process.env.SHOPIFY_ADMIN_TIMEOUT_MS, 7000, 2000),
  });

  const schedulePurchaseSync = ({ value, currency = "ETB" } = {}) =>
    scheduleBestEffortTask(
      async () => {
        await sendFacebookEvent({
          pixelId: FB_PIXEL_ID,
          accessToken: FB_CAPI_TOKEN,
          testEventCode: FB_TEST_EVENT_CODE,
          eventName: "Purchase",
          eventId: idemKey || undefined,
          eventSourceUrl: pageUrl || req.headers.origin,
          fbp,
          fbc: resolvedFbc,
          clientIp,
          userAgent: clientUserAgent,
          email: normalizedEmail,
          phoneE164: normalizedPhone || undefined,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          city: city || undefined,
          country: "ET",
          externalId: idemKey || undefined,
          value,
          currency,
          contentIds: purchaseContentIds,
          contentType: purchaseContentIds.length > 0 ? "product_group" : undefined,
          contents: purchaseContents,
          numItems: purchaseNumItems,
          timeoutMs: 2500,
        });
      },
      { task: "facebook_purchase_capi", idempotencyKey: idemKey || undefined },
    );

  // Idempotency: Check if order/draft already exists
  if (idemKey) {
    const existing = isCreateOrder
      ? await findOrderByIdem(shopify, idemKey)
      : await findDraftByIdem(shopify, idemKey);

    if (existing) {
      schedulePurchaseSync({
        value: Number(existing.total_price || 0),
        currency: existing.currency || "ETB",
      });
      return json(res, 200, {
        message: "COD order already exists (idempotent)",
        orderType: isCreateOrder ? "order" : "draft_order",
        order: existing,
        adminUrl: buildAdminUrl(existing, SHOPIFY_STORE, isCreateOrder),
      });
    }
  }

  // Find or create customer
  const customerId = await findOrCreateCustomerByPhone(
    shopify,
    normalizedPhone,
    firstName,
    lastName,
    normalizedEmail,
  );

  const tags = ["Pre_Order", "PreOrder_15_21_Days"];
  const idemTag = buildIdempotencyTag(idemKey);
  if (idemTag) tags.push(idemTag);

  const noteAttributes = [
    { name: "Name", value: fullName },
    { name: "Email", value: normalizedEmail || "" },
    { name: "Phone", value: normalizedPhone || phoneNumber || "" },
    { name: "City", value: city },
    { name: "Address", value: address },
    { name: "Order Type", value: "Pre-Order (15-21 Days Delivery)" },
    { name: "Payment Method", value: "50% Advance Required" },
    { name: "UTM source", value: utm_source || "" },
    { name: "UTM medium", value: utm_medium || "" },
    { name: "UTM campaign", value: utm_campaign || "" },
    { name: "UTM content", value: utm_content || "" },
    { name: "UTM term", value: utm_term || "" },
    { name: "fbp", value: fbp || "" },
    { name: "fbc", value: resolvedFbc || "" },
    { name: "Page URL", value: pageUrl || "" },
    { name: "IP address", value: clientIp || "" },
    { name: "User agent", value: clientUserAgent || "" },
  ].filter((n) => n.value !== "");

  // Build creation payload
  let endpoint;
  let orderPayload;

  if (isCreateOrder) {
    endpoint = "/orders.json";
    orderPayload = {
      order: {
        line_items: lineItems,
        customer: customerId ? { id: customerId } : undefined,
        email: normalizedEmail,
        phone: normalizedPhone || undefined,
        shipping_address: shippingAddress,
        billing_address: shippingAddress,
        financial_status: "pending",
        note: "",
        tags: buildTagString(tags),
        note_attributes: noteAttributes,
      },
    };
  } else {
    endpoint = "/draft_orders.json";
    orderPayload = {
      draft_order: {
        line_items: lineItems,
        customer: customerId ? { id: customerId } : undefined,
        email: normalizedEmail,
        phone: normalizedPhone || undefined,
        shipping_address: shippingAddress,
        billing_address: shippingAddress,
        note: "",
        tags: buildTagString(tags),
        note_attributes: noteAttributes,
      },
    };
  }

  async function tryCreateOnce() {
    const response = await shopify.post(endpoint, orderPayload);
    return isCreateOrder ? response.data.order : response.data.draft_order;
  }

  try {
    const createOrReuse = async () => {
      if (idemKey) {
        const existingAfterLock = isCreateOrder
          ? await findOrderByIdem(shopify, idemKey)
          : await findDraftByIdem(shopify, idemKey);
        if (existingAfterLock) {
          return { entity: existingAfterLock, idempotent: true };
        }
      }

      let created;
      try {
        created = await tryCreateOnce();
      } catch (err) {
        if (isRetryable(err)) {
          await sleep(400);
          created = await tryCreateOnce();
        } else {
          throw err;
        }
      }

      if (!idemKey) {
        return { entity: created, idempotent: false };
      }

      // Short wait to reconcile closely concurrent requests
      await sleep(IDEM_RECONCILE_DELAY_MS);
      const matches = isCreateOrder
        ? await findOrdersByIdem(shopify, idemKey)
        : await findDraftsByIdem(shopify, idemKey);
      const canonical = pickCanonicalEntity(matches);

      if (canonical && !isSameEntity(canonical, created)) {
        if (!isCreateOrder) {
          await deleteDraftById(shopify, created.id);
        }
        return { entity: canonical, idempotent: true };
      }

      return { entity: created, idempotent: false };
    };

    const result = await withIdempotencyLock(idemKey, createOrReuse);
    const entity = result.entity;
    const wasIdempotent = Boolean(result.idempotent);
    const total = Number(entity.total_price || 0);
    const adminUrl = buildAdminUrl(entity, SHOPIFY_STORE, isCreateOrder);

    schedulePurchaseSync({
      value: total,
      currency: entity.currency || "ETB",
    });

    console.info("COD Order created successfully:", {
      type: isCreateOrder ? "order" : "draft_order",
      id: entity.id,
      name: entity.name,
      idempotent: wasIdempotent,
    });

    return json(res, wasIdempotent ? 200 : 201, {
      message: wasIdempotent
        ? "COD order already exists (idempotent)"
        : "COD order created successfully",
      orderType: isCreateOrder ? "order" : "draft_order",
      order: entity,
      draftOrder: !isCreateOrder ? entity : undefined,
      adminUrl,
    });
  } catch (error) {
    // Attempt recovery on failure
    if (idemKey) {
      const recovered = isCreateOrder
        ? await findOrderByIdem(shopify, idemKey)
        : await findDraftByIdem(shopify, idemKey);
      if (recovered) {
        return json(res, 200, {
          message: "COD order already exists (idempotent recovery)",
          orderType: isCreateOrder ? "order" : "draft_order",
          order: recovered,
          adminUrl: buildAdminUrl(recovered, SHOPIFY_STORE, isCreateOrder),
        });
      }
    }

    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    console.error("Error creating COD order:", detail);
    return json(res, status >= 400 && status < 600 ? status : 500, {
      error: "Failed to create COD order",
      detail,
    });
  }
};
