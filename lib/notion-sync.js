try {
  require("dotenv").config();
} catch (_) {}
const { Client } = require("@notionhq/client");

const notionSchemaCache = new Map();
const inFlightNotionSyncs = new Set();
const recentlySyncedEntities = new Map();

function buildStoreSlug(store) {
  return (store || "")
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .split("/")[0]
    .trim();
}

function buildAdminUrl(entity, store) {
  const cleanStore = (store || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  const slug = buildStoreSlug(cleanStore);
  const gid = entity.admin_graphql_api_id || "";
  const fromGid = gid.split("/").pop();
  const id = fromGid || entity.id;
  if (!id) {
    return entity.order_status_url || entity.invoice_url || null;
  }
  const isActualOrder = gid.includes("/Order/") || Boolean(entity.order_number);
  const path = isActualOrder ? "orders" : "draft_orders";
  if (slug) {
    return `https://admin.shopify.com/store/${slug}/${path}/${id}`;
  }
  if (cleanStore) {
    return `https://${cleanStore}/admin/${path}/${id}`;
  }
  return null;
}

function extractPhone(payload) {
  if (Array.isArray(payload.note_attributes)) {
    const attr = payload.note_attributes.find((a) => {
      const n = (a.name || "").toLowerCase();
      return n === "phone" || n === "phone number" || n === "customer phone";
    });
    if (attr && attr.value && attr.value.trim()) return attr.value.trim();
  }
  return (
    payload.phone ||
    payload.shipping_address?.phone ||
    payload.billing_address?.phone ||
    payload.customer?.phone ||
    payload.customer?.default_address?.phone ||
    ""
  ).toString().trim();
}

function extractName(payload) {
  if (Array.isArray(payload.note_attributes)) {
    const attr = payload.note_attributes.find((a) => {
      const n = (a.name || "").toLowerCase();
      return n === "name" || n === "customer name" || n === "full name";
    });
    if (attr && attr.value && attr.value.trim()) return attr.value.trim();
  }
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
  if (joined) return joined;
  return payload.customer?.default_address?.name || "Customer";
}

function extractCity(payload) {
  if (Array.isArray(payload.note_attributes)) {
    const attr = payload.note_attributes.find((a) => (a.name || "").toLowerCase() === "city");
    if (attr && attr.value && attr.value.trim()) return attr.value.trim();
  }
  return (
    payload.shipping_address?.city ||
    payload.billing_address?.city ||
    payload.customer?.default_address?.city ||
    ""
  );
}

function extractAddress(payload) {
  if (Array.isArray(payload.note_attributes)) {
    const attr = payload.note_attributes.find((a) => (a.name || "").toLowerCase() === "address");
    if (attr && attr.value && attr.value.trim()) return attr.value.trim();
  }
  return (
    payload.shipping_address?.address1 ||
    payload.billing_address?.address1 ||
    payload.customer?.default_address?.address1 ||
    ""
  );
}

function findPropertyKey(schema, possibleNames) {
  if (!schema || typeof schema !== "object") return null;
  const names = Array.isArray(possibleNames) ? possibleNames : [possibleNames];
  const schemaKeys = Object.keys(schema);

  for (const name of names) {
    const exact = schemaKeys.find((k) => k === name);
    if (exact) return exact;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    const match = schemaKeys.find((k) => k.toLowerCase() === lower);
    if (match) return match;
  }
  return null;
}

/**
 * Resolves database or data_source schema (supporting Notion SDK v5+)
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
    if (database) {
      if (database.properties && Object.keys(database.properties).length > 0) {
        const res = { type: "database", id, databaseId: id, schema: database.properties };
        notionSchemaCache.set(id, res);
        return res;
      }
      // Notion SDK v5+: Database properties live in data_sources
      if (Array.isArray(database.data_sources) && database.data_sources.length > 0) {
        const dsId = database.data_sources[0].id;
        try {
          const source = await notion.dataSources.retrieve({ data_source_id: dsId });
          if (source && source.properties) {
            const res = {
              type: "data_source",
              id: dsId,
              databaseId: id,
              schema: source.properties,
            };
            notionSchemaCache.set(id, res);
            return res;
          }
        } catch (e) {
          console.warn("Could not retrieve data_source properties:", e.message);
        }
      }
    }
  } catch (_) {}

  // 2. Try direct data_source
  if (notion.dataSources && typeof notion.dataSources.retrieve === "function") {
    try {
      const source = await notion.dataSources.retrieve({ data_source_id: id });
      if (source && source.properties) {
        const res = { type: "data_source", id: source.id || id, databaseId: id, schema: source.properties };
        notionSchemaCache.set(id, res);
        return res;
      }
    } catch (_) {}
  }

  return { type: "database", id, databaseId: id, schema: {} };
}

/**
 * Ensures "tobeconacted" status option exists in the status schema
 */
async function ensureStatusOption(notion, target, statusPropName, optionName = "tobeconacted") {
  const prop = target?.schema?.[statusPropName];
  if (!prop || prop.type !== "status") return;
  const existingOptions = prop.status?.options || [];
  const exists = existingOptions.some(
    (o) => o.name && o.name.toLowerCase() === optionName.toLowerCase()
  );
  if (exists) return;

  try {
    const newOptions = [...existingOptions.map((o) => ({ name: o.name })), { name: optionName }];
    if (target.type === "data_source" && notion.dataSources?.update) {
      await notion.dataSources.update({
        data_source_id: target.id,
        properties: { [statusPropName]: { status: { options: newOptions } } },
      });
    } else if (notion.databases?.update) {
      await notion.databases.update({
        database_id: target.databaseId || target.id,
        properties: { [statusPropName]: { status: { options: newOptions } } },
      });
    }
  } catch (e) {
    console.warn("Could not auto-add status option to Notion:", e.message);
  }
}

/**
 * Finds an existing page by title or idempotency key
 */
async function findExistingPage(notion, target, titlePropName, titleValue, idempotencyKey) {
  if (!titleValue && !idempotencyKey) return null;

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
  if (!filters.length) return null;

  const filter = filters.length === 1 ? filters[0] : { or: filters };

  try {
    if (target.type === "data_source" && notion.dataSources?.query) {
      const result = await notion.dataSources.query({
        data_source_id: target.id,
        filter,
        page_size: 1,
      });
      return result.results?.[0] || null;
    }

    if (notion.databases?.query) {
      const result = await notion.databases.query({
        database_id: target.databaseId || target.id,
        filter,
        page_size: 1,
      });
      return result.results?.[0] || null;
    }
  } catch (err) {
    console.warn("Notion search warning:", err?.message || err);
  }
  return null;
}

/**
 * Main function to sync a Shopify order or draft order to Notion
 */
async function syncToNotion({
  entity,
  isOrder = false,
  store = process.env.SHOPIFY_STORE || "",
  notionToken = process.env.NOTION_TOKEN || "",
  databaseId = process.env.NOTION_DATABASE_ID || "",
  idempotencyKey = "",
}) {
  if (!notionToken || !databaseId || !entity) {
    console.warn("syncToNotion skipped: missing token, databaseId, or entity");
    return { ok: false, error: "Missing required Notion configuration" };
  }

  const notion = new Client({ auth: notionToken });
  let target = await resolveNotionSchema(notion, databaseId);

  // If primary databaseId had empty schema and it was a delivery DB fallback
  if (!target.schema || Object.keys(target.schema).length === 0) {
    const fallbackId = process.env.NOTION_DATABASE_ID;
    if (fallbackId && fallbackId !== databaseId) {
      target = await resolveNotionSchema(notion, fallbackId);
    }
  }

  const schema = target.schema || {};
  const entityId = entity.id;
  const entityName = (
    entity.name ||
    (isOrder ? `Order #${entity.order_number || entityId}` : `Draft #${entityId}`)
  ).toString().trim();

  // Deduplication check: In-flight or recently completed
  const syncKey = `${isOrder ? "order" : "draft"}:${entityName}`;
  const now = Date.now();
  if (inFlightNotionSyncs.has(syncKey)) {
    console.info("Notion sync skipped (already in flight):", syncKey);
    return { ok: true, skipped: "in_flight" };
  }
  const lastSync = recentlySyncedEntities.get(syncKey);
  if (lastSync && now - lastSync < 10 * 60 * 1000) {
    console.info("Notion sync skipped (already synced recently):", syncKey);
    return { ok: true, skipped: "recently_synced" };
  }

  const customerName = extractName(entity);
  const phone = extractPhone(entity);
  const city = extractCity(entity);
  const address = extractAddress(entity);

  const total = Number(
    entity.total_price ||
    entity.total_price_set?.shop_money?.amount ||
    entity.subtotal_price ||
    entity.subtotal_price_set?.shop_money?.amount ||
    0
  );
  const halfPayment = Number((total / 2).toFixed(2));
  const adminUrl = buildAdminUrl(entity, store);

  // Line items summary
  const itemsSummary = Array.isArray(entity.line_items)
    ? entity.line_items
        .map((i) => `${i.title || i.name || "Item"} x ${i.quantity || 1}`)
        .join(", ")
        .slice(0, 2000)
    : "";

  // Title property
  const titleKey =
    findPropertyKey(schema, ["Draft Number", "Order Name", "Order Number", "Order", "Title", "Name"]) ||
    Object.keys(schema).find((k) => schema[k]?.type === "title") ||
    (isOrder ? "Order Name" : "Draft Number");

  // Check existing page
  const existingPage = await findExistingPage(
    notion,
    target,
    titleKey,
    entityName,
    idempotencyKey
  );

  // Status option check
  const statusKey = findPropertyKey(schema, ["Status", "Order Status", "status"]);
  if (statusKey && schema[statusKey]?.type === "status") {
    await ensureStatusOption(notion, target, statusKey, "tobeconacted");
  }

  // Construct property payload matching user's database schema
  const finalProperties = {};

  // 1. Title
  if (schema[titleKey]?.type === "title" || !schema[titleKey]) {
    finalProperties[titleKey] = {
      title: [{ text: { content: entityName } }],
    };
  }

  // 2. Status: ALWAYS "tobeconacted" for new orders
  if (statusKey) {
    if (schema[statusKey]?.type === "status") {
      finalProperties[statusKey] = { status: { name: "tobeconacted" } };
    } else if (schema[statusKey]?.type === "select") {
      finalProperties[statusKey] = { select: { name: "tobeconacted" } };
    }
  }

  // 3. Customer Name
  const nameKey = findPropertyKey(schema, ["Customer Name", "Recipient Name", "Customer", "Name"]);
  if (nameKey && customerName) {
    if (schema[nameKey]?.type === "rich_text") {
      finalProperties[nameKey] = { rich_text: [{ text: { content: customerName } }] };
    } else if (schema[nameKey]?.type === "title" && nameKey !== titleKey) {
      finalProperties[nameKey] = { title: [{ text: { content: customerName } }] };
    }
  }

  // 4. Phone
  const phoneKey = findPropertyKey(schema, ["Phone", "Phone Number", "Customer Phone", "Mobile"]);
  if (phoneKey) {
    if (schema[phoneKey]?.type === "phone_number") {
      finalProperties[phoneKey] = { phone_number: phone || null };
    } else if (schema[phoneKey]?.type === "rich_text") {
      finalProperties[phoneKey] = { rich_text: [{ text: { content: phone || "" } }] };
    }
  }

  // 5. URL
  const urlKey = findPropertyKey(schema, ["URL", "Shopify URL", "Draft URL", "Order URL", "Link"]);
  if (urlKey) {
    if (schema[urlKey]?.type === "url") {
      finalProperties[urlKey] = { url: adminUrl || null };
    } else if (schema[urlKey]?.type === "rich_text") {
      finalProperties[urlKey] = {
        rich_text: [
          {
            text: {
              content: adminUrl || "",
              link: adminUrl ? { url: adminUrl } : null,
            },
          },
        ],
      };
    }
  }

  // 6. Total
  const totalKey = findPropertyKey(schema, ["Total", "Total Price", "Amount", "Total Amount"]);
  if (totalKey && schema[totalKey]?.type === "number") {
    finalProperties[totalKey] = { number: total };
  }

  // 7. Half Payment
  const halfKey = findPropertyKey(schema, [
    "Half Payment",
    "Half payment",
    "Deposit",
    "50% Payment",
    "Half Amount",
  ]);
  if (halfKey && schema[halfKey]?.type === "number") {
    finalProperties[halfKey] = { number: halfPayment };
  }

  // Additional fields if present in user's database
  const cityKey = findPropertyKey(schema, ["City"]);
  if (cityKey && city && schema[cityKey]?.type === "rich_text") {
    finalProperties[cityKey] = { rich_text: [{ text: { content: city } }] };
  }

  const addressKey = findPropertyKey(schema, ["Address"]);
  if (addressKey && address && schema[addressKey]?.type === "rich_text") {
    finalProperties[addressKey] = { rich_text: [{ text: { content: address } }] };
  }

  const itemsKey = findPropertyKey(schema, ["Items", "Line Items", "Products"]);
  if (itemsKey && itemsSummary && schema[itemsKey]?.type === "rich_text") {
    finalProperties[itemsKey] = { rich_text: [{ text: { content: itemsSummary } }] };
  }

  const idemKeyProp = findPropertyKey(schema, ["Idempotency Key"]);
  if (idemKeyProp && idempotencyKey && schema[idemKeyProp]?.type === "rich_text") {
    finalProperties[idemKeyProp] = { rich_text: [{ text: { content: idempotencyKey } }] };
  }

  const icon = { type: "emoji", emoji: isOrder ? "📦" : "🛒" };

  inFlightNotionSyncs.add(syncKey);
  try {
    if (existingPage) {
      // If page already exists, update properties (ensures any missing fields are filled)
      // Do not overwrite title on update
      const updateProps = { ...finalProperties };
      delete updateProps[titleKey];

      await notion.pages.update({
        page_id: existingPage.id,
        properties: updateProps,
      });

      console.info("Notion page updated:", {
        id: existingPage.id,
        entityName,
        propertiesUpdated: Object.keys(updateProps),
      });
      recentlySyncedEntities.set(syncKey, Date.now());
      return { ok: true, action: "updated", id: existingPage.id };
    }

    // Create new Notion page
    const parent =
      target.type === "data_source"
        ? { type: "data_source_id", data_source_id: target.id }
        : { database_id: target.databaseId || target.id };

    const newPage = await notion.pages.create({
      icon,
      parent,
      properties: finalProperties,
    });

    console.info("Notion page created successfully:", {
      id: newPage.id,
      entityName,
      propertiesSynced: Object.keys(finalProperties),
    });
    recentlySyncedEntities.set(syncKey, Date.now());
    return { ok: true, action: "created", id: newPage.id };
  } catch (err) {
    console.error("Notion sync failed:", err?.response?.data || err.message || err);
    return { ok: false, error: err?.response?.data || err.message };
  } finally {
    inFlightNotionSyncs.delete(syncKey);
  }
}

module.exports = {
  syncToNotion,
  resolveNotionSchema,
  buildAdminUrl,
  extractName,
  extractPhone,
  extractCity,
  extractAddress,
};
