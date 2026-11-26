try {
  require("dotenv").config();
} catch (_) {}
const axios = require("axios");
const crypto = require("crypto");

const allowedEvents = new Set(["InitiateCheckout", "AddPaymentInfo"]);
const META_MAX_FBCLID_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function isOriginAllowed(origin) {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (
      hostname === "admin.shopify.com" ||
      hostname.endsWith(".myshopify.com") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1"
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
        if (hostname === itemHost || hostname.endsWith(`.${itemHost}`)) return true;
      } catch {}
    }
  } catch (_) {}
  return true;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const reqHeaders = req.headers["access-control-request-headers"];
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders || "Content-Type, X-COD-KEY, X-Idempotency-Key, x-cod-key, x-idempotency-key, *"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function readJsonBody(req, limitBytes = 128 * 1024) {
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
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readTimeoutMs(value, fallbackMs, minimumMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(parsed, minimumMs);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeMetaText(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  return raw.replace(/\s+/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeEmail(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : undefined;
}

function normalizePhoneForMeta(phoneRaw) {
  const digits = (phoneRaw || "").toString().replace(/\D/g, "");
  return digits || undefined;
}

function normalizeCountryCode(value) {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "ethiopia") return "et";
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return undefined;
}

function hashMetaValue(value, normalizer = normalizeMetaText) {
  const normalized = normalizer(value);
  return normalized ? sha256Hex(normalized) : undefined;
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

  return raw;
}

function normalizeMetaCookie(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
}

function cleanString(value, maxLength = 500) {
  const raw = (value || "").toString().trim();
  return raw ? raw.slice(0, maxLength) : undefined;
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

  if (!isOriginAllowed(req.headers.origin)) {
    return json(res, 403, { error: "Not allowed by CORS" });
  }

  const key = req.headers["x-cod-key"];
  if (!key || key !== process.env.COD_API_KEY) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const pixelId = process.env.FB_PIXEL_ID || "";
  const accessToken = process.env.FB_CAPI_TOKEN || "";
  if (!pixelId || !accessToken) {
    return json(res, 200, { action: "skipped", reason: "missing_credentials" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message || "Invalid JSON" });
  }

  const eventName = cleanString(body.eventName, 80);
  const eventId = cleanString(body.eventId, 160);
  if (!allowedEvents.has(eventName) || !eventId) {
    return json(res, 400, { error: "Invalid Meta event" });
  }

  const params = body.params && typeof body.params === "object" ? body.params : {};
  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const fbp = normalizeMetaCookie(body.fbp);
  const fbc = parseMetaFbc(normalizeMetaCookie(body.fbc));
  const emailHash = hashMetaValue(customer.email, normalizeEmail);
  const phoneHash = hashMetaValue(customer.phoneNumber, normalizePhoneForMeta);
  const firstNameHash = hashMetaValue(customer.firstName);
  const lastNameHash = hashMetaValue(customer.lastName);
  const cityHash = hashMetaValue(customer.city);
  const countryHash = hashMetaValue(customer.country || "ET", normalizeCountryCode);
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    undefined;
  const clientUserAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].trim() || undefined
      : undefined;

  const payload = {
    test_event_code: process.env.FB_TEST_EVENT_CODE || undefined,
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_source_url: cleanString(body.pageUrl, 1000) || req.headers.origin,
        event_id: eventId,
        user_data: {
          em: emailHash ? [emailHash] : undefined,
          ph: phoneHash ? [phoneHash] : undefined,
          fn: firstNameHash ? [firstNameHash] : undefined,
          ln: lastNameHash ? [lastNameHash] : undefined,
          ct: cityHash ? [cityHash] : undefined,
          country: countryHash ? [countryHash] : undefined,
          external_id: [eventId],
          fbp,
          fbc,
          client_ip_address: clientIp,
          client_user_agent: clientUserAgent,
        },
        custom_data: {
          value:
            Number.isFinite(Number(params.value)) && Number(params.value) >= 0
              ? Number(params.value)
              : undefined,
          currency: cleanString(params.currency, 8),
          content_ids: Array.isArray(params.content_ids)
            ? params.content_ids.map(String).filter(Boolean).slice(0, 100)
            : undefined,
          content_type: cleanString(params.content_type, 80),
          contents: Array.isArray(params.contents) ? params.contents.slice(0, 100) : undefined,
          num_items:
            Number.isFinite(Number(params.num_items)) && Number(params.num_items) > 0
              ? Number(params.num_items)
              : undefined,
        },
      },
    ],
  };

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${pixelId}/events`,
      payload,
      {
        params: { access_token: accessToken },
        timeout: readTimeoutMs(process.env.FB_CAPI_TIMEOUT_MS, 2500, 1000),
      },
    );
    return json(res, 200, {
      action: "sent",
      eventName,
      eventId,
      eventsReceived: response.data?.events_received ?? null,
      fbtraceId: response.data?.fbtrace_id || null,
    });
  } catch (err) {
    console.error("Meta event CAPI error:", err.response?.data || err.message);
    return json(res, 502, {
      action: "failed",
      eventName,
      eventId,
      message: err.response?.data || err.message,
    });
  }
};
