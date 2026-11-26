const createCodOrder = require("./api/create-cod-order");
const shopifyOrderWebhook = require("./api/shopify-order-webhook");
const healthz = require("./api/healthz");
const metaEvent = require("./api/meta-event");

module.exports = async (req, res) => {
  const host = req.headers.host || "localhost";
  const parsedUrl = new URL(req.url, `https://${host}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "");

  // Route to the corresponding API endpoint handler
  if (pathname === "/api/create-cod-order") {
    return createCodOrder(req, res);
  }

  if (pathname === "/api/shopify-order-webhook") {
    return shopifyOrderWebhook(req, res);
  }

  if (pathname === "/api/healthz") {
    return healthz(req, res);
  }

  if (pathname === "/api/meta-event") {
    return metaEvent(req, res);
  }

  // Root welcome / status response
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify(
      {
        status: "online",
        service: "Shopify COD Backend",
        version: "1.0.0",
        endpoints: {
          createOrder: "/api/create-cod-order",
          webhook: "/api/shopify-order-webhook",
          healthz: "/api/healthz",
          metaEvent: "/api/meta-event",
        },
      },
      null,
      2
    )
  );
};
