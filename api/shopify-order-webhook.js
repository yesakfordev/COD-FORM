try {
  require("dotenv").config();
} catch (_) {}
const crypto = require("crypto");
const { Client } = require("@notionhq/client");
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch {
  waitUntil = undefined;
}

const allowedTopics = new Set(["orders/create", "draft_orders/create"]);
const notionSchemaCache = new Map();

function readTimeoutMs(value, fallbackMs, minimumMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.max(parsed, minimumMs);
}

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

function readRawBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildStoreSlug(store) {
  return store
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .split("/")[0];
}

function buildAdminUrl(entity, store) {
  const slug = buildStoreSlug(store);
  const gid = entity.admin_graphql_api_id || "";
  const fromGid = gid.split("/").pop();
  const id = fromGid || entity.id;
  if (!slug || !id) {
    return entity.order_status_url || entity.invoice_url || null;
  }
  const isActualOrder = gid.includes("/Order/") || Boolean(entity.order_number);
  const path = isActualOrder ? "orders" : "draft_orders";
  return `https://admin.shopify.com/store/${slug}/${path}/${id}`;
}

function extractPhone(payload) {
  return (
    payload.phone ||
    payload.shipping_address?.phone ||
    payload.billing_address?.phone ||
    payload.customer?.phone ||
    payload.customer?.default_address?.phone ||
    ""
  );
}

function extractName(payload) {
  const first =
    payload.shipping_address?.first_name ||
    payload.billing_address?.first_name ||
    payload.customer?.first_name ||
    payload.customer?.default_address?.first_name ||
    "";
  const last =
    payload.shipping_address?.last_name ||
    payload.billing_address?.last_name ||
    payload.customer?.last_name ||
    payload.customer?.default_address?.last_name ||
    "";
  const joined = `${first} ${last}`.trim();
  return joined || payload.customer?.default_address?.name || "Customer";
}

function extractCity(payload) {
  return (
    payload.shipping_address?.city ||
    payload.billing_address?.city ||
    payload.customer?.default_address?.city ||
    ""
  );
}

function extractAddress(payload) {
  return (
    payload.shipping_address?.address1 ||
    payload.billing_address?.address1 ||
    payload.customer?.default_address?.address1 ||
    ""
  );
}

function parseIdempotencyTag(tags) {
  if (!tags) return undefined;
  const list = Array.isArray(tags) ? tags : String(tags).split(",");
  for (const raw of list) {
    const value = (raw || "").toString().trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (lower.startsWith("idem:") || lower.startsWith("idemh:")) {
      return value;
    }
  }
  return undefined;
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function scheduleBestEffortTask(taskPromiseFactory, meta = {}) {
  const task = Promise.resolve()
    .then(taskPromiseFactory)
    .catch((err) => {
      console.error("Best-effort task failed", {
        task: meta.task || "best_effort_task",
        topic: meta.topic,
        entityId: meta.entityId,
        message: err?.response?.data || err?.message || err,
      });
    });

  if (typeof waitUntil === "function") {
    waitUntil(task);
  }

  return task;
}

/**
 * Retrieves schema properties and target type (database or data_source)
 */
async function resolveNotionSchema(notion, targetId) {
  const id = (targetId || "").toString().trim();
  if (!id) return { type: null, schema: {} };

  if (notionSchemaCache.has(id)) {
    return notionSchemaCache.get(id);
  }

  // 1. Try standard Notion database
  try {
    const database = await notion.databases.retrieve({ database_id: id });
    if (database && database.properties) {
      const res = { type: "database", id, schema: database.properties };
      notionSchemaCache.set(id, res);
      return res;
    }
  } catch {}

  // 2. Try Notion data_source (SDK v5+)
  if (notion.dataSources && typeof notion.dataSources.retrieve === "function") {
    try {
      const source = await notion.dataSources.retrieve({ data_source_id: id });
      if (source && source.properties) {
        const res = { type: "data_source", id: source.id || id, schema: source.properties };
        notionSchemaCache.set(id, res);
        return res;
      }
    } catch {}
  }

  return { type: "database", id, schema: {} };
}

/**
 * Checks if page already exists in Notion by title or idempotency key
 */
async function notionPageExists(notion, target, titlePropName, titleValue, idempotencyKey) {
  if (!titleValue && !idempotencyKey) return false;

  const filters = [];
  if (titleValue && titlePropName && target.schema?.[titlePropName]?.type === "title") {
    filters.push({
      property: titlePropName,
      title: { equals: titleValue },
    });
  }
  if (idempotencyKey && target.schema?.["Idempotency Key"]?.type === "rich_text") {
    filters.push({
      property: "Idempotency Key",
      rich_text: { equals: idempotencyKey },
    });
  }
  if (!filters.length) return false;

  const filter = filters.length === 1 ? filters[0] : { or: filters };

  try {
    if (target.type === "data_source" && notion.dataSources?.query) {
      const result = await notion.dataSources.query({
        data_source_id: target.id,
        filter,
        page_size: 1,
      });
      return (result.results || []).length > 0;
    }

    const result = await notion.databases.query({
      database_id: target.id,
      filter,
      page_size: 1,
    });
    return (result.results || []).length > 0;
  } catch (err) {
    console.error("Notion duplicate check warning:", err?.message || err);
    return false;
  }
}

module.exports = async function handler(req, res) {
  // Warm-up ping
  if (req.method === "GET") {
    return json(res, 200, { status: "Shopify COD Webhook endpoint is live" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
  const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || ""; // Draft Orders database
  const NOTION_DELIVERY_DATABASE_ID =
    process.env.NOTION_DELIVERY_DATABASE_ID || NOTION_DATABASE_ID; // Orders database (falls back to drafts db if only 1 db used)
  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
  const NOTION_SYNC_TIMEOUT_MS = readTimeoutMs(process.env.NOTION_SYNC_TIMEOUT_MS, 8000, 5000);

  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.error("Missing SHOPIFY_WEBHOOK_SECRET in environment variables");
    return json(res, 500, { error: "Missing required webhook secret" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message || "Unable to read body" });
  }

  // Verify HMAC signature
  const hmacHeader = req.headers["x-shopify-hmac-sha256"] || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
  const hmacBuffer = Buffer.from(hmacHeader, "utf8");
  const digestBuffer = Buffer.from(digest, "utf8");
  const validHmac =
    hmacBuffer.length === digestBuffer.length &&
    crypto.timingSafeEqual(hmacBuffer, digestBuffer);

  if (!validHmac) {
    console.warn("Invalid webhook signature from:", req.headers["x-forwarded-for"] || req.socket?.remoteAddress);
    return json(res, 401, { error: "Invalid webhook signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return json(res, 400, { error: "Invalid JSON" });
  }

  const topic = (req.headers["x-shopify-topic"] || "").toLowerCase();
  if (!allowedTopics.has(topic)) {
    return json(res, 200, { skipped: `Unhandled topic: ${topic}` });
  }

  const isOrder = topic === "orders/create";
  const entity = payload.draft_order || payload.order || payload;
  const entityId = entity?.id;
  const entityName = (
    entity?.name ||
    (isOrder ? `Order #${entity?.order_number || entityId}` : `Draft #${entityId}`)
  ).toString().trim();

  const idemTag = parseIdempotencyTag(entity?.tags || payload?.tags);
  const shopifyEventId = (req.headers["x-shopify-event-id"] || "").toString().trim();
  const idempotencyKey =
    shopifyEventId ||
    idemTag ||
    `${topic.replace("/", "-")}-${entityId || entityName}`;

  const parentDb = isOrder ? NOTION_DELIVERY_DATABASE_ID : NOTION_DATABASE_ID;

  console.info("Processing Shopify Webhook:", {
    topic,
    entityType: isOrder ? "Order" : "Draft Order",
    entityId,
    entityName,
    idempotencyKey,
  });

  const total = Number(entity.total_price || entity.subtotal_price || 0);
  const halfPayment = Number((total / 2).toFixed(2));
  const adminUrl = buildAdminUrl(entity, SHOPIFY_STORE);
  const phone = extractPhone(entity);
  const customerName = extractName(entity);
  const city = extractCity(entity);
  const address = extractAddress(entity);
  const icon = { type: "emoji", emoji: isOrder ? "📦" : "🛒" };

  // Prepare line items summary (e.g. "Product A x 2, Product B x 1")
  const itemsSummary = Array.isArray(entity.line_items)
    ? entity.line_items
        .map((i) => `${i.title || i.name || "Item"} x ${i.quantity || 1}`)
        .join(", ")
        .slice(0, 2000)
    : "";

  if (NOTION_TOKEN && parentDb) {
    scheduleBestEffortTask(
      async () => {
        const notion = new Client({
          auth: NOTION_TOKEN,
          timeoutMs: NOTION_SYNC_TIMEOUT_MS,
        });

        await withTimeout(
          (async () => {
            const target = await resolveNotionSchema(notion, parentDb);
            const schema = target.schema || {};

            // Dynamically detect which property in the Notion database is the 'title' property
            const titlePropName =
              Object.keys(schema).find((k) => schema[k]?.type === "title") ||
              (isOrder ? "Order Name" : "Draft Number");

            // Deduplication check
            const exists = await notionPageExists(
              notion,
              target,
              titlePropName,
              entityName,
              idempotencyKey,
            );

            if (exists) {
              console.info("Notion sync skipped (already exists):", {
                entityName,
                idempotencyKey,
              });
              return;
            }

            // Build potential Notion properties
            const candidateProperties = {
              [titlePropName]: { title: [{ text: { content: entityName } }] },
              "Customer Name": { rich_text: [{ text: { content: customerName } }] },
              "Recipient Name": { rich_text: [{ text: { content: customerName } }] },
              Name: { rich_text: [{ text: { content: customerName } }] },
              Phone: { phone_number: phone || null },
              "Phone Number": { phone_number: phone || null },
              Total: { number: total },
              "Total Price": { number: total },
              "Half Payment": { number: halfPayment },
              URL: { url: adminUrl || null },
              "Shopify URL": { url: adminUrl || null },
              City: { rich_text: [{ text: { content: city } }] },
              Address: { rich_text: [{ text: { content: address } }] },
              Items: { rich_text: [{ text: { content: itemsSummary } }] },
              "Line Items": { rich_text: [{ text: { content: itemsSummary } }] },
              Status: {
                status: {
                  name: isOrder ? "New Order" : "to be contacted",
                },
              },
              "Idempotency Key": {
                rich_text: [{ text: { content: idempotencyKey } }],
              },
            };

            // Keep only properties that exist in the user's Notion database schema
            const finalProperties = {};
            for (const [key, value] of Object.entries(candidateProperties)) {
              if (schema[key]) {
                const schemaType = schema[key].type;
                // Double check type safety before sending
                if (schemaType === "title" && value.title) finalProperties[key] = value;
                else if (schemaType === "rich_text" && value.rich_text) finalProperties[key] = value;
                else if (schemaType === "phone_number" && value.phone_number !== undefined) finalProperties[key] = value;
                else if (schemaType === "number" && typeof value.number === "number") finalProperties[key] = value;
                else if (schemaType === "url" && value.url !== undefined) finalProperties[key] = value;
                else if (schemaType === "status" && value.status) finalProperties[key] = value;
                else if (schemaType === "select" && value.status?.name) {
                  finalProperties[key] = { select: { name: value.status.name } };
                }
              }
            }

            // Ensure title property is always present
            if (!finalProperties[titlePropName]) {
              finalProperties[titlePropName] = {
                title: [{ text: { content: entityName } }],
              };
            }

            // Create Notion Page
            if (target.type === "data_source") {
              await notion.pages.create({
                icon,
                parent: { type: "data_source_id", data_source_id: target.id },
                properties: finalProperties,
              });
            } else {
              await notion.pages.create({
                icon,
                parent: { database_id: target.id },
                properties: finalProperties,
              });
            }

            console.info("Notion synced successfully:", {
              topic,
              entityName,
              idempotencyKey,
              propertiesSynced: Object.keys(finalProperties),
            });
          })(),
          NOTION_SYNC_TIMEOUT_MS,
          "Notion sync",
        );
      },
      {
        task: "notion_sync",
        topic,
        entityId,
        entityName,
        idempotencyKey,
      },
    );
  } else {
    console.warn("Skipping Notion sync: NOTION_TOKEN or database ID missing in environment variables.");
  }

  return json(res, 200, { received: true, entityName, topic });
};
