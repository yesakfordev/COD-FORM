try {
  require("dotenv").config();
} catch (_) {}
const axios = require("axios");
const { Client } = require("@notionhq/client");

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}

function parseBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test((value || "").toString().trim());
}

function maskValue(value, visible = 4) {
  const raw = (value || "").toString().trim();
  if (!raw) return null;
  if (raw.length <= visible * 2) return `${raw.slice(0, 1)}***${raw.slice(-1)}`;
  return `${raw.slice(0, visible)}...${raw.slice(-visible)}`;
}

function buildStoreAdminBase(store) {
  const trimmed = (store || "").toString().trim().replace(/^https?:\/\//, "");
  return trimmed ? `https://${trimmed}` : null;
}

function summarizeCheck(name, ok, details) {
  return {
    name,
    ok: Boolean(ok),
    ...(details ? { details } : {}),
  };
}

async function getShopifyToken(store) {
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  if (clientId && clientSecret) {
    const resp = await axios.post(
      `https://${store}/admin/oauth/access_token`,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 5000 }
    );
    return resp.data?.access_token || "";
  }
  return process.env.SHOPIFY_ADMIN_TOKEN || "";
}

async function probeShopify() {
  const store = process.env.SHOPIFY_STORE || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-01";
  const baseURL = buildStoreAdminBase(store);

  if (!store || !baseURL) {
    return summarizeCheck("shopify", false, "Missing SHOPIFY_STORE");
  }

  try {
    const token = await getShopifyToken(store);
    if (!token) {
      return summarizeCheck("shopify", false, "Missing SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID & SHOPIFY_CLIENT_SECRET");
    }

    const response = await axios.get(`${baseURL}/admin/api/${apiVersion}/shop.json`, {
      headers: {
        "X-Shopify-Access-Token": token,
      },
      timeout: 5000,
    });

    return summarizeCheck("shopify", true, {
      shop: response.data?.shop?.name || null,
      domain: response.data?.shop?.domain || store,
      apiVersion,
    });
  } catch (err) {
    const errorData = err.response?.data || err.message;
    if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
      return summarizeCheck("shopify", false, {
        error: errorData,
        hint: "SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET is missing from Vercel Environment Variables. Please add them in Vercel Project Settings.",
      });
    }
    return summarizeCheck("shopify", false, errorData);
  }
}

async function tryResolveNotionTarget(notion, id) {
  try {
    const database = await notion.databases.retrieve({ database_id: id });
    return {
      ok: true,
      kind: "database",
      title: database?.title?.[0]?.plain_text || null,
      propertyCount: Object.keys(database?.properties || {}).length,
    };
  } catch {}

  try {
    const source = await notion.dataSources.retrieve({ data_source_id: id });
    return {
      ok: true,
      kind: "data_source",
      title: source?.title?.[0]?.plain_text || null,
      propertyCount: Object.keys(source?.properties || {}).length,
    };
  } catch (err) {
    return {
      ok: false,
      details: err.response?.data || err.message,
    };
  }
}

async function probeNotion() {
  const token = process.env.NOTION_TOKEN || "";
  const draftId = process.env.NOTION_DATABASE_ID || "";
  const orderId = process.env.NOTION_DELIVERY_DATABASE_ID || "";

  if (!token) {
    return summarizeCheck("notion", false, "Missing NOTION_TOKEN");
  }

  const notion = new Client({ auth: token });
  const results = {};

  if (draftId) {
    results.drafts = await tryResolveNotionTarget(notion, draftId);
  } else {
    results.drafts = { ok: false, details: "Missing NOTION_DATABASE_ID" };
  }

  if (orderId) {
    results.orders = await tryResolveNotionTarget(notion, orderId);
  } else {
    results.orders = { ok: false, details: "Missing NOTION_DELIVERY_DATABASE_ID (optional if using drafts only)" };
  }

  const overallOk = Boolean(results.drafts?.ok) || Boolean(results.orders?.ok);

  return summarizeCheck("notion", overallOk, results);
}

async function probeFacebook() {
  const pixelId = process.env.FB_PIXEL_ID || "";
  const token = process.env.FB_CAPI_TOKEN || "";

  if (!pixelId || !token) {
    return summarizeCheck("facebook_capi", true, {
      configured: false,
      note: "Optional Facebook CAPI not configured",
    });
  }

  try {
    const response = await axios.get(`https://graph.facebook.com/v19.0/${pixelId}`, {
      params: {
        access_token: token,
        fields: "id,name",
      },
      timeout: 5000,
    });

    return summarizeCheck("facebook_capi", true, {
      configured: true,
      pixelId: response.data?.id || pixelId,
      name: response.data?.name || null,
      testEventCodePresent: Boolean(process.env.FB_TEST_EVENT_CODE),
    });
  } catch (err) {
    return summarizeCheck("facebook_capi", false, err.response?.data || err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  const url = new URL(req.url || "/api/healthz", "http://localhost");
  const deep = parseBooleanFlag(url.searchParams.get("deep"));

  const config = {
    codApiKey: Boolean(process.env.COD_API_KEY),
    shopify: {
      storePresent: Boolean(process.env.SHOPIFY_STORE),
      store: maskValue(process.env.SHOPIFY_STORE, 6),
      adminTokenPresent: Boolean(process.env.SHOPIFY_ADMIN_TOKEN),
      clientIdPresent: Boolean(process.env.SHOPIFY_CLIENT_ID),
      clientSecretPresent: Boolean(process.env.SHOPIFY_CLIENT_SECRET),
      webhookSecretPresent: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2025-01",
      orderType: process.env.SHOPIFY_ORDER_TYPE || "draft_order",
    },
    notion: {
      tokenPresent: Boolean(process.env.NOTION_TOKEN),
      draftTarget: maskValue(process.env.NOTION_DATABASE_ID, 6),
      orderTarget: maskValue(process.env.NOTION_DELIVERY_DATABASE_ID, 6),
    },
    facebook: {
      configured: Boolean(process.env.FB_PIXEL_ID && process.env.FB_CAPI_TOKEN),
      pixelIdPresent: Boolean(process.env.FB_PIXEL_ID),
      pixelId: maskValue(process.env.FB_PIXEL_ID, 4),
      capiTokenPresent: Boolean(process.env.FB_CAPI_TOKEN),
    },
  };

  const checks = deep
    ? await Promise.all([
        probeShopify(),
        probeNotion(),
        probeFacebook(),
      ])
    : [];

  const failedChecks = checks.filter((check) => !check.ok);
  const status = deep
    ? failedChecks.length
      ? "degraded"
      : "ok"
    : "ok";

  return json(res, deep && failedChecks.length ? 503 : 200, {
    status,
    mode: deep ? "deep" : "basic",
    timestamp: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
    },
    config,
    ...(deep ? { checks } : {}),
    usage: {
      basic: "/api/healthz",
      deep: "/api/healthz?deep=1",
    },
  });
};
