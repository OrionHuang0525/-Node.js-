// ==UserScript==
// @name         Sales Consultation Local Logger
// @namespace    sanstar.local
// @version      1.1.0
// @description  监听售后待回复消息，并写入本机 TXT 日志
// @match        https://shengji.lingdongsz.com/uranus/*
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
    targetHash: "/afterMessage/salesConsultation",
    logApi: "http://127.0.0.1:3107/log-message",
    healthApi: "http://127.0.0.1:3107/health",
    replyPollApi: "http://127.0.0.1:3107/reply-actions/poll?source=sales-consultation",
    replyReportApiBase: "http://127.0.0.1:3107/reply-actions",
    scanDelayMs: 3000,
    restartDelayMs: 1500,
    replyPollIntervalMs: 5000,
    minTextLength: 8,
    maxTextLength: 50000,
    dedupeStorageKey: "sales_message_logger_sent_keys_v1",
    maxDedupeKeys: 1000,
    logExistingOnFirstRun: false,
    stateScanIntervalMs: 10000,
    debug: true
  };

  const LOG_PREFIX = "Sales Consultation Local Logger";
  const FIELD_LABELS = [
    "订单编号",
    "包裹编号",
    "客户名",
    "店铺名",
    "SKU",
    "商品名称",
    "货品名称",
    "买家账号",
    "订单状态",
    "消息时间",
    "创建时间",
    "数量"
  ];
  const UI_TEXTS = [
    "加载更多",
    "查询",
    "翻译",
    "发送",
    "发送且已读",
    "不再提醒",
    "快捷回复",
    "附件",
    "创建消息",
    "不能发送空白消息",
    "不能翻译空白消息",
    "确定",
    "取消",
    "保存",
    "关闭",
    "搜索",
    "重置",
    "刷新页面",
    "关闭当前",
    "关闭其他",
    "关闭右侧",
    "关闭所有"
  ];

  let orderListObserver = null;
  let chatHistoryObserver = null;
  let isStarted = false;
  let isStarting = false;
  let runToken = 0;
  let currentChatContext = null;
  let orderStateScanTimer = null;
  let replyPollTimer = null;
  let activeReplyApprovalId = "";
  let replyConfirmOverlay = null;

  const debugWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const observerAddedOrderNodes = new WeakSet();
  const orderStateMap = new Map();
  let sentKeyList = [];
  let sentKeys = new Set();
  let dedupeStorageLoaded = false;

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

  function gmJsonRequest(details) {
    return new Promise((resolve, reject) => {
      try {
        gmRequest({
          method: details.method || "GET",
          url: details.url,
          headers: details.headers || {},
          data: details.data,
          timeout: details.timeout || 10000,
          onload(response) {
            let parsed = null;

            try {
              parsed = JSON.parse(response.responseText || "{}");
            } catch (error) {
              parsed = null;
            }

            if (response.status >= 200 && response.status < 300) {
              resolve(parsed || {});
              return;
            }

            reject(new Error((parsed && parsed.message) || `HTTP ${response.status}`));
          },
          onerror(error) {
            reject(error instanceof Error ? error : new Error("GM request error"));
          },
          ontimeout() {
            reject(new Error("GM request timeout"));
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function isTargetPage() {
    return location.hostname === "shengji.lingdongsz.com"
      && location.pathname.startsWith("/uranus/")
      && location.hash.includes(CONFIG.targetHash);
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function getTodayString() {
    const now = new Date();
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate())
    ].join("-");
  }

  function getNowString() {
    const now = new Date();
    return `${getTodayString()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
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

  function escapeRegExp(input) {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getNodeText(node) {
    return String((node && (node.innerText || node.textContent)) || "").trim();
  }

  function limitText(text) {
    const value = String(text || "");

    if (value.length <= CONFIG.maxTextLength) {
      return value;
    }

    return `${value.slice(0, CONFIG.maxTextLength)}\n...[truncated]`;
  }

  function extractOrderNoFromRawText(rawText) {
    const match = String(rawText || "").match(/订单编号\s*[:：]\s*([0-9]+)/);
    return match ? match[1] : "";
  }

  function extractField(rawText, label, stopLabels) {
    const text = normalizeText(rawText);
    const stops = (stopLabels || FIELD_LABELS)
      .filter((item) => item !== label)
      .map(escapeRegExp)
      .join("|");
    const pattern = stops
      ? `${escapeRegExp(label)}\\s*[:：]\\s*([\\s\\S]*?)(?=\\s*(?:${stops})\\s*[:：]|$)`
      : `${escapeRegExp(label)}\\s*[:：]\\s*([\\s\\S]*)$`;
    const match = text.match(new RegExp(pattern));

    return match ? normalizeText(match[1]) : "";
  }

  function stripFieldLabel(text, label) {
    return normalizeText(text).replace(new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*`), "");
  }

  function parseOrderItem(li) {
    const rawText = getNodeText(li);
    const orderDomId = String((li && li.id) || "");
    const orderIdMatch = orderDomId.match(/order\s*([0-9]+)/i);
    const orderNo = orderIdMatch ? orderIdMatch[1] : extractOrderNoFromRawText(rawText);
    const packageMatch = rawText.match(/包裹编号\s*[:：]\s*([0-9]+)/);
    const packageNo = packageMatch ? packageMatch[1] : "";
    const customerNode = li ? li.querySelector(".order-title .mt4") : null;
    const customerFromNode = customerNode ? stripFieldLabel(getNodeText(customerNode), "客户名") : "";
    const customerName = customerFromNode || extractField(rawText, "客户名");
    const shopName = extractField(rawText, "店铺名", ["SKU", "订单编号", "包裹编号", "客户名", "商品名称", "货品名称", "消息时间", "创建时间"]);
    const sku = extractField(rawText, "SKU", ["订单编号", "包裹编号", "客户名", "店铺名", "商品名称", "货品名称", "数量", "买家账号", "订单状态", "消息时间", "创建时间"]);

    return {
      orderDomId,
      orderNo,
      packageNo,
      customerName,
      shopName,
      sku,
      unread: Boolean(li && li.querySelector("i.not-read")),
      rawText
    };
  }

  function compactText(text) {
    return normalizeText(text).replace(/\s+/g, "");
  }

  function shouldIgnoreText(text) {
    const compact = compactText(text);

    if (!compact) {
      return true;
    }

    const ignoredCompacts = UI_TEXTS.map(compactText);

    if (ignoredCompacts.includes(compact)) {
      return true;
    }

    const remainder = ignoredCompacts.reduce((current, ignored) => current.split(ignored).join(""), compact);
    return remainder.length === 0;
  }

  function isLoadMoreText(text) {
    const compact = compactText(text);
    return compact === "加载更多" || (compact.includes("加载更多") && compact.length <= 12);
  }

  function isTrackableOrderItem(orderInfo, li) {
    if (!(li instanceof Element)) {
      return false;
    }

    if (!li.matches("li.orders-body")) {
      return false;
    }

    if (!orderInfo || !orderInfo.rawText || !orderInfo.rawText.trim()) {
      return false;
    }

    if (orderInfo.rawText.length < CONFIG.minTextLength) {
      return false;
    }

    if (isLoadMoreText(orderInfo.rawText) || shouldIgnoreText(orderInfo.rawText)) {
      return false;
    }

    return Boolean(orderInfo.orderNo || extractOrderNoFromRawText(orderInfo.rawText));
  }

  function shouldLogOrderItem(orderInfo, li) {
    if (!isTrackableOrderItem(orderInfo, li)) {
      return false;
    }

    return Boolean(orderInfo.unread || observerAddedOrderNodes.has(li));
  }

  function getOrderStateKey(orderInfo) {
    return orderInfo.orderNo || orderInfo.orderDomId || hashString(orderInfo.rawText || "");
  }

  function getOrderState(orderInfo) {
    return {
      key: getOrderStateKey(orderInfo),
      unread: Boolean(orderInfo.unread),
      rawHash: hashString(orderInfo.rawText || ""),
      rawLength: String(orderInfo.rawText || "").length
    };
  }

  function rememberOrderState(orderInfo) {
    const state = getOrderState(orderInfo);

    if (state.key) {
      orderStateMap.set(state.key, state);
    }

    return state;
  }

  function shouldLogOrderStateChange(orderInfo) {
    if (!orderInfo || !orderInfo.unread) {
      return false;
    }

    const state = getOrderState(orderInfo);
    const previous = state.key ? orderStateMap.get(state.key) : null;

    if (!previous) {
      rememberOrderState(orderInfo);
      return false;
    }

    const becameUnread = !previous.unread && state.unread;
    const unreadTextChanged = previous.unread && state.unread && previous.rawHash !== state.rawHash;

    rememberOrderState(orderInfo);
    return becameUnread || unreadTextChanged;
  }

  function getCurrentChatContext() {
    const chatNameNode = document.querySelector(".message-left .chat-name p");
    const chatNameText = normalizeText(chatNameNode ? chatNameNode.textContent : "");
    const chatNameMatch = chatNameText.match(/客户名\s*[:：]\s*(.+)$/);
    const chatCustomerName = chatNameMatch ? normalizeText(chatNameMatch[1]) : "";
    const customerMessages = Array.from(document.querySelectorAll(".chat-history .custom-body"));
    const lastCustomerMessage = customerMessages[customerMessages.length - 1];

    if (!lastCustomerMessage) {
      currentChatContext = {
        chatCustomerName,
        lastCustomerOriginal: "",
        lastCustomerTranslation: "",
        lastCustomerTime: "",
        lastMessageRawText: ""
      };

      return currentChatContext;
    }

    let lastCustomerOriginal = "";
    let lastCustomerTranslation = "";
    let activeTitle = "";
    const contentNodes = Array.from(lastCustomerMessage.querySelectorAll(".content-title, .content-body"));

    contentNodes.forEach((node) => {
      if (node.matches(".content-title")) {
        activeTitle = normalizeText(node.textContent).replace(/[：:]\s*$/, "");
        return;
      }

      if (!node.matches(".content-body")) {
        return;
      }

      if (activeTitle === "原文") {
        lastCustomerOriginal = normalizeText(node.textContent);
      }

      if (activeTitle === "译文") {
        lastCustomerTranslation = normalizeText(node.textContent);
      }
    });

    const timeNode = lastCustomerMessage.querySelector(".content-time span") || lastCustomerMessage.querySelector(".content-time");
    const lastCustomerTime = normalizeText(timeNode ? timeNode.textContent : "");
    const lastMessageRawText = getNodeText(lastCustomerMessage);

    currentChatContext = {
      chatCustomerName,
      lastCustomerOriginal,
      lastCustomerTranslation,
      lastCustomerTime,
      lastMessageRawText
    };

    return currentChatContext;
  }

  function normalizeNameForCompare(name) {
    return normalizeText(name)
      .toLocaleLowerCase()
      .replace(/[\s：:._-]+/g, "");
  }

  function shouldAttachChatContext(orderInfo, li, chatContext) {
    if (!(li instanceof Element) || !li.matches("li.orders-body.active-option")) {
      return false;
    }

    const orderCustomerName = normalizeNameForCompare(orderInfo.customerName);
    const chatCustomerName = normalizeNameForCompare(chatContext.chatCustomerName);

    if (orderCustomerName && chatCustomerName && orderCustomerName !== chatCustomerName) {
      debugLog("skip chat context because customer name does not match", {
        orderCustomerName: orderInfo.customerName,
        chatCustomerName: chatContext.chatCustomerName,
        orderNo: orderInfo.orderNo
      });
      return false;
    }

    return true;
  }

  function createDedupeKey(message) {
    return [
      message.orderNo || "",
      message.rawText || ""
    ].join("|");
  }

  function buildMessage(orderInfo, li) {
    const chatContext = getCurrentChatContext();
    const attachChatContext = shouldAttachChatContext(orderInfo, li, chatContext);
    const lastCustomerOriginal = attachChatContext ? chatContext.lastCustomerOriginal : "";
    const lastCustomerTranslation = attachChatContext ? chatContext.lastCustomerTranslation : "";
    const lastCustomerTime = attachChatContext ? chatContext.lastCustomerTime : "";
    const orderNo = orderInfo.orderNo || extractOrderNoFromRawText(orderInfo.rawText);
    const base = [
      orderNo,
      orderInfo.rawText || ""
    ].join("|");
    const id = `after-sales-${orderNo || "unknown"}-${hashString(base)}`;

    return {
      id,
      type: "after_sales_pending_reply",
      title: "售后待回复消息",
      orderNo,
      packageNo: orderInfo.packageNo,
      customerName: orderInfo.customerName || (attachChatContext ? chatContext.chatCustomerName : "") || "",
      shopName: orderInfo.shopName,
      sku: orderInfo.sku,
      unread: Boolean(orderInfo.unread),
      lastCustomerOriginal: limitText(lastCustomerOriginal),
      lastCustomerTranslation: limitText(lastCustomerTranslation),
      lastCustomerTime,
      detectedAt: getNowString(),
      sourcePage: location.href,
      pageHash: location.hash,
      rawText: limitText(orderInfo.rawText),
      extra: {
        orderDomId: orderInfo.orderDomId,
        selector: "li.orders-body",
        orderIsActive: Boolean(li instanceof Element && li.matches("li.orders-body.active-option")),
        chatCustomerName: chatContext.chatCustomerName,
        chatAttached: attachChatContext
      }
    };
  }

  function parseStoredDedupeKeys(stored) {
    if (Array.isArray(stored)) {
      return stored.filter((item) => typeof item === "string");
    }

    if (typeof stored === "string") {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    }

    return [];
  }

  async function loadStoredDedupeKeys() {
    try {
      const stored = gmGetValue(CONFIG.dedupeStorageKey, []);
      return parseStoredDedupeKeys(isPromiseLike(stored) ? await stored : stored);
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] Failed to load stored dedupe keys:`, error);
    }

    return [];
  }

  async function ensureDedupeStorageLoaded() {
    if (dedupeStorageLoaded) {
      return;
    }

    sentKeyList = await loadStoredDedupeKeys();
    sentKeys = new Set(sentKeyList);
    dedupeStorageLoaded = true;
    debugLog(`loaded ${sentKeyList.length} dedupe keys from userscript storage`);
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

  function markSent(dedupeKey) {
    if (!dedupeKey || sentKeys.has(dedupeKey)) {
      return;
    }

    sentKeys.add(dedupeKey);
    sentKeyList.push(dedupeKey);

    while (sentKeyList.length > CONFIG.maxDedupeKeys) {
      const removed = sentKeyList.shift();
      sentKeys.delete(removed);
    }

    persistDedupeKeys();
  }

  function hasSent(dedupeKey) {
    return sentKeys.has(dedupeKey);
  }

  function sendToLocalLog(message, dedupeKey, options) {
    const settings = options || {};

    if (!settings.ignoreDedupe && hasSent(dedupeKey)) {
      debugLog("skip duplicate", message.id, message.orderNo, message.customerName);
      return;
    }

    debugLog("send", message.id, message.orderNo, message.customerName, message);

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
            markSent(dedupeKey);
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

  function isVisibleElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function findReplyEditor() {
    const selectors = [
      ".consultation-right textarea:not([readonly])",
      ".consultation-right .el-textarea__inner:not([readonly])",
      ".consultation-right [contenteditable='true']",
      ".consultation-right input:not([readonly])",
      "textarea:not([readonly])",
      "[contenteditable='true']"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const node = nodes.find((item) => isVisibleElement(item) && !item.disabled);

      if (node) {
        return node;
      }
    }

    return null;
  }

  function findSendButton() {
    const buttons = Array.from(document.querySelectorAll(".consultation-right button, .consultation-right .el-button, button"));
    return buttons.find((button) => {
      const text = normalizeText(button.innerText || button.textContent);
      const disabled = button.disabled
        || button.getAttribute("aria-disabled") === "true"
        || button.classList.contains("is-disabled");

      return isVisibleElement(button)
        && !disabled
        && (text === "发送" || text === "发送且已读");
    }) || null;
  }

  function setEditorValue(editor, text) {
    const value = String(text || "");

    editor.focus();

    if (editor.isContentEditable) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const prototype = editor.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && descriptor.set) {
      descriptor.set.call(editor, value);
    } else {
      editor.value = value;
    }

    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function reportReplyAction(approvalId, status, detail, error) {
    return gmJsonRequest({
      method: "POST",
      url: `${CONFIG.replyReportApiBase}/${encodeURIComponent(approvalId)}/report`,
      headers: {
        "Content-Type": "application/json"
      },
      data: JSON.stringify({
        status,
        pageUrl: location.href,
        detail: detail || "",
        error: error || ""
      }),
      timeout: 10000
    }).catch((requestError) => {
      console.warn(`[${LOG_PREFIX}] reply action report failed`, status, requestError);
    });
  }

  function activeOrderMatchesReplyAction(action) {
    const activeLi = document.querySelector("li.orders-body.active-option");

    if (!activeLi) {
      return {
        ok: false,
        reason: "active-order-not-found"
      };
    }

    const orderInfo = parseOrderItem(activeLi);
    const orderMatches = action.orderNo && orderInfo.orderNo === action.orderNo;
    const actionCustomer = normalizeNameForCompare(action.customerName);
    const orderCustomer = normalizeNameForCompare(orderInfo.customerName);
    const customerMatches = !actionCustomer || !orderCustomer || actionCustomer === orderCustomer;

    if (!orderMatches) {
      return {
        ok: false,
        reason: `order-mismatch current=${orderInfo.orderNo || "-"} expected=${action.orderNo || "-"}`
      };
    }

    if (!customerMatches) {
      return {
        ok: false,
        reason: `customer-mismatch current=${orderInfo.customerName || "-"} expected=${action.customerName || "-"}`
      };
    }

    return {
      ok: true,
      orderInfo
    };
  }

  function closeReplyOverlay() {
    if (replyConfirmOverlay && replyConfirmOverlay.parentNode) {
      replyConfirmOverlay.parentNode.removeChild(replyConfirmOverlay);
    }

    replyConfirmOverlay = null;
    activeReplyApprovalId = "";
  }

  function showReplyConfirmOverlay(action, editor, sendButton) {
    closeReplyOverlay();

    const overlay = document.createElement("div");
    overlay.id = "sales-message-logger-reply-confirm";
    overlay.innerHTML = `
      <div class="sml-backdrop"></div>
      <div class="sml-panel">
        <h3>确认发送售后回复</h3>
        <p>订单编号：${action.orderNo || "-"}</p>
        <p>客户名：${action.customerName || "-"}</p>
        <label>建议回复，可在发送前修改</label>
        <textarea class="sml-reply-text"></textarea>
        <div class="sml-error" aria-live="polite"></div>
        <div class="sml-actions">
          <button type="button" class="sml-send">确认发送</button>
          <button type="button" class="sml-cancel">取消</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #sales-message-logger-reply-confirm { position: fixed; inset: 0; z-index: 2147483647; font-family: "Microsoft YaHei", Arial, sans-serif; }
      #sales-message-logger-reply-confirm .sml-backdrop { position: absolute; inset: 0; background: rgba(15, 23, 42, .38); }
      #sales-message-logger-reply-confirm .sml-panel { position: absolute; right: 24px; bottom: 24px; width: min(560px, calc(100vw - 48px)); background: #fff; border: 1px solid #d8dee8; border-radius: 8px; box-shadow: 0 20px 50px rgba(15,23,42,.22); padding: 18px; color: #1f2937; }
      #sales-message-logger-reply-confirm h3 { margin: 0 0 10px; font-size: 18px; }
      #sales-message-logger-reply-confirm p { margin: 4px 0; font-size: 14px; }
      #sales-message-logger-reply-confirm label { display: block; margin: 12px 0 6px; font-weight: 600; font-size: 14px; }
      #sales-message-logger-reply-confirm textarea { width: 100%; min-height: 150px; resize: vertical; border: 1px solid #cfd6e4; border-radius: 6px; padding: 10px; font-size: 14px; line-height: 1.5; }
      #sales-message-logger-reply-confirm .sml-error { min-height: 20px; margin-top: 8px; color: #b42318; font-size: 13px; }
      #sales-message-logger-reply-confirm .sml-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
      #sales-message-logger-reply-confirm button { min-height: 36px; padding: 0 14px; border-radius: 6px; border: 1px solid #1664ff; cursor: pointer; }
      #sales-message-logger-reply-confirm .sml-send { background: #1664ff; color: #fff; }
      #sales-message-logger-reply-confirm .sml-cancel { background: #fff; color: #1664ff; }
    `;
    overlay.appendChild(style);
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector(".sml-reply-text");
    const errorNode = overlay.querySelector(".sml-error");
    textarea.value = action.suggestedReply || "";
    textarea.focus();

    overlay.querySelector(".sml-cancel").addEventListener("click", () => {
      reportReplyAction(action.approvalId, "CANCELED", "cancelled in page overlay");
      closeReplyOverlay();
    });

    overlay.querySelector(".sml-send").addEventListener("click", () => {
      const finalText = textarea.value.trim();

      if (!finalText) {
        errorNode.textContent = "回复内容不能为空。";
        return;
      }

      const match = activeOrderMatchesReplyAction(action);

      if (!match.ok) {
        errorNode.textContent = `当前选中订单不匹配，已阻止发送：${match.reason}`;
        return;
      }

      setEditorValue(editor, finalText);
      sendButton.click();
      reportReplyAction(action.approvalId, "SENT", "sent after page second confirmation");
      closeReplyOverlay();
    });

    replyConfirmOverlay = overlay;
  }

  async function handleApprovedReplyAction(action) {
    if (!isTargetPage() || activeReplyApprovalId || replyConfirmOverlay) {
      return;
    }

    const match = activeOrderMatchesReplyAction(action);

    if (!match.ok) {
      debugLog("approved reply waiting for matching active order", action.approvalId, match.reason);
      return;
    }

    const editor = findReplyEditor();
    const sendButton = findSendButton();

    if (!editor || !sendButton) {
      await reportReplyAction(action.approvalId, "FAILED", "", `reply editor or send button not found. editor=${Boolean(editor)} sendButton=${Boolean(sendButton)}`);
      return;
    }

    activeReplyApprovalId = action.approvalId;
    setEditorValue(editor, action.suggestedReply || "");
    await reportReplyAction(action.approvalId, "FILLED_DRAFT", "draft filled, waiting for page second confirmation");
    showReplyConfirmOverlay(action, editor, sendButton);
  }

  async function pollReplyActions() {
    if (!isTargetPage()) {
      return;
    }

    try {
      const data = await gmJsonRequest({
        method: "GET",
        url: CONFIG.replyPollApi,
        timeout: 8000
      });

      const actions = Array.isArray(data.actions) ? data.actions : [];

      if (!actions.length) {
        return;
      }

      await handleApprovedReplyAction(actions[0]);
    } catch (error) {
      debugLog("reply action poll failed", error.message || error);
    }
  }

  function startReplyActionPollTimer() {
    if (replyPollTimer) {
      clearInterval(replyPollTimer);
    }

    replyPollTimer = setInterval(() => {
      pollReplyActions();
    }, CONFIG.replyPollIntervalMs);
    pollReplyActions();
  }

  function processOrderItem(li, options) {
    const settings = options || {};
    const orderInfo = parseOrderItem(li);
    const canLog = settings.forceLog
      ? isTrackableOrderItem(orderInfo, li)
      : shouldLogOrderItem(orderInfo, li);

    if (!canLog) {
      debugLog("skip order item", orderInfo);
      return;
    }

    const message = buildMessage(orderInfo, li);
    let dedupeKey = createDedupeKey(message);

    if (settings.resend) {
      const suffix = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      message.id = `${message.id}-${suffix}`;
      message.extra.debugResend = true;
      message.extra.debugReason = settings.reason || "resend";
      dedupeKey = `${dedupeKey}|${suffix}`;
    }

    if (!settings.ignoreDedupe && hasSent(dedupeKey)) {
      debugLog("skip existing dedupe key", message.id);
      return;
    }

    sendToLocalLog(message, dedupeKey, {
      ignoreDedupe: Boolean(settings.ignoreDedupe),
      skipMarkSent: Boolean(settings.resend)
    });
  }

  function initialScan(orderWrap) {
    const items = Array.from(orderWrap.querySelectorAll("li.orders-body"));
    let trackedCount = 0;
    let sentCount = 0;

    items.forEach((li) => {
      const orderInfo = parseOrderItem(li);

      if (!isTrackableOrderItem(orderInfo, li)) {
        return;
      }

      rememberOrderState(orderInfo);
      const message = buildMessage(orderInfo, li);
      const dedupeKey = createDedupeKey(message);
      trackedCount += 1;

      if (CONFIG.logExistingOnFirstRun) {
        if (!hasSent(dedupeKey)) {
          sendToLocalLog(message, dedupeKey);
          sentCount += 1;
        }

        return;
      }

      markSent(dedupeKey);
    });

    debugLog(`initialScan tracked ${trackedCount} order items, sent ${sentCount}`);
  }

  function collectOrderItemsFromAddedNode(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const items = [];

    if (node.matches("li.orders-body")) {
      items.push(node);
    }

    node.querySelectorAll("li.orders-body").forEach((item) => {
      items.push(item);
    });

    return items;
  }

  function collectOrderItemFromMutationTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    if (target.matches("li.orders-body")) {
      return target;
    }

    return target.closest("li.orders-body");
  }

  function processOrderStateChange(li, reason) {
    const orderInfo = parseOrderItem(li);

    if (!isTrackableOrderItem(orderInfo, li)) {
      return;
    }

    if (!shouldLogOrderStateChange(orderInfo)) {
      return;
    }

    debugLog("order state changed", reason, orderInfo.orderNo, orderInfo.customerName);
    observerAddedOrderNodes.add(li);
    processOrderItem(li, {
      forceLog: true,
      ignoreDedupe: true,
      resend: true,
      reason: reason || "state-change"
    });
  }

  function scanOrderStateChanges(reason) {
    const orderWrap = document.querySelector("ul.order-wrap");

    if (!orderWrap) {
      return;
    }

    Array.from(orderWrap.querySelectorAll("li.orders-body")).forEach((li) => {
      processOrderStateChange(li, reason || "periodic-scan");
    });
  }

  function startOrderStateScanTimer() {
    if (orderStateScanTimer) {
      clearInterval(orderStateScanTimer);
    }

    orderStateScanTimer = setInterval(() => {
      if (!isTargetPage()) {
        return;
      }

      scanOrderStateChanges("periodic-scan");
    }, CONFIG.stateScanIntervalMs);
  }

  function startOrderListObserver(orderWrap) {
    if (orderListObserver) {
      orderListObserver.disconnect();
    }

    orderListObserver = new MutationObserver((mutations) => {
      const changedItems = new Set();

      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          collectOrderItemsFromAddedNode(node).forEach((li) => {
            observerAddedOrderNodes.add(li);
            rememberOrderState(parseOrderItem(li));
            processOrderItem(li);
          });
        });

        if (mutation.type === "attributes" || mutation.type === "characterData" || mutation.type === "childList") {
          const targetItem = collectOrderItemFromMutationTarget(mutation.target);

          if (targetItem) {
            changedItems.add(targetItem);
          }
        }
      });

      changedItems.forEach((li) => {
        processOrderStateChange(li, "mutation");
      });
    });

    orderListObserver.observe(orderWrap, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    startOrderStateScanTimer();
    console.log(`[${LOG_PREFIX}] found ul.order-wrap`);
  }

  function startChatHistoryObserver(chatHistory) {
    if (chatHistoryObserver) {
      chatHistoryObserver.disconnect();
    }

    currentChatContext = getCurrentChatContext();
    chatHistoryObserver = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.addedNodes && mutation.addedNodes.length > 0)) {
        return;
      }

      currentChatContext = getCurrentChatContext();
      debugLog("updated chat context", currentChatContext);
    });

    chatHistoryObserver.observe(chatHistory, {
      childList: true,
      subtree: true
    });

    console.log(`[${LOG_PREFIX}] found .chat-history`);
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
        console.warn(`[${LOG_PREFIX}] health check error. Is npm start running?`, error);
      },
      ontimeout() {
        console.warn(`[${LOG_PREFIX}] health check timeout. Is npm start running?`);
      }
      });
    } catch (error) {
      console.warn(`[${LOG_PREFIX}] health check setup error. Is userscript manager granting GM_xmlhttpRequest?`, error);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function findElementWithRetry(selector, maxTries, intervalMs, token) {
    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
      if (token !== runToken || !isTargetPage()) {
        return null;
      }

      const element = document.querySelector(selector);

      if (element) {
        debugLog(`found ${selector} on attempt ${attempt}`);
        return element;
      }

      debugLog(`waiting for ${selector}, attempt ${attempt}/${maxTries}`);
      await sleep(intervalMs);
    }

    console.warn(`[${LOG_PREFIX}] cannot find ${selector} after ${maxTries} attempts`);
    return null;
  }

  function getStatus() {
    return {
      isTargetPage: isTargetPage(),
      isStarted,
      isStarting,
      hasOrderListObserver: Boolean(orderListObserver),
      hasChatHistoryObserver: Boolean(chatHistoryObserver),
      orderWrapFound: Boolean(document.querySelector("ul.order-wrap")),
      chatHistoryFound: Boolean(document.querySelector(".chat-history")),
      orderCount: document.querySelectorAll("ul.order-wrap li.orders-body").length,
      activeOrderCount: document.querySelectorAll("ul.order-wrap li.orders-body.active-option").length,
      dedupeStorageLoaded,
      sentKeyCount: sentKeys.size,
      trackedOrderStateCount: orderStateMap.size,
      hasOrderStateScanTimer: Boolean(orderStateScanTimer),
      hasReplyPollTimer: Boolean(replyPollTimer),
      activeReplyApprovalId,
      hasReplyConfirmOverlay: Boolean(replyConfirmOverlay),
      locationHref: location.href
    };
  }

  async function debugScanCurrentList(options) {
    const settings = options || {};

    await ensureDedupeStorageLoaded();

    const orderWrap = document.querySelector("ul.order-wrap");

    if (!orderWrap) {
      console.warn(`[${LOG_PREFIX}] debugScanCurrentList cannot find ul.order-wrap`);
      return {
        success: false,
        reason: "order-wrap-not-found"
      };
    }

    let scanned = 0;
    let attempted = 0;

    Array.from(orderWrap.querySelectorAll("li.orders-body")).forEach((li) => {
      scanned += 1;

      if (settings.force) {
        observerAddedOrderNodes.add(li);
      }

      processOrderItem(li, {
        forceLog: Boolean(settings.force),
        ignoreDedupe: Boolean(settings.force || settings.ignoreDedupe || settings.resend),
        resend: Boolean(settings.force || settings.resend)
      });
      attempted += 1;
    });

    return {
      success: true,
      scanned,
      attempted,
      force: Boolean(settings.force),
      ignoreDedupe: Boolean(settings.ignoreDedupe || settings.resend),
      resend: Boolean(settings.resend)
    };
  }

  function clearLocalDedupe() {
    sentKeyList = [];
    sentKeys = new Set();
    dedupeStorageLoaded = true;
    persistDedupeKeys();
    debugLog("local userscript dedupe cleared");
    return {
      success: true
    };
  }

  const debugApi = {
    status: getStatus,
    checkHealth,
    scanCurrentList: debugScanCurrentList,
    resendCurrentList: () => debugScanCurrentList({ force: true, resend: true }),
    clearLocalDedupe,
    scanOrderStateChanges: () => scanOrderStateChanges("debug-state-scan"),
    pollReplyActions,
    start: startIfTargetPage,
    stop: stopObservers
  };

  window.SalesMessageLoggerDebug = debugApi;
  debugWindow.SalesMessageLoggerDebug = debugApi;

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

    await ensureDedupeStorageLoaded();
    checkHealth();

    try {
      const orderWrap = await findElementWithRetry("ul.order-wrap", 20, 1000, token);

      if (token !== runToken || !isTargetPage()) {
        return;
      }

      if (!orderWrap) {
        isStarting = false;
        return;
      }

      const chatHistory = await findElementWithRetry(".chat-history", 20, 1000, token);

      if (token !== runToken || !isTargetPage()) {
        return;
      }

      initialScan(orderWrap);
      startOrderListObserver(orderWrap);

      if (chatHistory) {
        startChatHistoryObserver(chatHistory);
      }

      startReplyActionPollTimer();
      isStarted = true;
      console.log(`${LOG_PREFIX} started`);
    } finally {
      isStarting = false;
    }
  }

  function stopObservers() {
    runToken += 1;

    if (orderListObserver) {
      orderListObserver.disconnect();
      orderListObserver = null;
    }

    if (chatHistoryObserver) {
      chatHistoryObserver.disconnect();
      chatHistoryObserver = null;
    }

    if (orderStateScanTimer) {
      clearInterval(orderStateScanTimer);
      orderStateScanTimer = null;
    }

    if (replyPollTimer) {
      clearInterval(replyPollTimer);
      replyPollTimer = null;
    }

    closeReplyOverlay();
    isStarted = false;
    isStarting = false;
    currentChatContext = null;
    debugLog("stopped observers");
  }

  window.addEventListener("hashchange", () => {
    stopObservers();

    setTimeout(() => {
      startIfTargetPage();
    }, CONFIG.restartDelayMs);
  });

  setTimeout(() => {
    startIfTargetPage();
  }, CONFIG.scanDelayMs);
})();
