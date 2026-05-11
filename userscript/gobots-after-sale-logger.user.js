// ==UserScript==
// @name         Gobots After-Sale Local Logger
// @namespace    sanstar.local
// @version      1.0.1
// @description  Listen for Gobots after-sale customer messages and send them to the local TXT/Feishu logger.
// @match        https://painel.gobots.com.br/*
// @match        file:///*Gobots*After-Sale*.html
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    targetHost: "painel.gobots.com.br",
    logApi: "http://127.0.0.1:3107/log-message",
    healthApi: "http://127.0.0.1:3107/health",
    scanDelayMs: 2500,
    retryIntervalMs: 1000,
    maxFindAttempts: 25,
    stateScanIntervalMs: 10000,
    mutationDebounceMs: 800,
    minTextLength: 2,
    maxTextLength: 50000,
    dedupeStorageKey: "gobots_after_sale_logger_sent_keys_v1",
    maxDedupeKeys: 1000,
    logExistingOnFirstRun: false,
    debug: true
  };

  const LOG_PREFIX = "Gobots After-Sale Local Logger";
  const SELECTORS = {
    page: '[class*="aftersale__Container"]',
    content: '[class*="aftersale__Content"]',
    orderList: '[class*="SidebarStyle__OrderListContainer"]',
    orderCard: '[class*="OrderCardStyle__Container"]',
    orderTitle: '[class*="OrderCardStyle__Title"]',
    orderTimestamp: '[class*="OrderCardStyle__Timestamp"]',
    orderTextLabel: '[class*="OrderCardStyle__TextLabel"]',
    responsibleText: '[class*="OrderCardStyle__ResponsibleText"]',
    headerCustomer: '[class*="HeaderStyle__CustomerNameWrapper"]',
    headerOrder: '[class*="HeaderStyle__OrderNumber"]',
    messagesContainer: '[class*="MessagesStyle__Container"]',
    messageBlock: '[class*="MessagesStyle__ImageContainer"]',
    messageCardContainer: '[class*="MessagesStyle__CardContainer"]',
    messageCard: '[class*="MessagesStyle__Card"]',
    messageText: '[class*="MessagesStyle__Text"]',
    messageDate: '[class*="MessagesStyle__MessageDate"]',
    infoItem: '[class*="InfosAccordionStyle__ItemContainer"]',
    infoTitle: '[class*="InfosAccordionStyle__Title"]',
    copyText: '[class*="CopyableTextStyle__CopyText"]',
    productSku: '[class*="AdSectionStyle__ProductSku"]'
  };

  const UI_TEXTS = [
    "Filters",
    "Clear Filters",
    "Sort",
    "Most Recent",
    "Urgents",
    "conversations found",
    "Aftersale",
    "Presale",
    "Copy",
    "Approve message",
    "Discard review",
    "Help AI respond better",
    "Cancel",
    "Send",
    "No responsible"
  ];

  let orderListObserver = null;
  let messageObserver = null;
  let stateScanTimer = null;
  let mutationTimer = null;
  let isStarted = false;
  let isStarting = false;
  let runToken = 0;
  let sentKeyList = [];
  let sentKeys = new Set();
  let storageLoaded = false;
  const cardStateMap = new Map();
  const messageStateMap = new Map();
  const debugWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  function debugLog(...args) {
    if (CONFIG.debug) {
      console.log(`[${LOG_PREFIX}]`, ...args);
    }
  }

  function isPromiseLike(value) {
    return value && typeof value.then === "function";
  }

  function gmGetValue(key, defaultValue) {
    if (typeof GM_getValue === "function") {
      return GM_getValue(key, defaultValue);
    }

    if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
      return GM.getValue(key, defaultValue);
    }

    return defaultValue;
  }

  function gmSetValue(key, value) {
    if (typeof GM_setValue === "function") {
      return GM_setValue(key, value);
    }

    if (typeof GM !== "undefined" && GM && typeof GM.setValue === "function") {
      return GM.setValue(key, value);
    }

    return undefined;
  }

  function gmRequest(details) {
    if (typeof GM_xmlhttpRequest === "function") {
      return GM_xmlhttpRequest(details);
    }

    if (typeof GM !== "undefined" && GM) {
      if (typeof GM.xmlHttpRequest === "function") {
        return GM.xmlHttpRequest(details);
      }

      if (typeof GM.xmlhttpRequest === "function") {
        return GM.xmlhttpRequest(details);
      }
    }

    throw new Error("GM_xmlhttpRequest is not available");
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getNodeText(node) {
    return String((node && (node.innerText || node.textContent)) || "").trim();
  }

  function limitText(text) {
    const value = String(text || "");
    return value.length <= CONFIG.maxTextLength
      ? value
      : `${value.slice(0, CONFIG.maxTextLength)}\n...[truncated]`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function getTodayString(date = new Date()) {
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-");
  }

  function getNowString(date = new Date()) {
    return `${getTodayString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function hashString(input) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const text = String(input || "");

    for (let index = 0; index < text.length; index += 1) {
      const ch = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function isTargetPage() {
    const title = normalizeText(document.title);
    const href = String(location.href || "");
    const isGobotsHost = location.hostname === CONFIG.targetHost;
    const isLocalGobotsSnapshot = location.protocol === "file:"
      && /Gobots/i.test(href)
      && /After-Sale/i.test(href);
    const looksAfterSale = /after[-_/\s]?sale/i.test(href)
      || /After-Sale/i.test(title)
      || Boolean(document.querySelector(SELECTORS.page));

    return (isGobotsHost || isLocalGobotsSnapshot) && looksAfterSale;
  }

  function parseStoredKeys(stored) {
    if (Array.isArray(stored)) {
      return stored.filter((item) => typeof item === "string");
    }

    if (typeof stored === "string") {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    }

    return [];
  }

  async function ensureStorageLoaded() {
    if (storageLoaded) {
      return;
    }

    try {
      const stored = gmGetValue(CONFIG.dedupeStorageKey, []);
      sentKeyList = parseStoredKeys(isPromiseLike(stored) ? await stored : stored);
      sentKeys = new Set(sentKeyList);
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] Failed to load dedupe keys:`, error);
      sentKeyList = [];
      sentKeys = new Set();
    }

    storageLoaded = true;
    debugLog(`loaded ${sentKeyList.length} dedupe keys`);
  }

  function persistDedupeKeys() {
    try {
      const result = gmSetValue(CONFIG.dedupeStorageKey, sentKeyList);

      if (isPromiseLike(result)) {
        result.catch((error) => {
          console.warn(`[${LOG_PREFIX}] Failed to save dedupe keys:`, error);
        });
      }
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] Failed to save dedupe keys:`, error);
    }
  }

  function markSent(key) {
    if (!key || sentKeys.has(key)) {
      return;
    }

    sentKeys.add(key);
    sentKeyList.push(key);

    while (sentKeyList.length > CONFIG.maxDedupeKeys) {
      const removed = sentKeyList.shift();
      sentKeys.delete(removed);
    }

    persistDedupeKeys();
  }

  function getOrderNo(text) {
    const match = String(text || "").match(/\b(20\d{11,18})\b/);
    return match ? match[1] : "";
  }

  function getPackageNo(text) {
    const packageMatch = String(text || "").match(/Package ID\s*([0-9]{8,})/i);
    return packageMatch ? packageMatch[1] : "";
  }

  function getSku(text) {
    const match = String(text || "").match(/\bSKU\s*:\s*([A-Za-z0-9._-]+)/i);
    return match ? match[1] : "";
  }

  function isPureUiText(text) {
    const compact = normalizeText(text).replace(/\s+/g, "");

    if (!compact) {
      return true;
    }

    return UI_TEXTS.some((item) => compact === item.replace(/\s+/g, ""));
  }

  function getInfoField(label) {
    const wanted = normalizeText(label).toLowerCase();
    const items = Array.from(document.querySelectorAll(SELECTORS.infoItem));

    for (const item of items) {
      const title = normalizeText(getNodeText(item.querySelector(SELECTORS.infoTitle))).toLowerCase();

      if (title !== wanted) {
        continue;
      }

      const valueNode = item.querySelector(SELECTORS.copyText);
      const value = normalizeText(getNodeText(valueNode));
      return value === "-" ? "" : value;
    }

    return "";
  }

  function getCurrentConversationContext() {
    const content = document.querySelector(SELECTORS.content) || document;
    const headerText = normalizeText(getNodeText(content.querySelector(SELECTORS.headerCustomer)));
    const headerOrderText = normalizeText(getNodeText(content.querySelector(SELECTORS.headerOrder)));
    const headerOrderNo = getOrderNo(`${headerText} ${headerOrderText}`);
    const customerName = normalizeText(
      headerText
        .replace(/\(\s*Order\s+\d+\s*\)/i, "")
        .replace(/\bOrder\s+\d+\b/i, "")
    );
    const contentText = getNodeText(content);
    const productSkuText = normalizeText(getNodeText(content.querySelector(SELECTORS.productSku)));

    return {
      orderNo: headerOrderNo || getOrderNo(contentText),
      customerName,
      shopName: getInfoField("Store Name"),
      sku: getSku(productSkuText) || getSku(contentText),
      packageNo: getInfoField("Package ID"),
      rawText: contentText
    };
  }

  function parseOrderCard(card) {
    const rawText = getNodeText(card);
    const labels = Array.from(card.querySelectorAll(SELECTORS.orderTextLabel))
      .map((node) => normalizeText(getNodeText(node)))
      .filter(Boolean);
    const orderNo = getOrderNo(rawText);
    const orderNoIndex = labels.findIndex((label) => label === orderNo);
    const title = normalizeText(getNodeText(card.querySelector(SELECTORS.orderTitle)));
    const timestamp = normalizeText(getNodeText(card.querySelector(SELECTORS.orderTimestamp)));
    const responsible = normalizeText(getNodeText(card.querySelector(SELECTORS.responsibleText)));
    const shopName = orderNoIndex >= 0 ? labels[orderNoIndex + 1] || "" : "";
    const skuFallback = orderNoIndex > 0 ? labels[orderNoIndex - 1] || "" : "";

    return {
      orderDomId: String(card.id || ""),
      orderNo,
      packageNo: "",
      customerName: title.replace(/\.\.\.$/, "").trim(),
      shopName,
      sku: getSku(rawText) || skuFallback,
      unread: /Unresolved/i.test(rawText),
      updatedText: timestamp,
      responsible,
      rawText
    };
  }

  function isCustomerMessageBlock(block) {
    const rawText = getNodeText(block);

    if (!rawText || rawText.length < CONFIG.minTextLength) {
      return false;
    }

    if (/Approve message|Discard review|Help AI respond better/i.test(rawText)) {
      return false;
    }

    if (block.querySelector('[data-testid^="feedback-"], [title="Approve message"], [title="Discard review"]')) {
      return false;
    }

    if (block.querySelector('img[src*="avatar-user"], img[alt="Avatar"]')) {
      return true;
    }

    return !isPureUiText(rawText);
  }

  function parseMessageBlock(block) {
    const rawText = getNodeText(block);
    const textNode = block.querySelector(SELECTORS.messageText);
    const dateNode = block.querySelector(SELECTORS.messageDate);
    const time = normalizeText(getNodeText(dateNode));
    const text = normalizeText(getNodeText(textNode))
      || normalizeText(rawText.replace(time, ""));

    return {
      text,
      time,
      rawText
    };
  }

  function getLastCustomerMessage() {
    const blocks = Array.from(document.querySelectorAll(SELECTORS.messageBlock));

    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];

      if (isCustomerMessageBlock(block)) {
        return {
          block,
          ...parseMessageBlock(block)
        };
      }
    }

    return null;
  }

  function createMessageFromRight(block, options) {
    const settings = options || {};
    const context = getCurrentConversationContext();
    const parsed = parseMessageBlock(block);
    const rawText = parsed.rawText || context.rawText;
    const orderNo = context.orderNo || getOrderNo(rawText);
    const base = [
      orderNo,
      parsed.text || "",
      parsed.time || "",
      hashString(rawText)
    ].join("|");

    return {
      id: `gobots-after-sale-${orderNo || "unknown"}-${hashString(base)}`,
      type: "gobots_after_sale_customer_message",
      title: "Gobots售后新客户消息",
      orderNo,
      packageNo: context.packageNo,
      customerName: context.customerName,
      shopName: context.shopName,
      sku: context.sku,
      unread: true,
      lastCustomerOriginal: limitText(parsed.text),
      lastCustomerTranslation: "",
      lastCustomerTime: parsed.time,
      detectedAt: getNowString(),
      sourcePage: location.href,
      pageHash: location.hash,
      rawText: limitText(rawText),
      extra: {
        source: "gobots",
        selector: SELECTORS.messageBlock,
        fromRightMessage: true,
        summaryInferred: false,
        reason: settings.reason || "message",
        rawHash: hashString(rawText)
      }
    };
  }

  function createMessageFromCard(card, options) {
    const settings = options || {};
    const cardInfo = parseOrderCard(card);
    const context = getCurrentConversationContext();
    const orderNo = cardInfo.orderNo || context.orderNo || getOrderNo(cardInfo.rawText);
    const rawText = cardInfo.rawText;
    const base = [
      orderNo,
      cardInfo.updatedText || "",
      hashString(rawText)
    ].join("|");

    return {
      id: `gobots-after-sale-summary-${orderNo || "unknown"}-${hashString(base)}`,
      type: "gobots_after_sale_customer_message",
      title: "Gobots售后新客户消息",
      orderNo,
      packageNo: context.orderNo === orderNo ? context.packageNo : cardInfo.packageNo,
      customerName: cardInfo.customerName || (context.orderNo === orderNo ? context.customerName : ""),
      shopName: cardInfo.shopName || (context.orderNo === orderNo ? context.shopName : ""),
      sku: cardInfo.sku || (context.orderNo === orderNo ? context.sku : ""),
      unread: Boolean(cardInfo.unread),
      lastCustomerOriginal: "",
      lastCustomerTranslation: "",
      lastCustomerTime: cardInfo.updatedText,
      detectedAt: getNowString(),
      sourcePage: location.href,
      pageHash: location.hash,
      rawText: limitText(rawText),
      extra: {
        source: "gobots",
        orderDomId: cardInfo.orderDomId,
        selector: SELECTORS.orderCard,
        fromRightMessage: false,
        summaryInferred: true,
        responsible: cardInfo.responsible,
        reason: settings.reason || "left-summary",
        rawHash: hashString(rawText)
      }
    };
  }

  function createDedupeKey(message) {
    const rawHash = (message.extra && message.extra.rawHash) || hashString(message.rawText || "");

    if (message.lastCustomerOriginal) {
      return [
        message.orderNo || "",
        message.lastCustomerOriginal || "",
        message.lastCustomerTime || "",
        rawHash
      ].join("|");
    }

    return [
      message.orderNo || "",
      message.lastCustomerTime || "",
      rawHash
    ].join("|");
  }

  function sendToLocalLog(message, options) {
    const settings = options || {};
    const key = settings.dedupeKey || createDedupeKey(message);

    if (!settings.ignoreDedupe && sentKeys.has(key)) {
      debugLog("skip duplicate", message.id, message.orderNo);
      return;
    }

    debugLog("send", message.id, message.orderNo, message.customerName, message.extra);

    try {
      gmRequest({
        method: "POST",
        url: CONFIG.logApi,
        headers: {
          "Content-Type": "application/json"
        },
        data: JSON.stringify(message),
        timeout: 10000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            if (!settings.skipMarkSent) {
              markSent(key);
            }
            debugLog("logged", message.id, response.status, response.responseText);
            return;
          }

          console.warn(`[${LOG_PREFIX}] POST failed`, response.status, response.responseText, message);
        },
        onerror(error) {
          console.warn(`[${LOG_PREFIX}] POST error`, error, message);
        },
        ontimeout() {
          console.warn(`[${LOG_PREFIX}] POST timeout`, message);
        }
      });
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] POST setup error`, error, message);
    }
  }

  function rememberMessageBlock(block) {
    const message = createMessageFromRight(block, { reason: "initial" });
    const key = createDedupeKey(message);
    messageStateMap.set(key, true);
    markSent(key);
  }

  function processMessageBlock(block, options) {
    const settings = options || {};

    if (!block || !isCustomerMessageBlock(block)) {
      return;
    }

    const message = createMessageFromRight(block, {
      reason: settings.reason || "message"
    });
    let key = createDedupeKey(message);

    if (settings.resend) {
      const suffix = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      message.id = `${message.id}-${suffix}`;
      message.extra.debugResend = true;
      key = `${key}|${suffix}`;
    }

    sendToLocalLog(message, {
      dedupeKey: key,
      ignoreDedupe: Boolean(settings.ignoreDedupe || settings.resend),
      skipMarkSent: Boolean(settings.resend)
    });
  }

  function getCardState(card) {
    const info = parseOrderCard(card);
    const rawWithoutRelativeTime = normalizeText(info.rawText).replace(/Updated\s+.+?\s+ago/ig, "Updated");
    const key = info.orderNo || hashString(info.rawText);

    return {
      key,
      orderNo: info.orderNo,
      updatedText: info.updatedText,
      rawHash: hashString(rawWithoutRelativeTime),
      unresolved: Boolean(info.unread),
      rawText: info.rawText
    };
  }

  function rememberCard(card) {
    const state = getCardState(card);

    if (state.key) {
      cardStateMap.set(state.key, state);
    }

    return state;
  }

  function processCard(card, options) {
    const settings = options || {};

    if (!(card instanceof Element) || !card.matches(SELECTORS.orderCard)) {
      return;
    }

    const current = getCardState(card);
    const previous = current.key ? cardStateMap.get(current.key) : null;
    const shouldSend = settings.force
      || settings.added
      || (previous && current.unresolved && (
        previous.rawHash !== current.rawHash
        || previous.updatedText !== current.updatedText
        || !previous.unresolved
      ));

    rememberCard(card);

    if (!shouldSend || !current.unresolved) {
      return;
    }

    const message = createMessageFromCard(card, {
      reason: settings.reason || (settings.added ? "left-card-added" : "left-card-changed")
    });
    let key = createDedupeKey(message);

    if (settings.resend) {
      const suffix = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      message.id = `${message.id}-${suffix}`;
      message.extra.debugResend = true;
      key = `${key}|${suffix}`;
    }

    sendToLocalLog(message, {
      dedupeKey: key,
      ignoreDedupe: Boolean(settings.ignoreDedupe || settings.resend || settings.force),
      skipMarkSent: Boolean(settings.resend)
    });
  }

  function collectCardsFromNode(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const cards = [];

    if (node.matches(SELECTORS.orderCard)) {
      cards.push(node);
    }

    node.querySelectorAll(SELECTORS.orderCard).forEach((card) => cards.push(card));
    return cards;
  }

  function collectMessageBlocksFromNode(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const blocks = [];

    if (node.matches(SELECTORS.messageBlock)) {
      blocks.push(node);
    }

    node.querySelectorAll(SELECTORS.messageBlock).forEach((block) => blocks.push(block));
    return blocks;
  }

  function getClosestCard(node) {
    if (!(node instanceof Element)) {
      return node && node.parentElement ? node.parentElement.closest(SELECTORS.orderCard) : null;
    }

    return node.matches(SELECTORS.orderCard) ? node : node.closest(SELECTORS.orderCard);
  }

  function initialScan() {
    const cards = Array.from(document.querySelectorAll(SELECTORS.orderCard));
    const customerBlocks = Array.from(document.querySelectorAll(SELECTORS.messageBlock)).filter(isCustomerMessageBlock);

    cards.forEach((card) => {
      rememberCard(card);

      if (CONFIG.logExistingOnFirstRun) {
        processCard(card, {
          force: true,
          reason: "initial-left-card"
        });
      }
    });

    customerBlocks.forEach((block) => {
      if (CONFIG.logExistingOnFirstRun) {
        processMessageBlock(block, {
          reason: "initial-message"
        });
      } else {
        rememberMessageBlock(block);
      }
    });

    debugLog(`initialScan tracked ${cards.length} cards and ${customerBlocks.length} customer messages`);
  }

  function scheduleCardChangeScan(cards, reason) {
    if (mutationTimer) {
      clearTimeout(mutationTimer);
    }

    mutationTimer = setTimeout(() => {
      cards.forEach((card) => {
        processCard(card, {
          reason
        });
      });
    }, CONFIG.mutationDebounceMs);
  }

  function startOrderListObserver(orderList) {
    if (orderListObserver) {
      orderListObserver.disconnect();
    }

    orderListObserver = new MutationObserver((mutations) => {
      const changedCards = new Set();

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          collectCardsFromNode(node).forEach((card) => {
            processCard(card, {
              added: true,
              reason: "left-card-added"
            });
          });
        });

        const card = getClosestCard(mutation.target);

        if (card) {
          changedCards.add(card);
        }
      });

      if (changedCards.size > 0) {
        scheduleCardChangeScan(changedCards, "left-card-mutated");
      }
    });

    orderListObserver.observe(orderList, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    debugLog("found order list");
  }

  function startMessageObserver(messagesContainer) {
    if (messageObserver) {
      messageObserver.disconnect();
    }

    messageObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          collectMessageBlocksFromNode(node).forEach((block) => {
            processMessageBlock(block, {
              reason: "message-added"
            });
          });
        });
      });
    });

    messageObserver.observe(messagesContainer, {
      childList: true,
      subtree: true
    });

    debugLog("found messages container");
  }

  function startStateScanTimer() {
    if (stateScanTimer) {
      clearInterval(stateScanTimer);
    }

    stateScanTimer = setInterval(() => {
      if (!isTargetPage()) {
        return;
      }

      Array.from(document.querySelectorAll(SELECTORS.orderCard)).forEach((card) => {
        processCard(card, {
          reason: "periodic-card-scan"
        });
      });

      const last = getLastCustomerMessage();

      if (last && last.block) {
        processMessageBlock(last.block, {
          reason: "periodic-last-message"
        });
      }
    }, CONFIG.stateScanIntervalMs);
  }

  function checkHealth() {
    try {
      gmRequest({
        method: "GET",
        url: CONFIG.healthApi,
        timeout: 5000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            debugLog("health ok", response.responseText);
            return;
          }

          console.warn(`[${LOG_PREFIX}] health check failed`, response.status, response.responseText);
        },
        onerror(error) {
          console.warn(`[${LOG_PREFIX}] health check error. Is the local service running?`, error);
        },
        ontimeout() {
          console.warn(`[${LOG_PREFIX}] health check timeout. Is the local service running?`);
        }
      });
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] health check setup error`, error);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function findElementWithRetry(selector, token, required) {
    for (let attempt = 1; attempt <= CONFIG.maxFindAttempts; attempt += 1) {
      if (token !== runToken || !isTargetPage()) {
        return null;
      }

      const element = document.querySelector(selector);

      if (element) {
        debugLog(`found ${selector} on attempt ${attempt}`);
        return element;
      }

      await sleep(CONFIG.retryIntervalMs);
    }

    if (required) {
      console.warn(`[${LOG_PREFIX}] cannot find ${selector}`);
    }

    return null;
  }

  function stopObservers() {
    runToken += 1;

    if (orderListObserver) {
      orderListObserver.disconnect();
      orderListObserver = null;
    }

    if (messageObserver) {
      messageObserver.disconnect();
      messageObserver = null;
    }

    if (stateScanTimer) {
      clearInterval(stateScanTimer);
      stateScanTimer = null;
    }

    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }

    isStarted = false;
    isStarting = false;
    debugLog("stopped observers");
  }

  async function startIfTargetPage() {
    if (isStarted || isStarting) {
      return;
    }

    if (!isTargetPage()) {
      debugLog("not target page, skip start", location.href);
      return;
    }

    isStarting = true;
    const token = ++runToken;

    await ensureStorageLoaded();
    checkHealth();

    try {
      const page = await findElementWithRetry(SELECTORS.page, token, true);
      const orderList = await findElementWithRetry(SELECTORS.orderList, token, true);
      const messagesContainer = await findElementWithRetry(SELECTORS.messagesContainer, token, false);

      if (token !== runToken || !isTargetPage()) {
        return;
      }

      if (!page || !orderList) {
        return;
      }

      initialScan();
      startOrderListObserver(orderList);

      if (messagesContainer) {
        startMessageObserver(messagesContainer);
      }

      startStateScanTimer();
      isStarted = true;
      console.log(`${LOG_PREFIX} started`);
    } finally {
      isStarting = false;
    }
  }

  async function debugScanCurrentPage(options) {
    const settings = options || {};

    await ensureStorageLoaded();

    const cards = Array.from(document.querySelectorAll(SELECTORS.orderCard));
    const blocks = Array.from(document.querySelectorAll(SELECTORS.messageBlock)).filter(isCustomerMessageBlock);

    cards.forEach((card) => {
      processCard(card, {
        force: Boolean(settings.force),
        resend: Boolean(settings.resend),
        ignoreDedupe: Boolean(settings.ignoreDedupe || settings.resend || settings.force),
        reason: settings.reason || "debug-card-scan"
      });
    });

    blocks.forEach((block) => {
      processMessageBlock(block, {
        resend: Boolean(settings.resend),
        ignoreDedupe: Boolean(settings.ignoreDedupe || settings.resend || settings.force),
        reason: settings.reason || "debug-message-scan"
      });
    });

    return {
      success: true,
      cards: cards.length,
      customerMessages: blocks.length,
      force: Boolean(settings.force),
      resend: Boolean(settings.resend)
    };
  }

  function clearLocalDedupe() {
    sentKeyList = [];
    sentKeys = new Set();
    storageLoaded = true;
    persistDedupeKeys();
    return {
      success: true
    };
  }

  function getStatus() {
    return {
      isTargetPage: isTargetPage(),
      isStarted,
      isStarting,
      hasOrderListObserver: Boolean(orderListObserver),
      hasMessageObserver: Boolean(messageObserver),
      hasStateScanTimer: Boolean(stateScanTimer),
      pageFound: Boolean(document.querySelector(SELECTORS.page)),
      orderListFound: Boolean(document.querySelector(SELECTORS.orderList)),
      messagesContainerFound: Boolean(document.querySelector(SELECTORS.messagesContainer)),
      orderCardCount: document.querySelectorAll(SELECTORS.orderCard).length,
      messageBlockCount: document.querySelectorAll(SELECTORS.messageBlock).length,
      customerMessageCount: Array.from(document.querySelectorAll(SELECTORS.messageBlock)).filter(isCustomerMessageBlock).length,
      trackedCardCount: cardStateMap.size,
      sentKeyCount: sentKeys.size,
      locationHref: location.href
    };
  }

  const debugApi = {
    status: getStatus,
    checkHealth,
    scanCurrentPage: debugScanCurrentPage,
    resendCurrentPage: () => debugScanCurrentPage({ force: true, resend: true }),
    clearLocalDedupe,
    start: startIfTargetPage,
    stop: stopObservers
  };

  window.GobotsAfterSaleLoggerDebug = debugApi;
  debugWindow.GobotsAfterSaleLoggerDebug = debugApi;

  window.addEventListener("hashchange", () => {
    stopObservers();
    setTimeout(() => startIfTargetPage(), CONFIG.retryIntervalMs);
  });

  setTimeout(() => {
    startIfTargetPage();
  }, CONFIG.scanDelayMs);
})();
