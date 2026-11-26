(() => {
  const defaultSubmitUrl =
    "https://shopify-cod-xi.vercel.app/api/create-cod-order";
  const modal = document.getElementById("custom-cod-modal");
  const confirmModal = document.getElementById("custom-cod-confirm-modal");
  const form = document.getElementById("custom-cod-form");
  const closeBtn = modal?.querySelector(".custom-cod-modal-close");
  const titleEl = modal?.querySelector(".custom-cod-modal-title");
  const confirmationPhoneEl = document.getElementById("cod-confirm-phone");
  const confirmationHandleEl = document.getElementById("cod-confirm-handle");
  const confirmationCloseBtn = confirmModal?.querySelector(
    ".custom-cod-confirmation-close",
  );
  const confirmModalCloseBtn = confirmModal?.querySelector(
    ".custom-cod-confirm-modal-close",
  );
  const codKey = form?.dataset.codKey || "";
  const formCurrency = form?.dataset.currency || "";
  const confirmationPhone = form?.dataset.confirmPhone || "+251 911 405 422";
  const confirmationHandle = form?.dataset.confirmHandle || "@unicart_et";
  const defaultModalTitle = titleEl?.textContent || "Place your order";
  let codItems = [];
  let isOrderNowSyncing = false;
  let isPendingRetryRunning = false;
  let pendingRetryTimer = null;
  let modalHideTimer = null;
  let hasTrackedInitiateCheckout = false;
  let hasTrackedAddPaymentInfo = false;
  let isAwaitingConfirmation = false;
  let lockedScrollY = 0;
  let lockedScrollbarGap = 0;
  let isBodyScrollLocked = false;
  let rebindCodButtons = () => {};
  let syncModalStateAfterSubmit = () => Promise.resolve(false);
  // Keep the button spinner visible for a short moment so the customer
  // sees the order is processing, then move to confirmation optimistically
  // while the request/retry flow continues in the background.
  const COD_SUBMIT_WAIT_MS = 2200;
  const COD_RETRY_TIMEOUT_MS = 4500;
  const COD_INITIAL_RETRY_DELAY_MS = 8000;
  const COD_RETRY_BACKOFF_MS = [1200, 3500, 9000];
  const COD_MAX_AUTO_RETRY_ATTEMPTS = 4;
  const COD_CART_UI_SYNC_FLAG = "cod_cart_ui_sync";
  const META_FBC_COOKIE_NAME = "_fbc";
  const META_FBP_COOKIE_NAME = "_fbp";
  const META_MAX_FBCLID_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  // ---------- Validation helpers ----------
  function isValidEthiopiaPhoneFrontend(phoneRaw) {
    const raw = (phoneRaw || "").trim();
    if (!raw) return false;
    let d = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
    if (d.startsWith("251")) return /^2519\d{8}$/.test(d);
    if (d.startsWith("0")) return /^0+9\d{8}$/.test(d);
    return /^9\d{8}$/.test(d);
  }
  function isNonEmptyText(v, minLength = 1) {
    return !!v && v.trim().length >= minLength;
  }

  // ---------- Analytics helpers ----------
  function getCookie(name) {
    const row = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith(name + "="));
    if (!row) return null;

    const value = row.slice(name.length + 1);
    if (!value) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function setCookie(name, value, maxAgeSeconds) {
    try {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax${secure}`;
    } catch {}
  }

  function getFbclid() {
    const u = new URL(location.href);
    return u.searchParams.get("fbclid") || null;
  }

  function buildMetaFbc(fbclid, timestampMs = Date.now()) {
    const rawFbclid = typeof fbclid === "string" ? fbclid.trim() : "";
    const ts = Number(timestampMs);
    if (!rawFbclid || !Number.isFinite(ts) || ts <= 0) return null;
    return `fb.1.${Math.floor(ts)}.${rawFbclid}`;
  }

  function parseMetaFbc(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return null;

    const match = /^fb\.1\.(\d+)\.(.+)$/.exec(raw);
    if (!match) return null;

    const createdAtMs = Number.parseInt(match[1], 10);
    const fbclid = match[2];
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || !fbclid) {
      return null;
    }

    const now = Date.now();
    if (createdAtMs > now + 5 * 60 * 1000) return null;
    if (now - createdAtMs > META_MAX_FBCLID_AGE_MS) return null;

    return {
      raw,
      fbclid,
      createdAtMs,
    };
  }

  // function resolveMetaClickIds() {
  //   const fbp = getCookie(META_FBP_COOKIE_NAME) || null;
  //   const storedFbc = getCookie(META_FBC_COOKIE_NAME) || null;
  //   const parsedStoredFbc = parseMetaFbc(storedFbc);
  //   const currentFbclid = getFbclid();

  //   if (currentFbclid) {
  //     if (parsedStoredFbc?.fbclid === currentFbclid) {
  //       setCookie(
  //         META_FBC_COOKIE_NAME,
  //         parsedStoredFbc.raw,
  //         Math.floor(META_MAX_FBCLID_AGE_MS / 1000),
  //       );
  //       return { fbp, fbc: parsedStoredFbc.raw };
  //     }

  //     const freshFbc = buildMetaFbc(currentFbclid);
  //     if (freshFbc) {
  //       setCookie(
  //         META_FBC_COOKIE_NAME,
  //         freshFbc,
  //         Math.floor(META_MAX_FBCLID_AGE_MS / 1000),
  //       );
  //       return { fbp, fbc: freshFbc };
  //     }
  //   }

  //   return { fbp, fbc: parsedStoredFbc?.raw || null };
  // }

  function resolveMetaClickIds() {
    const fbp = getCookie(META_FBP_COOKIE_NAME) || null;
    const storedFbc = getCookie(META_FBC_COOKIE_NAME) || null;
    const parsedStoredFbc = parseMetaFbc(storedFbc);
    const currentFbclid = getFbclid();

    // ✅ If we already have a valid _fbc → ALWAYS reuse it
    if (parsedStoredFbc) {
      return { fbp, fbc: parsedStoredFbc.raw };
    }

    // ✅ Only create fbc ONCE (first time we ever see fbclid)
    if (currentFbclid) {
      const freshFbc = buildMetaFbc(currentFbclid);

      if (freshFbc) {
        setCookie(
          META_FBC_COOKIE_NAME,
          freshFbc,
          Math.floor(META_MAX_FBCLID_AGE_MS / 1000),
        );
        return { fbp, fbc: freshFbc };
      }
    }

    return { fbp, fbc: null };
  }

  function getFbpFbc() {
    return resolveMetaClickIds();
  }
  function getUtmParams() {
    const u = new URL(location.href);
    return {
      utm_source: u.searchParams.get("utm_source") || null,
      utm_medium: u.searchParams.get("utm_medium") || null,
      utm_campaign: u.searchParams.get("utm_campaign") || null,
      utm_content: u.searchParams.get("utm_content") || null,
      utm_term: u.searchParams.get("utm_term") || null,
    };
  }

  function getMetaItemIdentifiers(items = []) {
    return Array.from(
      new Set(
        (items || [])
          .filter(Boolean)
          .map((item) => item?.product_id || item?.variant_id)
          .filter((id) => id !== undefined && id !== null)
          .map((id) => String(id).trim())
          .filter(Boolean),
      ),
    );
  }

  function getMetaContents(items = []) {
    return (items || [])
      .filter(
        (item) =>
          item &&
          (item.product_id !== undefined || item.variant_id !== undefined),
      )
      .map((item) => ({
        id: String(item.product_id || item.variant_id),
        quantity: Number(item.quantity) || 1,
      }));
  }

  function getMetaTotalQuantity(items = []) {
    return (items || []).reduce(
      (sum, item) => sum + (Number(item?.quantity) || 0),
      0,
    );
  }

  function buildMetaEventParams(items = [], { value, currency } = {}) {
    const params = {};
    const contentIds = getMetaItemIdentifiers(items);

    if (contentIds.length > 0) {
      params.content_ids = contentIds;
      params.content_type = "product_group";
      const contents = getMetaContents(items);
      if (contents.length > 0) params.contents = contents;
      const numItems = getMetaTotalQuantity(items);
      if (numItems > 0) params.num_items = numItems;
    }

    if (value !== undefined && value > 0) params.value = value;
    if (currency) params.currency = currency;
    return params;
  }

  function getMetaInitiateCheckoutItems(button) {
    const selectedQuantity = Number(getSelectedQuantity(button)) || 1;
    const selectedProductId = getSelectedProductId(button);
    const selectedVariantId = getSelectedVariantId(button);
    const selectedPrice = getSelectedPrice(button);

    if (selectedProductId || selectedVariantId) {
      return [
        {
          product_id: selectedProductId || undefined,
          variant_id: selectedVariantId || undefined,
          quantity: selectedQuantity,
          price: selectedPrice || undefined,
        },
      ];
    }

    return codItems;
  }

  function trackMetaEvent(eventName, options = {}) {
    if (!window.fbq) return false;

    try {
      window.fbq("track", eventName, options.params || {}, options.meta || {});
      console.info(`[COD] ${eventName} sent`, options);
      return true;
    } catch (e) {
      console.warn("Meta event error:", e);
      return false;
    }
  }

  // ---------- UI helpers ----------
  function setErrorBar(msg) {
    const bar = document.getElementById("cod-error-bar");
    if (!bar) return;
    bar.textContent = msg;
    bar.classList.add("show");
    bar.hidden = false;
  }
  function clearErrorBar() {
    const bar = document.getElementById("cod-error-bar");
    if (!bar) return;
    bar.textContent = "";
    bar.classList.remove("show");
    bar.hidden = true;
  }

  const hasPendingSubmission = () => {
    try {
      return sessionStorage.getItem("cod_pending") === "1";
    } catch {
      return false;
    }
  };

  const normalizeSubmitUiState = ({ disableIfPending = false } = {}) => {
    const submitBtn = form?.querySelector(".custom-cod-submit");
    if (submitBtn) {
      submitBtn.classList.remove("is-loading");
      if (disableIfPending && hasPendingSubmission()) {
        submitBtn.disabled = true;
      }
    }

    const isAnyModalVisible =
      modal?.classList.contains("show") ||
      confirmModal?.classList.contains("show");
    if (!isAnyModalVisible) {
      unlockBodyScroll();
    }
  };

  const restoreEntryState = () => {
    isAwaitingConfirmation = false;
    if (titleEl) titleEl.textContent = defaultModalTitle;
  };

  const showConfirmationState = () => {
    isAwaitingConfirmation = false;
    if (confirmationPhoneEl)
      confirmationPhoneEl.textContent = confirmationPhone;
    if (confirmationHandleEl)
      confirmationHandleEl.textContent = confirmationHandle;
    hideModal({ keepBodyLocked: true });
    if (!confirmModal) return;
    confirmModal.classList.remove("hidden");
    requestAnimationFrame(() => {
      confirmModal.classList.add("show");
      document.body.classList.add("modal-open");
      confirmModal.setAttribute("aria-hidden", "false");
    });
  };

  const showSubmissionFailure = (message) => {
    restoreEntryState();
    showModal();
    normalizeSubmitUiState({ disableIfPending: false });
    setErrorBar(message || "We couldn't confirm your order. Please try again.");
  };

  const money = (v) =>
    `Br${v.toLocaleString("en-US", { minimumFractionDigits: 2 })} ETB`;

  function normalizeCurrencyCode(value) {
    const raw = (value || "").toString().trim().toUpperCase();
    return /^[A-Z]{3}$/.test(raw) ? raw : null;
  }

  function resolveCurrencyCode() {
    const code =
      normalizeCurrencyCode(window?.Shopify?.currency?.active) ||
      normalizeCurrencyCode(window?.ShopifyAnalytics?.meta?.currency) ||
      normalizeCurrencyCode(formCurrency);

    return code === "ETB" ? "ETB" : "USD"; // fallback safe
  }

  function getPurchaseValue(items = []) {
    const total = items.reduce((sum, item) => {
      const price = Number(item?.price);
      const quantity = Number(item?.quantity) || 0;
      if (!Number.isFinite(price) || quantity <= 0) return sum;
      return sum + price * quantity;
    }, 0);

    return Number(total.toFixed(2));
  }

  const lockBodyScroll = () => {
    if (isBodyScrollLocked) return;
    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    lockedScrollbarGap =
      Math.max(0, window.innerWidth - document.documentElement.clientWidth) ||
      0;
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.paddingRight = lockedScrollbarGap
      ? `${lockedScrollbarGap}px`
      : "";
    document.body.classList.add("modal-open");
    isBodyScrollLocked = true;
  };

  const unlockBodyScroll = () => {
    if (!isBodyScrollLocked) return;
    document.body.classList.remove("modal-open");
    document.body.style.top = "";
    document.body.style.paddingRight = "";
    window.scrollTo(0, lockedScrollY);
    isBodyScrollLocked = false;
  };

  const showModal = () => {
    if (!modal) return;

    if (!modal.classList.contains("show")) {
      hasTrackedInitiateCheckout = false;
      hasTrackedAddPaymentInfo = false;
      restoreEntryState();
    }

    if (modalHideTimer) {
      clearTimeout(modalHideTimer);
      modalHideTimer = null;
    }

    lockBodyScroll();
    modal.classList.remove("hidden");
    requestAnimationFrame(() => {
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    });
  };

  const hideModal = ({ keepBodyLocked = false } = {}) => {
    if (!modal) return;

    if (modalHideTimer) {
      clearTimeout(modalHideTimer);
      modalHideTimer = null;
    }

    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    modalHideTimer = setTimeout(() => {
      modal.classList.add("hidden");
      if (!keepBodyLocked) {
        unlockBodyScroll();
      }
      modalHideTimer = null;
    }, 220);
  };

  const hideConfirmModal = ({ keepBodyLocked = false } = {}) => {
    if (!confirmModal) return;
    confirmModal.classList.remove("show");
    confirmModal.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
      confirmModal.classList.add("hidden");
      if (!keepBodyLocked) {
        unlockBodyScroll();
      }
    }, 220);
  };

  closeBtn?.addEventListener("click", hideModal);
  confirmationCloseBtn?.addEventListener("click", () => {
    hideConfirmModal();
  });
  confirmModalCloseBtn?.addEventListener("click", () => {
    hideConfirmModal();
  });
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) hideModal();
  });
  confirmModal?.addEventListener("click", (e) => {
    if (e.target === confirmModal) hideConfirmModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("show")) hideModal();
    if (e.key === "Escape" && confirmModal?.classList.contains("show"))
      hideConfirmModal();
  });

  const setLoading = (btn, isLoading) => {
    if (!btn) return;
    btn.classList.toggle("is-loading", isLoading);
    btn.disabled = isLoading;
  };

  const setRemoveLoading = (btn, isLoading) => {
    if (!btn) return;
    btn.classList.toggle("is-removing", isLoading);
    btn.disabled = isLoading;
  };

  const parseQuantity = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const getSelectedVariantId = (btn) => {
    const scope =
      btn?.closest("[data-product-id]") || btn?.closest("section") || document;
    const formEl =
      btn?.closest("form") ||
      scope.querySelector('form[action="/cart/add"]') ||
      document.querySelector('form[action="/cart/add"]');

    const candidates = [
      // Prioritize live selection inside the nearest product scope/form
      formEl?.querySelector('[name="id"]:checked'),
      formEl?.querySelector('select[name="id"]'),
      formEl?.querySelector('input[name="id"][type="hidden"]'),
      scope.querySelector('[name="id"]:checked'),
      scope.querySelector('select[name="id"]'),
      scope.querySelector('input[name="id"][type="hidden"]'),
      // Common custom data attributes some themes expose
      formEl?.dataset?.selectedVariantId
        ? { value: formEl.dataset.selectedVariantId }
        : null,
      scope.querySelector("[data-selected-variant-id]"),
      scope.querySelector("[data-selected-variant]"),
      document.querySelector("[data-selected-variant-id]"),
      document.querySelector("[data-selected-variant]"),
    ].filter(Boolean);

    for (const el of candidates) {
      if (el?.value) return el.value;
      if (el?.dataset?.selectedVariantId) return el.dataset.selectedVariantId;
      if (el?.dataset?.selectedVariant) return el.dataset.selectedVariant;
    }

    // Fallbacks: URL, analytics, and finally any stale data on the button
    const urlVariant = new URL(location.href).searchParams.get("variant");
    if (urlVariant) return urlVariant;

    const analyticsVariant = window?.ShopifyAnalytics?.meta?.selectedVariantId;
    if (analyticsVariant) return analyticsVariant.toString();

    if (btn?.dataset?.currentVariantId) return btn.dataset.currentVariantId;
    if (btn?.dataset?.variantId) return btn.dataset.variantId;

    return null;
  };

  const getSelectedProductId = (btn) => {
    const scopedProductId =
      btn?.closest("[data-product-id]")?.dataset?.productId ||
      btn?.dataset?.productId;
    if (scopedProductId) return String(scopedProductId);

    const productId = window?.ShopifyAnalytics?.meta?.product?.id;
    if (productId) return String(productId);

    return null;
  };

  const getSelectedPrice = (btn) => {
    const scopedPrice =
      btn?.closest("[data-product-id]")?.dataset?.price ||
      btn?.dataset?.price ||
      btn?.closest("[data-variant-id]")?.dataset?.price ||
      btn?.closest("[data-variant]")?.dataset?.price;
    if (scopedPrice) return Number(scopedPrice) / 100; // Assume cents like Shopify

    const analyticsPrice =
      window?.ShopifyAnalytics?.meta?.selectedVariant?.price;
    if (analyticsPrice) return Number(analyticsPrice) / 100;

    // Fallback: look in form for hidden price inputs
    const formEl = btn?.closest("form");
    const priceInput = formEl?.querySelector(
      'input[name="price"][type="hidden"]',
    );
    if (priceInput?.value) return Number(priceInput.value) / 100;

    return null;
  };

  const resetFormState = () => {
    if (!form) return;
    try {
      form.reset();
    } catch {}
    form.querySelectorAll("input, textarea").forEach((el) => {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.defaultChecked !== undefined) el.checked = el.defaultChecked;
      } else {
        el.value = "";
      }
    });
    clearErrorBar();
  };

  const clearPendingSubmission = () => {
    try {
      sessionStorage.removeItem("cod_pending");
      sessionStorage.removeItem("cod_idem");
      sessionStorage.removeItem("cod_payload");
      sessionStorage.removeItem("cod_endpoint");
      sessionStorage.removeItem("cod_key");
      sessionStorage.removeItem("cod_retry_attempt");
      sessionStorage.removeItem("cod_retry_next_at");
    } catch {}

    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
    }

    const submitBtn = form?.querySelector(".custom-cod-submit");
    if (submitBtn) {
      submitBtn.classList.remove("is-loading");
      if (codItems.length > 0) {
        submitBtn.disabled = false;
      }
    }
  };

  const isCartPage = () =>
    location.pathname.replace(/\/+$/, "") === "/cart" ||
    !!document.querySelector("cart-items");

  const hasCartUiSyncFlag = () => {
    try {
      return sessionStorage.getItem(COD_CART_UI_SYNC_FLAG) === "1";
    } catch {
      return false;
    }
  };

  const setCartUiSyncFlag = () => {
    try {
      sessionStorage.setItem(COD_CART_UI_SYNC_FLAG, "1");
    } catch {}
  };

  const clearCartUiSyncFlag = () => {
    try {
      sessionStorage.removeItem(COD_CART_UI_SYNC_FLAG);
    } catch {}
  };

  const requestCartClear = () =>
    fetch("/cart/clear.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      keepalive: true,
      cache: "no-store",
    }).then((res) => {
      if (!res.ok) {
        throw new Error(`Cart clear failed with ${res.status}`);
      }
      return res.json().catch(() => null);
    });

  const fetchSectionDocument = (sectionId) => {
    const url = `${location.pathname}?section_id=${encodeURIComponent(
      sectionId,
    )}&ts=${Date.now()}`;

    return fetch(url, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Section ${sectionId} failed with ${res.status}`);
        }
        return res.text();
      })
      .then((html) => new DOMParser().parseFromString(html, "text/html"));
  };

  const syncCartPageUiFromServer = async () => {
    if (!isCartPage()) return false;

    try {
      const [itemsDoc, footerDoc] = await Promise.all([
        fetchSectionDocument("main-cart-items"),
        fetchSectionDocument("main-cart-footer"),
      ]);

      let didUpdate = false;

      const currentCartItems = document.querySelector("cart-items");
      const nextCartItems = itemsDoc?.querySelector("cart-items");
      if (currentCartItems && nextCartItems) {
        currentCartItems.className = nextCartItems.className;
        currentCartItems.innerHTML = nextCartItems.innerHTML;
        didUpdate = true;
      }

      const currentFooter = document.getElementById("main-cart-footer");
      const nextFooter = footerDoc?.getElementById("main-cart-footer");
      const currentBlocks = currentFooter?.querySelector(".cart__blocks");
      const nextBlocks = nextFooter?.querySelector(".cart__blocks");
      if (currentFooter && nextFooter) {
        currentFooter.className = nextFooter.className;
        if (currentBlocks && nextBlocks) {
          currentBlocks.innerHTML = nextBlocks.innerHTML;
        }
        didUpdate = true;
      }

      if (didUpdate) {
        rebindCodButtons();
        normalizeSubmitUiState({ disableIfPending: true });
      }

      return didUpdate;
    } catch (err) {
      console.warn("COD cart UI sync failed", { message: err?.message });
      return false;
    }
  };

  const syncCodUiIfNeeded = () => {
    if (!hasCartUiSyncFlag()) return;

    requestCartClear()
      .catch((err) => {
        console.warn("COD cart clear retry failed", { message: err?.message });
      })
      .then(() => {
        if (isCartPage()) return syncCartPageUiFromServer();
        return syncModalStateAfterSubmit();
      })
      .then((didSync) => {
        if (didSync) {
          clearCartUiSyncFlag();
        }
      });
  };

  const finalizeSuccessfulCodSubmission = () => {
    clearPendingSubmission();
    setCartUiSyncFlag();

    requestCartClear()
      .catch((err) => {
        console.warn("COD cart clear failed", { message: err?.message });
      })
      .then(() => {
        if (isCartPage()) return syncCartPageUiFromServer();
        return syncModalStateAfterSubmit();
      })
      .then((didSync) => {
        if (didSync) {
          clearCartUiSyncFlag();
        }
      });
  };

  const safeJsonParse = (raw) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const getPendingRetryMeta = () => {
    try {
      const attempts = Number.parseInt(
        sessionStorage.getItem("cod_retry_attempt") || "0",
        10,
      );
      const nextAt = Number.parseInt(
        sessionStorage.getItem("cod_retry_next_at") || "0",
        10,
      );
      return {
        attempts: Number.isFinite(attempts) ? attempts : 0,
        nextAt: Number.isFinite(nextAt) ? nextAt : 0,
      };
    } catch {
      return { attempts: 0, nextAt: 0 };
    }
  };

  const setPendingRetryMeta = (attempts, nextAt) => {
    try {
      sessionStorage.setItem(
        "cod_retry_attempt",
        String(Math.max(0, Number(attempts) || 0)),
      );
      sessionStorage.setItem(
        "cod_retry_next_at",
        String(Math.max(0, Number(nextAt) || 0)),
      );
    } catch {}
  };

  const schedulePendingRetry = (
    delayMs = COD_INITIAL_RETRY_DELAY_MS,
    attempts = getPendingRetryMeta().attempts,
  ) => {
    setPendingRetryMeta(attempts, Date.now() + Math.max(500, Number(delayMs)));
    queuePendingRetry();
  };

  const readPendingSubmission = () => {
    try {
      if (sessionStorage.getItem("cod_pending") !== "1") return null;

      const idem = (sessionStorage.getItem("cod_idem") || "").trim();
      const endpoint =
        (sessionStorage.getItem("cod_endpoint") || "").trim() ||
        defaultSubmitUrl;
      const storedCodKey =
        (sessionStorage.getItem("cod_key") || "").trim() || codKey;
      const payload = safeJsonParse(sessionStorage.getItem("cod_payload"));

      if (!idem || !endpoint || !storedCodKey || !payload) return null;
      return {
        idem,
        endpoint,
        codKey: storedCodKey,
        payload,
      };
    } catch {
      return null;
    }
  };

  const postPendingSubmission = async (
    pending,
    timeoutMs = COD_RETRY_TIMEOUT_MS,
  ) => {
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId =
      controller && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    const headers = {
      "Content-Type": "application/json",
      "X-COD-KEY": pending.codKey,
      "X-Idempotency-Key": pending.idem,
    };

    try {
      return await fetch(pending.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(pending.payload),
        keepalive: true,
        mode: "cors",
        credentials: "omit",
        signal: controller?.signal,
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const queuePendingRetry = () => {
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
    }

    const pending = readPendingSubmission();
    if (!pending) return;

    const { nextAt, attempts } = getPendingRetryMeta();
    if (!nextAt || attempts >= COD_MAX_AUTO_RETRY_ATTEMPTS) return;

    const waitMs = Math.max(0, nextAt - Date.now());
    pendingRetryTimer = setTimeout(() => {
      pendingRetryTimer = null;
      void attemptPendingSubmission("scheduled");
    }, waitMs);
  };

  const attemptPendingSubmission = async (
    reason = "auto",
    { force = false } = {},
  ) => {
    const pending = readPendingSubmission();
    if (!pending || isPendingRetryRunning) return false;

    const { attempts, nextAt } = getPendingRetryMeta();
    if (!force && nextAt && nextAt > Date.now()) {
      queuePendingRetry();
      return false;
    }

    if (attempts >= COD_MAX_AUTO_RETRY_ATTEMPTS) {
      console.warn("COD pending submission reached max auto retries", {
        attempts,
      });
      return false;
    }

    isPendingRetryRunning = true;
    try {
      const response = await postPendingSubmission(pending);
      if (response?.ok) {
        finalizeSuccessfulCodSubmission();
        return true;
      }

      // Do not keep retrying on permanent client/auth errors.
      if (
        response &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        console.warn("COD retry stopped due to non-retryable status", {
          reason,
          status: response.status,
        });
        clearPendingSubmission();
        return false;
      }

      console.warn("COD retry got non-OK response", {
        reason,
        status: response?.status || "timeout",
      });
    } catch (err) {
      console.warn("COD retry request failed", {
        reason,
        message: err?.message,
      });
    } finally {
      isPendingRetryRunning = false;
    }

    const nextAttempt = attempts + 1;
    const delay =
      COD_RETRY_BACKOFF_MS[
        Math.min(nextAttempt - 1, COD_RETRY_BACKOFF_MS.length - 1)
      ] || COD_RETRY_BACKOFF_MS[COD_RETRY_BACKOFF_MS.length - 1];
    setPendingRetryMeta(nextAttempt, Date.now() + delay);
    queuePendingRetry();
    return false;
  };

  const bootPendingSubmissionRecovery = () => {
    normalizeSubmitUiState({ disableIfPending: true });

    // If we still have an outstanding pending order (cod_pending), clear cart now.
    // This covers the case where the keepalive request returned on the previous
    // page before finalizeSuccessfulCodSubmission could run.
    if (hasPendingSubmission()) {
      requestCartClear().catch((err) => {
        console.warn("COD boot recovery cart clear failed", {
          message: err?.message,
        });
      });
    }

    // Browsers can restore previous DOM from bfcache on back navigation.
    // Ensure stale loading overlays/buttons are always reset.
    window.addEventListener("pagehide", () => {
      normalizeSubmitUiState({ disableIfPending: false });
    });

    window.addEventListener("pageshow", () => {
      normalizeSubmitUiState({ disableIfPending: true });
      syncCodUiIfNeeded();
    });

    void attemptPendingSubmission("page-load");

    window.addEventListener("online", () => {
      void attemptPendingSubmission("online");
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void attemptPendingSubmission("visibility");
      }
    });

    queuePendingRetry();
  };

  const buildEventId = () =>
    (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  const getSelectedQuantity = (btn) => {
    const formEl = btn.closest("form");
    const candidates = [
      formEl?.querySelector('input[name="quantity"]:not([type="hidden"])'),
      formEl?.querySelector('input[name="quantity"]'),
      document.querySelector(
        'form[action="/cart/add"] input[name="quantity"]:not([type="hidden"])',
      ),
      document.querySelector('form[action="/cart/add"] input[name="quantity"]'),
      document.querySelector('input[name="quantity"]:not([type="hidden"])'),
      document.querySelector('input[name="quantity"]'),
    ].filter(Boolean);

    for (const el of candidates) {
      const parsed = parseQuantity(el.value);
      if (parsed !== null) return parsed;
    }

    return parseQuantity(btn.dataset.quantity) || 1;
  };

  const syncSelectedItemInCart = (variantId, quantity) => {
    const targetVariantId = String(variantId);
    const targetQty = Number(quantity) || 1;

    return fetch(`/cart.js?ts=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((cart) => {
        const cartItems = cart.items || [];
        const existing = cartItems.find(
          (item) => String(item.variant_id) === targetVariantId,
        );

        // Keep the previous modal/cart data only if the selected product already
        // matches exactly.
        if (existing && Number(existing.quantity) === targetQty) {
          return cart;
        }

        if (existing) {
          if (Number(existing.quantity) !== targetQty) {
            return fetch("/cart/change.js", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: existing.key || existing.variant_id,
                quantity: targetQty,
              }),
            }).then((r) => r.json());
          }
          return cart;
        }

        return fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ id: targetVariantId, quantity: targetQty }],
          }),
        }).then((r) => r.json());
      });
  };

  const renderCodItems = (items = []) => {
    codItems = items;
    const list = document.getElementById("cod-product-list");
    const subtotalEl = document.getElementById("cod-subtotal");
    const totalEl = document.getElementById("cod-total");
    const submitBtn = form?.querySelector(".custom-cod-submit");
    if (!list || !subtotalEl || !totalEl) return;

    list.innerHTML = "";
    let subtotal = 0;

    codItems.forEach((item) => {
      const div = document.createElement("div");
      div.className = "custom-cod-item";
      div.innerHTML = `
        <div class="custom-cod-item-image loading">
          <div class="img-spinner" aria-hidden="true"></div>
          ${
            item.image
              ? `<img src="${item.image}" alt="${item.title || ""}">`
              : `<div class="img-fallback">No image</div>`
          }
        </div>
        <div class="custom-cod-item-info">
          <div class="custom-cod-item-title">${item.title || ""}</div>
          <div class="custom-cod-item-variant">${item.variant || ""} · Qty: ${
            item.quantity || 1
          }</div>
        </div>
        <div class="custom-cod-item-price">${item.priceText || ""}</div>
        <button type="button" class="remove-btn" aria-label="Remove item">×</button>
      `;
      list.appendChild(div);

      const imgWrapper = div.querySelector(".custom-cod-item-image");
      const img = imgWrapper?.querySelector("img");
      if (img) {
        const finish = () => {
          imgWrapper.classList.remove("loading");
          img.style.opacity = "1";
        };
        const fail = () => {
          imgWrapper.classList.remove("loading");
          imgWrapper.classList.add("error");
        };
        img.addEventListener("load", finish);
        img.addEventListener("error", fail);
        if (img.complete) (img.naturalWidth ? finish : fail)();
      } else {
        imgWrapper?.classList.remove("loading");
      }

      const removeBtn = div.querySelector(".remove-btn");
      removeBtn?.addEventListener("click", () => {
        setRemoveLoading(removeBtn, true);
        const payload = item.key
          ? { id: item.key, quantity: 0 }
          : item.line
            ? { line: item.line, quantity: 0 }
            : { id: item.variant_id, quantity: 0 };

        fetch("/cart/change.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((res) => res.json())
          .then(() => fetchCartAndRender())
          .catch((err) => console.error("Error removing item from cart:", err))
          .finally(() => setRemoveLoading(removeBtn, false));
      });

      if (item.price && item.quantity) subtotal += item.price * item.quantity;
    });

    subtotalEl.textContent = money(subtotal);
    totalEl.textContent = money(subtotal);
    if (submitBtn) submitBtn.disabled = codItems.length === 0;
    if (codItems.length === 0 && !isAwaitingConfirmation) {
      hideModal();
    }
  };

  const renderCartPreparingState = () => {
    const list = document.getElementById("cod-product-list");
    const subtotalEl = document.getElementById("cod-subtotal");
    const totalEl = document.getElementById("cod-total");
    const submitBtn = form?.querySelector(".custom-cod-submit");
    if (!list || !subtotalEl || !totalEl) return;

    list.innerHTML =
      '<div class="custom-cod-skeleton-list" aria-hidden="true">' +
      '  <div class="custom-cod-skeleton-status" role="status">' +
      '    <span class="custom-cod-skeleton-spinner" aria-hidden="true"></span>' +
      "    <span>Loading product details...</span>" +
      "  </div>" +
      '  <div class="custom-cod-skeleton-item">' +
      '    <div class="custom-cod-skeleton-thumb custom-cod-skeleton-block"></div>' +
      '    <div class="custom-cod-skeleton-copy">' +
      '      <div class="custom-cod-skeleton-line custom-cod-skeleton-line-title custom-cod-skeleton-block"></div>' +
      '      <div class="custom-cod-skeleton-line custom-cod-skeleton-line-meta custom-cod-skeleton-block"></div>' +
      "    </div>" +
      '    <div class="custom-cod-skeleton-pill custom-cod-skeleton-block"></div>' +
      "  </div>" +
      '  <div class="custom-cod-skeleton-item">' +
      '    <div class="custom-cod-skeleton-thumb custom-cod-skeleton-block"></div>' +
      '    <div class="custom-cod-skeleton-copy">' +
      '      <div class="custom-cod-skeleton-line custom-cod-skeleton-line-title custom-cod-skeleton-block"></div>' +
      '      <div class="custom-cod-skeleton-line custom-cod-skeleton-line-meta custom-cod-skeleton-block"></div>' +
      "    </div>" +
      '    <div class="custom-cod-skeleton-pill custom-cod-skeleton-block"></div>' +
      "  </div>" +
      "</div>";
    subtotalEl.innerHTML =
      '<span class="custom-cod-skeleton-inline custom-cod-skeleton-block" aria-hidden="true"></span>';
    totalEl.innerHTML =
      '<span class="custom-cod-skeleton-inline custom-cod-skeleton-block" aria-hidden="true"></span>';
    if (submitBtn) submitBtn.disabled = true;
  };

  const setCartSyncStatus = (
    isSyncing,
    message = "Adding item to your order...",
  ) => {
    const list = document.getElementById("cod-product-list");
    if (!list) return;

    const existing = list.querySelector(".custom-cod-sync-status");
    if (!isSyncing) {
      existing?.remove();
      return;
    }

    if (existing) {
      const text = existing.querySelector(".custom-cod-sync-text");
      if (text) text.textContent = message;
      return;
    }

    const status = document.createElement("div");
    status.className = "custom-cod-sync-status";
    status.setAttribute("role", "status");
    status.innerHTML =
      '<span class="custom-cod-sync-spinner" aria-hidden="true"></span>' +
      '<span class="custom-cod-sync-text"></span>';

    const text = status.querySelector(".custom-cod-sync-text");
    if (text) text.textContent = message;

    list.prepend(status);
  };

  const fetchCartAndRender = () => {
    return fetch(`/cart.js?ts=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((cart) => {
        if (!cart.items || cart.items.length === 0) {
          renderCodItems([]);
          if (!isAwaitingConfirmation) {
            hideModal();
          }
          return cart;
        }
        const items = cart.items.map((item, index) => ({
          key: item.key,
          line: index + 1,
          product_id: item.product_id,
          title: item.product_title,
          variant: item.variant_title,
          quantity: item.quantity,
          price: item.price / 100,
          priceText: `Br${(item.price / 100).toLocaleString("en-US", {
            minimumFractionDigits: 2,
          })}`,
          image: item.image,
          variant_id: item.variant_id,
        }));
        renderCodItems(items);
        return cart;
      })
      .catch((err) => console.error("Error fetching cart:", err));
  };

  syncModalStateAfterSubmit = () =>
    fetchCartAndRender()
      .then(() => {
        resetFormState();
        return true;
      })
      .catch((err) => {
        console.warn("COD modal state sync failed", { message: err?.message });
        return false;
      });

  bootPendingSubmissionRecovery();
  if (!modal || !form) return;

  const bindCodButtons = () => {
    document.querySelectorAll(".cod-btn").forEach((orderBtn) => {
      if (orderBtn.dataset.codBound === "1") return;
      orderBtn.dataset.codBound = "1";

      orderBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetFormState();
        const variantId = getSelectedVariantId(orderBtn);
        const quantity = getSelectedQuantity(orderBtn);
        const productId = getSelectedProductId(orderBtn);
        showModal();
        if (!hasTrackedInitiateCheckout) {
          const initiateCheckoutItems = getMetaInitiateCheckoutItems(orderBtn);
          const initiateCheckoutValue = getPurchaseValue(initiateCheckoutItems);
          const initiateCheckoutCurrency = resolveCurrencyCode();

          if (
            trackMetaEvent("InitiateCheckout", {
              params: buildMetaEventParams(initiateCheckoutItems, {
                value: initiateCheckoutValue,
                currency: initiateCheckoutCurrency,
              }),
              log: {
                event: "InitiateCheckout",
                value: initiateCheckoutValue,
                currency: initiateCheckoutCurrency,
                content_ids: getMetaItemIdentifiers(initiateCheckoutItems),
              },
            })
          ) {
            hasTrackedInitiateCheckout = true;
          }
        }

        if (!variantId) {
          const isCartScopedOrderButton =
            orderBtn.id === "cart-cod-btn" ||
            orderBtn.dataset.cartCod === "true";
          if (!isCartScopedOrderButton) {
            console.error("Variant ID not set on Order Now button.");
          }
          if (isOrderNowSyncing) {
            setCartSyncStatus(true, "Updating cart items...");
            return;
          }

          isOrderNowSyncing = true;
          if (codItems.length === 0) {
            renderCartPreparingState();
          } else {
            setCartSyncStatus(true, "Updating cart items...");
          }

          fetchCartAndRender().finally(() => {
            setCartSyncStatus(false);
            isOrderNowSyncing = false;
          });
          return;
        }

        const selectedVariant = String(variantId);
        const selectedQty = Number(quantity) || 1;
        const hasPendingUiSync = hasCartUiSyncFlag();
        const hasSameItemInModal = codItems.some(
          (item) =>
            String(item.variant_id) === selectedVariant &&
            Number(item.quantity) === selectedQty,
        );

        // Fast path: no variant/qty change, so reopen instantly with existing data.
        if (hasSameItemInModal && !hasPendingUiSync) return;

        if (isOrderNowSyncing) {
          setCartSyncStatus(true);
          return;
        }

        isOrderNowSyncing = true;
        if (codItems.length === 0) {
          renderCartPreparingState();
        } else {
          setCartSyncStatus(true);
        }

        syncSelectedItemInCart(selectedVariant, selectedQty)
          .then(() => fetchCartAndRender())
          .catch((err) => {
            console.error("Error adding product to cart:", err);
            return fetchCartAndRender();
          })
          .finally(() => {
            setCartSyncStatus(false);
            isOrderNowSyncing = false;
          });
      });
    });
  };

  rebindCodButtons = bindCodButtons;

  bindCodButtons();

  if (typeof MutationObserver !== "undefined") {
    const codBtnObserver = new MutationObserver(() => {
      bindCodButtons();
    });
    codBtnObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  form?.addEventListener("focusin", (e) => {
    const target = e.target;
    if (hasTrackedAddPaymentInfo || !target) return;
    if (
      !(
        target.matches?.("input, textarea, select") &&
        !target.matches('input[type="hidden"], input[type="submit"], button')
      )
    ) {
      return;
    }

    const paymentValue = getPurchaseValue(codItems);
    const paymentCurrency = resolveCurrencyCode();

    if (
      trackMetaEvent("AddPaymentInfo", {
        params: buildMetaEventParams(codItems, {
          value: paymentValue,
          currency: paymentCurrency,
        }),
        log: {
          event: "AddPaymentInfo",
          value: paymentValue,
          currency: paymentCurrency,
          content_ids: getMetaItemIdentifiers(codItems),
        },
      })
    ) {
      hasTrackedAddPaymentInfo = true;
    }
  });

  // ---------- Submit with validation + in-modal confirmation + hidden retry ----------
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector(".custom-cod-submit");
    if (submitBtn?.classList.contains("is-loading")) return;

    const fullNameEl = form.querySelector("#full_name");
    const phoneEl = form.querySelector("#phone");
    const cityEl = form.querySelector("#city");
    const addressEl = form.querySelector("#address");

    const fullName = fullNameEl?.value.trim();
    const phoneNumber = phoneEl?.value.trim();
    const city = cityEl?.value.trim();
    const address = addressEl?.value.trim();

    clearErrorBar();

    [fullNameEl, phoneEl, cityEl, addressEl].forEach((el) => {
      if (!el?._codBound) {
        el?.addEventListener("input", () => clearErrorBar());
        el._codBound = true;
      }
    });

    let firstInvalid = null;
    let message = "";

    if (!isNonEmptyText(fullName)) {
      firstInvalid = fullNameEl;
      message = "Enter your full name.";
    } else if (!isValidEthiopiaPhoneFrontend(phoneNumber)) {
      firstInvalid = phoneEl;
      message = "Enter a valid Ethiopian mobile (e.g. 0912345678).";
    } else if (!isNonEmptyText(city)) {
      firstInvalid = cityEl;
      message = "Enter your city.";
    } else if (!isNonEmptyText(address, 2)) {
      firstInvalid = addressEl;
      message = "Add a more detailed address.";
    } else if (codItems.length === 0) {
      message = "Your cart is empty. Please add a product.";
    }

    if (message) {
      setErrorBar(message);
      firstInvalid?.focus();
      return;
    }

    const payload = {
      fullName,
      phoneNumber,
      city,
      address,
      items: codItems.map((i) => ({
        variantId: i.variant_id,
        quantity: i.quantity,
      })),
      ...(() => {
        const { fbp, fbc } = getFbpFbc();
        return {
          fbp,
          fbc,
          pageUrl: location.href,
          ...getUtmParams(),
        };
      })(),
    };

    const endpoint = (form.dataset.submitUrl || "").trim() || defaultSubmitUrl;
    const headers = {
      "Content-Type": "application/json",
      "X-COD-KEY": codKey,
    };

    const idem = buildEventId();
    const purchaseValue = getPurchaseValue(codItems);
    const purchaseCurrency = resolveCurrencyCode();
    payload.eventId = idem;

    headers["X-Idempotency-Key"] = idem;

    try {
      sessionStorage.setItem("cod_pending", "1");
      sessionStorage.setItem("cod_idem", idem);
      sessionStorage.setItem("cod_payload", JSON.stringify(payload));
      sessionStorage.setItem("cod_endpoint", endpoint);
      sessionStorage.setItem("cod_key", codKey);
      sessionStorage.setItem("cod_retry_attempt", "0");
      sessionStorage.setItem(
        "cod_retry_next_at",
        String(Date.now() + COD_INITIAL_RETRY_DELAY_MS),
      );
    } catch {}

    setLoading(submitBtn, true);
    isAwaitingConfirmation = true;

    trackMetaEvent("Purchase", {
      params: buildMetaEventParams(codItems, {
        value: purchaseValue,
        currency: purchaseCurrency,
      }),
      meta: { eventID: idem },
      log: {
        eventID: idem,
        value: purchaseValue,
        currency: purchaseCurrency,
        content_ids: getMetaItemIdentifiers(codItems),
      },
    });

    const revealConfirmation = () => {
      setLoading(submitBtn, false);
      showConfirmationState();
    };
    const confirmationTimer = window.setTimeout(
      revealConfirmation,
      COD_SUBMIT_WAIT_MS,
    );

    try {
      const requestPromise = fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        keepalive: true,
        mode: "cors",
        credentials: "omit",
      });

      // Keep retry/failover logic in background while the modal transitions
      // from the spinner state to the confirmation state.
      requestPromise
        .then((lateResponse) => {
          if (lateResponse?.ok) {
            finalizeSuccessfulCodSubmission();
            return;
          }

          if (
            lateResponse &&
            lateResponse.status >= 400 &&
            lateResponse.status < 500 &&
            lateResponse.status !== 408 &&
            lateResponse.status !== 429
          ) {
            window.clearTimeout(confirmationTimer);
            clearPendingSubmission();
            showSubmissionFailure(
              "We couldn't confirm your order. Please check your details and try again.",
            );
            return;
          }

          schedulePendingRetry(COD_INITIAL_RETRY_DELAY_MS, 0);
        })
        .catch((err) => {
          console.warn("COD submit request failed", { message: err?.message });
          schedulePendingRetry(COD_INITIAL_RETRY_DELAY_MS, 0);
        });
    } catch (err) {
      console.error("COD submit setup error:", err);
      schedulePendingRetry(COD_INITIAL_RETRY_DELAY_MS, 0);
    }
  });

  window.fetchCartAndRender = fetchCartAndRender;
  window.renderCodItems = renderCodItems;

  fetchCartAndRender();
})();
