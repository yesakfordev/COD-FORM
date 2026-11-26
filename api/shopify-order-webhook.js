try {
  require("dotenv").config();
} catch (_) {}
const crypto = require("crypto");
const { syncToNotion } = require("../lib/notion-sync");
let waitUntil;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch {
  waitUntil = undefined;
}

const allowedTopics = new Set(["orders/create", "draft_orders/create"]);

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

function scheduleBestEffortTask(taskPromiseFactory, meta = {}) {
  const task = Promise.resolve()
    .then(taskPromiseFactory)
    .catch((err) => {
      console.error("Best-effort webhook task failed", {
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
    process.env.NOTION_DELIVERY_DATABASE_ID || NOTION_DATABASE_ID; // Orders database
  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";

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

  if (NOTION_TOKEN && parentDb) {
    scheduleBestEffortTask(
      async () => {
        await syncToNotion({
          entity,
          isOrder,
          store: SHOPIFY_STORE,
          notionToken: NOTION_TOKEN,
          databaseId: parentDb,
          idempotencyKey,
        });
      },
      {
        task: "notion_sync",
        topic,
        entityId,
        entityName,
        idempotencyKey,
      }
    );
  } else {
    console.warn("Skipping Notion sync: NOTION_TOKEN or database ID missing in environment variables.");
  }

  return json(res, 200, { received: true, entityName, topic });
};
