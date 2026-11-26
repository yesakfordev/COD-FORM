module.exports = (req, res) => {
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
