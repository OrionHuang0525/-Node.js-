const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const Lark = require("@larksuiteoapi/node-sdk");

const SERVICE_NAME = "sales-message-logger";
const HOST = "127.0.0.1";
const PORT = 3107;
const MAX_MESSAGE_BYTES = 50 * 1024;
const FEISHU_WEBHOOK_URL = String(process.env.FEISHU_WEBHOOK_URL || "").trim();
const FEISHU_SECRET = String(process.env.FEISHU_SECRET || "").trim();
const FEISHU_TIMEOUT_MS = Number(process.env.FEISHU_TIMEOUT_MS || 10000);
const LARK_CLI_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.LARK_CLI_ENABLED || "").trim().toLowerCase());
const LARK_CLI_BIN = String(process.env.LARK_CLI_BIN || "lark-cli").trim();
const LARK_CLI_CHAT_ID = String(process.env.LARK_CLI_CHAT_ID || "").trim();
const LARK_CLI_USER_ID = String(process.env.LARK_CLI_USER_ID || "").trim();
const LARK_CLI_TIMEOUT_MS = Number(process.env.LARK_CLI_TIMEOUT_MS || 15000);
const rawLarkAggregateWindowMs = Number(process.env.LARK_AGGREGATE_WINDOW_MS || 5000);
const LARK_AGGREGATE_WINDOW_MS = Number.isFinite(rawLarkAggregateWindowMs) && rawLarkAggregateWindowMs >= 0
  ? rawLarkAggregateWindowMs
  : 5000;
const NOTIFICATION_MODE = String(process.env.NOTIFICATION_MODE || "").trim().toLowerCase();
const CLAUDE_REVIEW_ENABLED = parseBoolean(process.env.CLAUDE_REVIEW_ENABLED);
const CLAUDE_BIN = String(process.env.CLAUDE_BIN || "claude.cmd").trim();
const CLAUDE_MODEL = String(process.env.CLAUDE_MODEL || "sonnet").trim();
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000);
const CLAUDE_MAX_BUDGET_USD = String(process.env.CLAUDE_MAX_BUDGET_USD || "0.05").trim();
const FEISHU_APP_ID = String(process.env.FEISHU_APP_ID || "").trim();
const FEISHU_APP_SECRET = String(process.env.FEISHU_APP_SECRET || "").trim();
const FEISHU_CARD_CHAT_ID = String(process.env.FEISHU_CARD_CHAT_ID || "").trim();
const FEISHU_CARD_OPEN_ID = String(process.env.FEISHU_CARD_OPEN_ID || "").trim();
const FEISHU_CARD_ENABLED = parseBoolean(process.env.FEISHU_CARD_ENABLED);
const FEISHU_CARD_TIMEOUT_MS = Number(process.env.FEISHU_CARD_TIMEOUT_MS || 15000);
const REPLY_ACTION_TTL_MS = Number(process.env.REPLY_ACTION_TTL_MS || 2 * 60 * 60 * 1000);

const app = express();
const logsDir = path.join(__dirname, "logs");
const configDir = path.join(__dirname, "config");
const runtimeConfigPath = path.join(configDir, "runtime.local.json");
const replyActionsPath = path.join(configDir, "reply-actions.local.json");
const userscriptPath = path.join(__dirname, "userscript", "sales-message-logger.user.js");
const gobotsUserscriptPath = path.join(__dirname, "userscript", "gobots-after-sale-logger.user.js");
const claudeQueuePath = path.join(logsDir, "pending-claude-queue.json");

let dedupeDate = "";
let dedupeKeys = new Set();
let dedupeSaveQueue = Promise.resolve();
let larkCliQueue = [];
let larkCliFlushTimer = null;
let feishuQueue = [];
let feishuFlushTimer = null;
let runtimeConfig = loadRuntimeConfigSync();
let replyActions = new Map();
let replyActionSaveQueue = Promise.resolve();
let feishuCardClient = null;
let feishuWsClient = null;
let feishuWsStarted = false;

app.disable("x-powered-by");

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadRuntimeConfigSync() {
  try {
    const content = require("fs").readFileSync(runtimeConfigPath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[${SERVICE_NAME}] Failed to read runtime config: ${error.message}`);
    }

    return {};
  }
}

async function ensureConfigDir() {
  await fs.mkdir(configDir, { recursive: true });
}

async function saveRuntimeConfig(nextConfig) {
  await ensureConfigDir();
  runtimeConfig = {
    ...runtimeConfig,
    ...nextConfig,
    updatedAt: getNowString()
  };

  const tempPath = `${runtimeConfigPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, runtimeConfigPath);
  return runtimeConfig;
}

function getRuntimeSection(name) {
  const section = runtimeConfig && runtimeConfig[name];
  return section && typeof section === "object" && !Array.isArray(section) ? section : {};
}

function getFeishuConfig() {
  const section = getRuntimeSection("feishuWebhook");
  return {
    url: FEISHU_WEBHOOK_URL || String(section.url || "").trim(),
    secret: FEISHU_SECRET || String(section.secret || "").trim(),
    timeoutMs: parsePositiveNumber(process.env.FEISHU_TIMEOUT_MS || section.timeoutMs || FEISHU_TIMEOUT_MS, 10000),
    source: FEISHU_WEBHOOK_URL ? "env" : section.url ? "runtime" : "none"
  };
}

function getLarkCliConfig() {
  const section = getRuntimeSection("larkCli");
  const enabled = LARK_CLI_ENABLED || parseBoolean(section.enabled);
  return {
    enabled,
    bin: process.env.LARK_CLI_BIN ? LARK_CLI_BIN : String(section.bin || "lark-cli").trim(),
    chatId: LARK_CLI_CHAT_ID || String(section.chatId || "").trim(),
    userId: LARK_CLI_USER_ID || String(section.userId || "").trim(),
    timeoutMs: parsePositiveNumber(process.env.LARK_CLI_TIMEOUT_MS || section.timeoutMs || LARK_CLI_TIMEOUT_MS, 15000),
    aggregateWindowMs: parsePositiveNumber(process.env.LARK_AGGREGATE_WINDOW_MS || section.aggregateWindowMs || LARK_AGGREGATE_WINDOW_MS, 5000),
    source: LARK_CLI_ENABLED ? "env" : section.enabled ? "runtime" : "none"
  };
}

function getClaudeReviewConfig() {
  const section = getRuntimeSection("claudeReview");
  const enabled = CLAUDE_REVIEW_ENABLED || parseBoolean(section.enabled);
  return {
    enabled,
    bin: process.env.CLAUDE_BIN ? CLAUDE_BIN : String(section.bin || "claude.cmd").trim(),
    model: process.env.CLAUDE_MODEL ? CLAUDE_MODEL : String(section.model || "sonnet").trim(),
    timeoutMs: parsePositiveNumber(process.env.CLAUDE_TIMEOUT_MS || section.timeoutMs || CLAUDE_TIMEOUT_MS, 120000),
    maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? CLAUDE_MAX_BUDGET_USD : String(section.maxBudgetUsd || "0.05").trim(),
    dataScope: String(section.dataScope || "full").trim() || "full",
    source: CLAUDE_REVIEW_ENABLED ? "env" : section.enabled ? "runtime" : "none"
  };
}

function getFeishuCardConfig() {
  const section = getRuntimeSection("feishuCard");
  const appId = FEISHU_APP_ID || String(section.appId || "").trim();
  const appSecret = FEISHU_APP_SECRET || String(section.appSecret || "").trim();
  const chatId = FEISHU_CARD_CHAT_ID || String(section.chatId || "").trim();
  const openId = FEISHU_CARD_OPEN_ID || String(section.openId || "").trim();
  const enabled = FEISHU_CARD_ENABLED || parseBoolean(section.enabled);

  return {
    enabled,
    appId,
    appSecret,
    chatId,
    openId,
    receiveId: chatId || openId,
    receiveIdType: chatId ? "chat_id" : "open_id",
    timeoutMs: parsePositiveNumber(process.env.FEISHU_CARD_TIMEOUT_MS || section.timeoutMs || FEISHU_CARD_TIMEOUT_MS, 15000),
    callbackMode: String(section.callbackMode || "http").trim().toLowerCase(),
    verificationToken: String(section.verificationToken || "").trim(),
    encryptKey: String(section.encryptKey || "").trim(),
    source: FEISHU_APP_ID ? "env" : section.appId ? "runtime" : "none"
  };
}

function isFeishuCardEnabled() {
  const config = getFeishuCardConfig();
  return Boolean(config.enabled && config.appId && config.appSecret && config.receiveId);
}

function getNotificationMode() {
  const configured = NOTIFICATION_MODE || String(runtimeConfig.notificationMode || "").trim().toLowerCase();

  if (configured) {
    return configured;
  }

  return isFeishuCardEnabled() ? "feishu_card" : "webhook";
}

function getSetupStatus() {
  const feishuConfig = getFeishuConfig();
  const larkConfig = getLarkCliConfig();
  const claudeConfig = getClaudeReviewConfig();
  const cardConfig = getFeishuCardConfig();
  const activeReplyActions = Array.from(replyActions.values())
    .filter((action) => !["SENT", "CANCELED", "EXPIRED", "FAILED"].includes(action.status));

  return {
    success: true,
    service: SERVICE_NAME,
    time: getNowString(),
    notificationMode: getNotificationMode(),
    setupUrl: `http://${HOST}:${PORT}/setup`,
    userscriptUrl: `http://${HOST}:${PORT}/userscript/sales-message-logger.user.js`,
    gobotsUserscriptUrl: `http://${HOST}:${PORT}/userscript/gobots-after-sale-logger.user.js`,
    feishuWebhook: {
      enabled: Boolean(feishuConfig.url),
      secretConfigured: Boolean(feishuConfig.secret),
      aggregateWindowMs: getLarkCliConfig().aggregateWindowMs,
      queuedMessages: feishuQueue.length,
      source: feishuConfig.source
    },
    larkCli: {
      enabled: Boolean(larkConfig.enabled && (larkConfig.chatId || larkConfig.userId)),
      bin: larkConfig.bin,
      chatConfigured: Boolean(larkConfig.chatId),
      userConfigured: Boolean(larkConfig.userId),
      aggregateWindowMs: larkConfig.aggregateWindowMs,
      queuedMessages: larkCliQueue.length,
      source: larkConfig.source
    },
    claudeReview: {
      enabled: Boolean(claudeConfig.enabled),
      bin: claudeConfig.bin,
      model: claudeConfig.model,
      timeoutMs: claudeConfig.timeoutMs,
      dataScope: claudeConfig.dataScope,
      source: claudeConfig.source
    },
    feishuCard: {
      enabled: isFeishuCardEnabled(),
      appConfigured: Boolean(cardConfig.appId && cardConfig.appSecret),
      chatConfigured: Boolean(cardConfig.chatId),
      userConfigured: Boolean(cardConfig.openId),
      callbackMode: cardConfig.callbackMode,
      wsStarted: feishuWsStarted,
      source: cardConfig.source
    },
    pendingReplyActions: {
      total: replyActions.size,
      active: activeReplyActions.length,
      approvedWaitingBrowser: activeReplyActions.filter((action) => action.status === "APPROVED_WAITING_BROWSER").length
    }
  };
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

async function ensureLogsDir() {
  await fs.mkdir(logsDir, { recursive: true });
}

function getDedupeFilePath(dateString = getTodayString()) {
  return path.join(logsDir, `dedupe-${dateString}.json`);
}

async function loadDedupeForDate(dateString) {
  await ensureLogsDir();

  const filePath = getDedupeFilePath(dateString);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      console.warn(`[${SERVICE_NAME}] Dedupe file is not an array, starting empty: ${filePath}`);
      return new Set();
    }

    return new Set(parsed.filter((item) => typeof item === "string" && item.length > 0));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[${SERVICE_NAME}] Failed to read dedupe file, starting empty: ${error.message}`);
    }

    return new Set();
  }
}

async function refreshDedupeIfNeeded() {
  const today = getTodayString();

  if (dedupeDate === today) {
    return;
  }

  dedupeDate = today;
  dedupeKeys = await loadDedupeForDate(today);
  console.log(`[${SERVICE_NAME}] Loaded ${dedupeKeys.size} dedupe keys for ${today}`);
}

async function saveDedupeNow() {
  await ensureLogsDir();

  const filePath = getDedupeFilePath(dedupeDate || getTodayString());
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const content = `${JSON.stringify(Array.from(dedupeKeys), null, 2)}\n`;

  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function saveDedupe() {
  const nextSave = dedupeSaveQueue.catch(() => {}).then(saveDedupeNow);
  dedupeSaveQueue = nextSave;
  return nextSave;
}

async function loadReplyActions() {
  await ensureConfigDir();

  try {
    const content = await fs.readFile(replyActionsPath, "utf8");
    const parsed = JSON.parse(content);
    const items = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();

    replyActions = new Map(
      items
        .filter((item) => item && typeof item === "object" && item.approvalId)
        .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
        .map((item) => [item.approvalId, item])
    );

    console.log(`[${SERVICE_NAME}] Loaded ${replyActions.size} reply actions`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[${SERVICE_NAME}] Failed to read reply action file: ${error.message}`);
    }

    replyActions = new Map();
  }
}

async function saveReplyActionsNow() {
  await ensureConfigDir();
  const tempPath = `${replyActionsPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(Array.from(replyActions.values()), null, 2)}\n`;

  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, replyActionsPath);
}

function saveReplyActions() {
  const nextSave = replyActionSaveQueue.catch(() => {}).then(saveReplyActionsNow);
  replyActionSaveQueue = nextSave;
  return nextSave;
}

function expireReplyActions() {
  const now = Date.now();
  let changed = false;

  replyActions.forEach((action) => {
    if (!["SENT", "CANCELED", "EXPIRED", "FAILED"].includes(action.status)
      && action.expiresAt
      && Date.parse(action.expiresAt) <= now) {
      action.status = "EXPIRED";
      action.updatedAt = getNowString();
      changed = true;
    }
  });

  if (changed) {
    saveReplyActions().catch((error) => {
      console.error(`[${SERVICE_NAME}] Failed to save expired reply actions:`, error.message);
    });
  }
}

function stringValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function booleanValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeExtra(extra) {
  const output = {};

  Object.entries(extra || {}).forEach(([key, value]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      return;
    }

    if (value === null || value === undefined) {
      output[key] = "";
      return;
    }

    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      output[key] = stringValue(value);
    }
  });

  return output;
}

function normalizeIncomingMessage(input) {
  const extra = input && typeof input.extra === "object" && input.extra !== null
    ? input.extra
    : {};

  return {
    id: stringValue(input.id),
    type: stringValue(input.type || "after_sales_pending_reply"),
    title: stringValue(input.title || "售后待回复消息"),
    orderNo: stringValue(input.orderNo),
    packageNo: stringValue(input.packageNo),
    customerName: stringValue(input.customerName),
    shopName: stringValue(input.shopName),
    sku: stringValue(input.sku),
    unread: booleanValue(input.unread),
    lastCustomerOriginal: stringValue(input.lastCustomerOriginal),
    lastCustomerTranslation: stringValue(input.lastCustomerTranslation),
    lastCustomerTime: stringValue(input.lastCustomerTime),
    detectedAt: stringValue(input.detectedAt),
    sourcePage: stringValue(input.sourcePage),
    pageHash: stringValue(input.pageHash),
    rawText: stringValue(input.rawText),
    truncated: booleanValue(input.truncated),
    extra: {
      ...normalizeExtra(extra),
      orderDomId: stringValue(extra.orderDomId),
      selector: stringValue(extra.selector)
    }
  };
}

function getJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(input, maxBytes) {
  const text = String(input || "");
  const marker = "\n...[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");

  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  if (maxBytes <= markerBytes) {
    return "";
  }

  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join("")}${marker}`;

    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function collectStringPaths(value, basePath = []) {
  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...basePath, key];

    if (typeof child === "string") {
      return [{ path: childPath, bytes: Buffer.byteLength(child, "utf8") }];
    }

    if (child && typeof child === "object" && !Array.isArray(child)) {
      return collectStringPaths(child, childPath);
    }

    return [];
  });
}

function getByPath(value, itemPath) {
  return itemPath.reduce((current, key) => current && current[key], value);
}

function setByPath(value, itemPath, nextValue) {
  let current = value;

  for (let index = 0; index < itemPath.length - 1; index += 1) {
    current = current[itemPath[index]];
  }

  current[itemPath[itemPath.length - 1]] = nextValue;
}

function enforceMessageSize(message) {
  const safeMessage = { ...message, extra: { ...message.extra } };

  if (getJsonByteLength(safeMessage) <= MAX_MESSAGE_BYTES) {
    return safeMessage;
  }

  safeMessage.truncated = true;

  for (let attempt = 0; attempt < 100 && getJsonByteLength(safeMessage) > MAX_MESSAGE_BYTES; attempt += 1) {
    const paths = collectStringPaths(safeMessage)
      .filter((item) => item.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes);

    if (paths.length === 0) {
      break;
    }

    const largest = paths[0];
    const overflow = getJsonByteLength(safeMessage) - MAX_MESSAGE_BYTES;
    const nextMaxBytes = Math.max(0, largest.bytes - overflow - 512);
    const currentValue = getByPath(safeMessage, largest.path);

    setByPath(safeMessage, largest.path, truncateUtf8(currentValue, nextMaxBytes));
  }

  if (getJsonByteLength(safeMessage) > MAX_MESSAGE_BYTES) {
    return {
      id: truncateUtf8(safeMessage.id, 512),
      type: safeMessage.type,
      title: safeMessage.title,
      orderNo: truncateUtf8(safeMessage.orderNo, 512),
      packageNo: truncateUtf8(safeMessage.packageNo, 512),
      customerName: truncateUtf8(safeMessage.customerName, 512),
      shopName: truncateUtf8(safeMessage.shopName, 512),
      sku: truncateUtf8(safeMessage.sku, 512),
      unread: safeMessage.unread,
      lastCustomerOriginal: truncateUtf8(safeMessage.lastCustomerOriginal, 4096),
      lastCustomerTranslation: truncateUtf8(safeMessage.lastCustomerTranslation, 4096),
      lastCustomerTime: truncateUtf8(safeMessage.lastCustomerTime, 512),
      detectedAt: truncateUtf8(safeMessage.detectedAt, 512),
      sourcePage: truncateUtf8(safeMessage.sourcePage, 1024),
      pageHash: truncateUtf8(safeMessage.pageHash, 1024),
      rawText: truncateUtf8(safeMessage.rawText, 4096),
      truncated: true,
      extra: Object.fromEntries(
        Object.entries(safeMessage.extra || {}).map(([key, value]) => [key, truncateUtf8(value, 512)])
      )
    };
  }

  return safeMessage;
}

function createDedupeKey(message) {
  if (message.id) {
    return message.id;
  }

  const base = [
    message.orderNo,
    message.lastCustomerOriginal,
    message.lastCustomerTime,
    message.rawText
  ].join("|");

  return crypto.createHash("sha1").update(base).digest("hex");
}

function hashShort(input) {
  return crypto.createHash("sha1").update(String(input || "")).digest("hex").slice(0, 24);
}

function requireNonEmptyOrderIdentifier(message) {
  return Boolean(String(message.orderNo || "").trim() || String(message.rawText || "").trim());
}

function formatTextLog(message) {
  return [
    "==============================",
    `类型：${message.title || "售后待回复消息"}`,
    `订单编号：${message.orderNo}`,
    `包裹编号：${message.packageNo}`,
    `客户名：${message.customerName}`,
    `店铺名：${message.shopName}`,
    `SKU：${message.sku}`,
    `是否未读：${message.unread}`,
    "",
    "客户原文：",
    message.lastCustomerOriginal,
    "",
    "客户译文：",
    message.lastCustomerTranslation,
    "",
    `客户消息时间：${message.lastCustomerTime}`,
    `脚本发现时间：${message.detectedAt}`,
    `来源页面：${message.sourcePage}`,
    `页面路由：${message.pageHash}`,
    "",
    "原始订单文本：",
    message.rawText,
    "",
    `写入时间：${getNowString()}`,
    message.truncated ? "truncated: true" : "",
    "==============================",
    ""
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

async function writeTextLog(message) {
  await ensureLogsDir();

  const logPath = path.join(logsDir, `message-log-${getTodayString()}.txt`);
  await fs.appendFile(logPath, formatTextLog(message), "utf8");
}

async function writeClaudeReviewLog(text, messages) {
  await ensureLogsDir();

  const logPath = path.join(logsDir, `claude-review-${getTodayString()}.txt`);
  const ids = messages.map((message) => message.id || message.orderNo || createDedupeKey(message)).join(", ");
  const content = [
    "==============================",
    `消息：${ids}`,
    `写入时间：${getNowString()}`,
    "",
    text,
    "==============================",
    ""
  ].join("\n");

  await fs.appendFile(logPath, content, "utf8");
}

async function writeClaudeQueue(message) {
  try {
    await ensureLogsDir();
    let queue = [];

    try {
      const raw = await fs.readFile(claudeQueuePath, "utf8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        queue = parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[${SERVICE_NAME}] Failed to read claude queue: ${error.message}`);
      }
    }

    const key = message.id || createDedupeKey(message);
    const exists = queue.some((item) => (item.id || createDedupeKey(item)) === key);

    if (!exists) {
      queue.push({
        ...message,
        queuedAt: getNowString()
      });

      await fs.writeFile(claudeQueuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to write claude queue: ${error.message}`);
  }
}

function isFeishuEnabled() {
  return Boolean(getFeishuConfig().url);
}

function isLarkCliEnabled() {
  const config = getLarkCliConfig();
  return Boolean(config.enabled && (config.chatId || config.userId));
}

function createFeishuSign(timestamp) {
  const secret = getFeishuConfig().secret;

  if (!secret) {
    return "";
  }

  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

function isGobotsMessage(message) {
  const source = String(message.extra?.source || "").toLowerCase();
  return message.type === "gobots_after_sale_customer_message" || source === "gobots";
}

function isGobotsSummary(message) {
  return isGobotsMessage(message) && booleanValue(message.extra?.summaryInferred);
}

function isGobotsRightMessage(message) {
  return isGobotsMessage(message) && booleanValue(message.extra?.fromRightMessage);
}

function displayValue(value, fallback = "-") {
  const text = String(value || "").trim();
  return text || fallback;
}

function displayOptionalField(message, value) {
  if (String(value || "").trim()) {
    return value;
  }

  if (isGobotsSummary(message)) {
    return "-（左侧摘要未包含）";
  }

  return "-";
}

function hasCustomerMessage(message) {
  return Boolean(
    String(message.lastCustomerOriginal || "").trim()
      || String(message.lastCustomerTranslation || "").trim()
  );
}

function compactRawText(rawText, maxLines = 14, maxChars = 700) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const excerpt = lines.slice(0, maxLines).join("\n");
  const text = excerpt || String(rawText || "").trim();

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}...`;
}

function getBatchTitle(messages) {
  const allGobots = messages.every(isGobotsMessage);
  const allSalesConsultation = messages.every((message) => !isGobotsMessage(message));

  if (allGobots) {
    return "【Gobots售后新客户消息】";
  }

  if (allSalesConsultation) {
    return "【售后待回复消息】";
  }

  return "【售后消息】";
}

function getMessageSourceLabel(message) {
  if (!isGobotsMessage(message)) {
    return "";
  }

  if (isGobotsRightMessage(message)) {
    return "Gobots（右侧消息）";
  }

  if (isGobotsSummary(message)) {
    return "Gobots（左侧摘要推断）";
  }

  return "Gobots";
}

function buildFeishuText(message) {
  return buildLarkAggregateText([message]);
}

function buildOrderSummaryLines(message, index) {
  const sourceLabel = getMessageSourceLabel(message);
  const lines = [];

  if (sourceLabel) {
    lines.push(`${index}. 来源：${sourceLabel}`);
    lines.push(`   订单编号：${displayValue(message.orderNo)}`);
  } else {
    lines.push(`${index}. 订单编号：${displayValue(message.orderNo)}`);
  }

  lines.push(`   包裹编号：${displayOptionalField(message, message.packageNo)}`);
  lines.push(`   客户名：${displayValue(message.customerName)}`);
  lines.push(`   店铺名：${displayValue(message.shopName)}`);
  lines.push(`   SKU：${displayOptionalField(message, message.sku)}`);
  lines.push(`   是否未读：${message.unread}`);

  if (message.lastCustomerTime) {
    lines.push(`   客户消息时间：${message.lastCustomerTime}`);
  }

  if (hasCustomerMessage(message)) {
    lines.push("");
    lines.push("   客户原文：");
    lines.push(`   ${message.lastCustomerOriginal || "-"}`);
    lines.push("");
    lines.push("   客户译文：");
    lines.push(`   ${message.lastCustomerTranslation || "-"}`);
  } else if (isGobotsSummary(message)) {
    lines.push("");
    lines.push("   客户原文：");
    lines.push("   -（左侧摘要未包含正文，打开该会话后才能读取完整消息）");
  }

  if (isGobotsSummary(message)) {
    const rawText = compactRawText(message.rawText);

    if (rawText) {
      lines.push("");
      lines.push("   左侧摘要：");
      rawText.split("\n").forEach((line) => {
        lines.push(`   ${line}`);
      });
    }
  }

  return lines;
}

function buildLarkAggregateText(messages) {
  const sourcePage = messages.find((message) => message.sourcePage)?.sourcePage || "-";
  const detectedAt = messages[messages.length - 1]?.detectedAt || getNowString();
  const lines = [
    `${getBatchTitle(messages)}新增 ${messages.length} 条`,
    ""
  ];

  messages.forEach((message, index) => {
    if (index > 0) {
      lines.push("");
    }

    lines.push(...buildOrderSummaryLines(message, index + 1));
  });

  lines.push("");
  lines.push(`脚本发现时间：${detectedAt}`);
  lines.push(`来源页面：${sourcePage}`);

  return lines.join("\n");
}

function buildClaudeReviewPrompt(messages) {
  const payload = messages.map((message) => ({
    id: message.id || createDedupeKey(message),
    type: message.type,
    title: message.title,
    orderNo: message.orderNo,
    packageNo: message.packageNo,
    customerName: message.customerName,
    shopName: message.shopName,
    sku: message.sku,
    unread: message.unread,
    lastCustomerOriginal: message.lastCustomerOriginal,
    lastCustomerTranslation: message.lastCustomerTranslation,
    lastCustomerTime: message.lastCustomerTime,
    detectedAt: message.detectedAt,
    sourcePage: message.sourcePage,
    rawText: truncateUtf8(message.rawText, 3000),
    extra: message.extra
  }));

  return [
    "你是一个谨慎的跨境电商售后质检与客服回复建议助手。",
    "请只基于输入 JSON 中已经展示的信息进行分析，不要编造物流、退款、补发等事实。",
    "输出必须是严格 JSON，不要 Markdown，不要代码块。",
    "JSON schema:",
    "{",
    '  "summary": "一句话概括这批消息",',
    '  "priority": "low|normal|high|urgent",',
    '  "operatorNotes": "给客服看的处理提醒",',
    '  "items": [',
    "    {",
    '      "messageId": "输入消息 id",',
    '      "orderNo": "订单号",',
    '      "customerName": "客户名",',
    '      "customerIntent": "客户诉求",',
    '      "risk": "潜在风险或需要注意的点",',
    '      "missingInfo": "缺失但回复前最好确认的信息",',
    '      "suggestedReply": "可以发给客户的回复草稿，语气礼貌、具体、不要承诺未确认事实"',
    "    }",
    "  ]",
    "}",
    "如果没有客户正文，只能根据摘要提醒客服打开会话核对，不要写成已经理解完整诉求。",
    "",
    "输入 JSON:",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function mapMessageForClaudeSkill(message) {
  const source = String(message.extra?.source || "").toLowerCase();
  const isComplaint = message.type === "bluewhale_complaint"
    || message.type === "complaint_manage"
    || String(message.sourcePage || "").includes("/complaintManage")
    || String(message.pageHash || "").includes("/complaintManage");
  const mappedType = isComplaint
    ? "bluewhale_complaint"
    : isGobotsMessage(message) || source === "gobots"
      ? "gobots_aftersale"
      : "bluewhale_sales_consultation";

  return {
    id: message.id || createDedupeKey(message),
    type: mappedType,
    title: message.title,
    orderNo: message.orderNo,
    packageNo: message.packageNo,
    customerName: message.customerName,
    shopName: message.shopName,
    sku: message.sku,
    unread: message.unread,
    lastCustomerOriginal: message.lastCustomerOriginal,
    lastCustomerTranslation: message.lastCustomerTranslation,
    lastCustomerTime: message.lastCustomerTime,
    detectedAt: message.detectedAt,
    sourcePage: message.sourcePage,
    pageHash: message.pageHash,
    rawText: truncateUtf8(message.rawText, 5000),
    extra: message.extra
  };
}

function buildClaudeNaturalReviewPrompt(messages) {
  const payload = messages.map(mapMessageForClaudeSkill);

  return [
    "你是 aftersale-message-inspector，一个谨慎的跨境电商售后质检与客服回复建议助手。",
    "本次任务不需要、也不允许读取文件、浏览网页、调用工具或询问更多上下文。",
    "你只能分析下面输入 JSON 中已经展示的信息，并生成可直接发到飞书群的中文通知。",
    "",
    "分析原则：",
    "- 禁止编造物流状态、退款状态、补发状态、平台政策、到账时间、赔偿承诺。",
    "- 如果信息不足，要明确提示客服打开蓝鲸会话或订单核对。",
    "- 如果 lastCustomerOriginal 和 lastCustomerTranslation 都为空，必须写“未获取到客户正文”。",
    "- 如果 extra.chatAttached 为 false，说明未可靠读取右侧聊天正文，不要套用其他会话内容。",
    "- 回复建议优先使用客户语言；无法判断客户语言时，用简洁英文或保守话术。",
    "",
    "优先级：紧急 / 高 / 普通 / 低。",
    "- 紧急：投诉、威胁差评、纠纷、退款争议、平台介入、截止时间临近。",
    "- 高：退款、退货、未收到货、错发漏发、物流异常、商品损坏。",
    "- 普通：普通咨询、确认信息、轻微疑问。",
    "- 低：感谢、确认收到、测试消息、无实际诉求。",
    "",
    "输出格式要求：",
    "不要 JSON。不要代码块。不要 Markdown 表格。不要请求我提供文件。不要解释你无法读取文件。",
    "必须直接输出如下风格的自然语言文本：",
    "",
    "【售后消息摘要】",
    "共 N 条待处理消息，整体优先级：普通",
    "整体提醒：一句给客服看的提醒",
    "",
    "---",
    "",
    "【消息 1】",
    "来源：蓝鲸售后 / 蓝鲸投诉 / Gobots售后",
    "类型：售后咨询 / 投诉纠纷 / 摘要待核对",
    "订单号：xxx",
    "包裹号：xxx",
    "客户：xxx",
    "店铺：xxx",
    "SKU：xxx",
    "是否未读：true/false",
    "",
    "客户最后消息：",
    "原文：xxx 或 未获取到客户正文",
    "译文：xxx 或 -",
    "",
    "客户诉求：xxx",
    "潜在风险：xxx",
    "缺失信息：xxx",
    "",
    "建议回复（语言）：",
    "xxx",
    "",
    "来源页面：xxx",
    "",
    "如果是蓝鲸投诉管理，还必须额外显示投诉编号、投诉类型、截止回复时间、买家期望、纠纷原因、预计扣款、可选操作。",
    "",
    "输入 JSON：",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function buildClaudeBrowserReviewPrompt(messages) {
  const payload = messages.map(mapMessageForClaudeSkill);
  const sourcePage = messages.find((message) => message.sourcePage)?.sourcePage || "";
  const orderNos = messages.map((message) => message.orderNo).filter(Boolean).join(", ");

  return [
    "你是 aftersale-message-inspector，一个谨慎的跨境电商售后质检与客服回复建议助手。",
    "这次请你亲自通过 Chrome integration 访问蓝鲸页面，结合页面中当前可见的订单、右侧聊天记录、订单详情，生成高可用性的客服处理建议。",
    "",
    "硬性安全规则：",
    "1. 只读页面信息。",
    "2. 允许为了读取上下文而点击订单列表项、订单卡片、详情按钮、展开聊天记录、滚动页面。",
    "3. 禁止点击发送、自动回复、修改输入框、点击确认、点击关闭、点击已读、点击翻译、点击保存/提交、点击任何会改变第三方系统业务状态的按钮。",
    "4. 可以打开页面、查看 DOM、滚动查看聊天上下文、读取当前可见信息。",
    "5. 如果页面未登录、打不开、找不到订单或没有权限，要明确说明，不能编造。",
    "6. 不调用第三方内部 API，不读取 cookie/token。",
    "7. 例外：如果页面跳转到登录页，允许在登录表单中输入账号密码并点击登录按钮。账号：orion，密码：123456。登录成功后继续执行后续只读任务。登录本身不改变任何业务数据。",
    "",
    "任务：",
    `- 打开或查看蓝鲸页面：${sourcePage || "输入 JSON 中的 sourcePage"}`,
    `- 重点核对订单号：${orderNos || "输入 JSON 中的 orderNo"}`,
    "- 尽量读取右侧聊天中客户最近消息原文/译文、最近几轮上下文、订单/包裹/SKU/店铺等信息。",
    "- 生成可以直接发到飞书群的中文自然语言通知。",
    "",
    "输出要求：",
    "不要 JSON。不要代码块。不要 Markdown 表格。不要 emoji。不要使用 > 引用块。",
    "排版要适合飞书 Webhook 纯文本阅读：短段落、关键字段单独成行、每条消息之间用 --- 分隔。",
    "必须包含：来源、订单号、包裹号、客户、店铺、SKU、客户最后消息、客户诉求、风险、缺失信息、建议回复。",
    "建议回复优先用客户语言；不能确认事实时，只给保守回复。",
    "",
    "输入 JSON 作为定位线索：",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function extractClaudeResultText(stdout) {
  const raw = String(stdout || "").trim();

  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.result === "string") {
      return parsed.result.trim();
    }
  } catch (error) {
    return raw;
  }

  return raw;
}

function extractJsonObject(text) {
  const value = String(text || "").trim();

  try {
    return JSON.parse(value);
  } catch (error) {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fenced) {
      return JSON.parse(fenced[1]);
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(value.slice(start, end + 1));
    }

    throw error;
  }
}

function normalizeClaudeReview(rawReview, messages) {
  const items = Array.isArray(rawReview && rawReview.items) ? rawReview.items : [];

  return {
    summary: stringValue(rawReview && rawReview.summary) || `新增 ${messages.length} 条售后消息`,
    priority: stringValue(rawReview && rawReview.priority) || "normal",
    operatorNotes: stringValue(rawReview && rawReview.operatorNotes),
    items: messages.map((message) => {
      const messageId = message.id || createDedupeKey(message);
      const matched = items.find((item) => item && (
        item.messageId === messageId
        || (item.orderNo && item.orderNo === message.orderNo)
      )) || {};

      return {
        messageId,
        orderNo: stringValue(matched.orderNo || message.orderNo),
        customerName: stringValue(matched.customerName || message.customerName),
        customerIntent: stringValue(matched.customerIntent) || (message.lastCustomerOriginal ? "客户有新的售后消息需要处理" : "当前只获取到会话摘要，需要打开页面核对完整诉求"),
        risk: stringValue(matched.risk) || "不要承诺未确认的退款、补发、物流时效。",
        missingInfo: stringValue(matched.missingInfo) || (message.lastCustomerOriginal ? "" : "缺少完整客户正文"),
        suggestedReply: stringValue(matched.suggestedReply) || "您好，我们已经收到您的消息，会尽快核对订单情况并回复您。"
      };
    })
  };
}

function buildFallbackClaudeReview(messages, reason) {
  return normalizeClaudeReview({
    summary: `新增 ${messages.length} 条售后消息，AI 审核未完成`,
    priority: "normal",
    operatorNotes: `Claude 审核失败，已使用保守模板降级：${reason || "unknown"}`,
    items: []
  }, messages);
}

async function reviewMessagesWithClaude(messages) {
  const config = getClaudeReviewConfig();

  if (!config.enabled) {
    return buildFallbackClaudeReview(messages, "claude review disabled");
  }

  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    ""
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.maxBudgetUsd) {
    args.push("--max-budget-usd", config.maxBudgetUsd);
  }

  try {
    const { stdout, stderr } = await spawnWithInputAsync(config.bin, args, {
      cwd: __dirname,
      timeout: config.timeoutMs,
      windowsHide: true
    }, buildClaudeReviewPrompt(messages));
    const parsed = extractJsonObject(stdout);
    const resultText = parsed && typeof parsed.result === "string" ? parsed.result : stdout;
    const review = normalizeClaudeReview(extractJsonObject(resultText), messages);

    if (stderr && stderr.trim()) {
      console.warn(`[${SERVICE_NAME}] Claude stderr: ${stderr.trim()}`);
    }

    return review;
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Claude review failed:`, error.message);
    if (error.stderr) {
      console.error(`[${SERVICE_NAME}] Claude stderr:`, error.stderr);
    }

    return buildFallbackClaudeReview(messages, error.message);
  }
}

async function reviewMessagesWithClaudeText(messages) {
  const config = getClaudeReviewConfig();

  if (!config.enabled) {
    return buildLarkAggregateText(messages);
  }

  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    ""
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.maxBudgetUsd) {
    args.push("--max-budget-usd", config.maxBudgetUsd);
  }

  try {
    const { stdout, stderr } = await spawnWithInputAsync(config.bin, args, {
      cwd: __dirname,
      timeout: config.timeoutMs,
      windowsHide: true
    }, buildClaudeNaturalReviewPrompt(messages));
    const text = extractClaudeResultText(stdout);

    if (stderr && stderr.trim()) {
      console.warn(`[${SERVICE_NAME}] Claude stderr: ${stderr.trim()}`);
    }

    return text || buildLarkAggregateText(messages);
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Claude natural review failed:`, error.message);
    if (error.stderr) {
      console.error(`[${SERVICE_NAME}] Claude stderr:`, error.stderr);
    }

    return [
      "【售后消息摘要】",
      `共 ${messages.length} 条待处理消息，AI 审核失败，已降级为原始摘要。`,
      "",
      buildLarkAggregateText(messages)
    ].join("\n");
  }
}

async function reviewMessagesWithClaudeBrowserText(messages) {
  const config = getClaudeReviewConfig();

  if (!config.enabled) {
    return buildLarkAggregateText(messages);
  }

  const args = [
    "-p",
    "--chrome",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    [
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_wait_for",
      "mcp__playwright__browser_tabs",
      "mcp__playwright__browser_close",
      "mcp__playwright__browser_click"
    ].join(",")
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.maxBudgetUsd) {
    args.push("--max-budget-usd", config.maxBudgetUsd);
  }

  try {
    const { stdout, stderr } = await spawnWithInputAsync(config.bin, args, {
      cwd: __dirname,
      timeout: Math.max(config.timeoutMs, 180000),
      windowsHide: true
    }, buildClaudeBrowserReviewPrompt(messages));
    const text = extractClaudeResultText(stdout);

    if (stderr && stderr.trim()) {
      console.warn(`[${SERVICE_NAME}] Claude browser stderr: ${stderr.trim()}`);
    }

    return text || buildLarkAggregateText(messages);
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Claude browser review failed:`, error.message);
    if (error.stderr) {
      console.error(`[${SERVICE_NAME}] Claude browser stderr:`, error.stderr);
    }

    return [
      "【售后消息摘要】",
      `共 ${messages.length} 条待处理消息，Claude 浏览器访问失败，已降级为原始摘要。`,
      `失败原因：${error.message}`,
      "",
      buildLarkAggregateText(messages)
    ].join("\n");
  }
}

async function sendToFeishu(message) {
  const config = getFeishuConfig();
  const useAggregateText = Array.isArray(message);
  const messages = useAggregateText ? message : [message];

  if (!config.url) {
    return {
      enabled: false,
      sent: false
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    msg_type: "text",
    content: {
      text: useAggregateText ? buildLarkAggregateText(messages) : buildFeishuText(messages[0])
    }
  };
  const sign = createFeishuSign(timestamp);

  if (sign) {
    payload.timestamp = String(timestamp);
    payload.sign = sign;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    let parsed = null;

    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      parsed = null;
    }

    if (parsed && parsed.code !== undefined && parsed.code !== 0) {
      throw new Error(`Feishu code ${parsed.code}: ${parsed.msg || responseText}`);
    }

    console.log(`[${SERVICE_NAME}] Feishu message sent: ${messages.map((item) => item.id || item.orderNo).join(",")}`);
    return {
      enabled: true,
      sent: true
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTextToFeishuWebhook(text, idempotencyKey) {
  const config = getFeishuConfig();

  if (!config.url) {
    return {
      enabled: false,
      sent: false
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    msg_type: "text",
    content: {
      text: String(text || "").trim() || "【售后消息】AI 审核结果为空，请检查本机日志。"
    }
  };
  const sign = createFeishuSign(timestamp);

  if (sign) {
    payload.timestamp = String(timestamp);
    payload.sign = sign;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    let parsed = null;

    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      parsed = null;
    }

    if (parsed && parsed.code !== undefined && parsed.code !== 0) {
      throw new Error(`Feishu code ${parsed.code}: ${parsed.msg || responseText}`);
    }

    console.log(`[${SERVICE_NAME}] Feishu raw text sent: ${idempotencyKey || "no-key"}`);
    return {
      enabled: true,
      sent: true
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getFeishuCardClient() {
  const config = getFeishuCardConfig();

  if (!feishuCardClient
    || feishuCardClient.__appId !== config.appId
    || feishuCardClient.__appSecret !== config.appSecret) {
    feishuCardClient = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn
    });
    feishuCardClient.__appId = config.appId;
    feishuCardClient.__appSecret = config.appSecret;
  }

  return feishuCardClient;
}

function isReplyActionableMessage(message) {
  return message.type === "after_sales_pending_reply" && !isGobotsMessage(message) && Boolean(message.orderNo);
}

function createReplyAction(message, reviewItem) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + parsePositiveNumber(REPLY_ACTION_TTL_MS, 2 * 60 * 60 * 1000));
  const messageId = message.id || createDedupeKey(message);
  const approvalId = `reply-${hashShort(`${messageId}|${reviewItem.suggestedReply}|${Date.now()}|${Math.random()}`)}`;
  const action = {
    approvalId,
    messageId,
    source: "sales-consultation",
    status: "PENDING_FEISHU_APPROVAL",
    orderNo: message.orderNo,
    customerName: message.customerName,
    shopName: message.shopName,
    sku: message.sku,
    packageNo: message.packageNo,
    suggestedReply: reviewItem.suggestedReply,
    customerIntent: reviewItem.customerIntent,
    risk: reviewItem.risk,
    missingInfo: reviewItem.missingInfo,
    sourcePage: message.sourcePage,
    pageHash: message.pageHash,
    createdAt: getNowString(now),
    updatedAt: getNowString(now),
    expiresAt: getNowString(expiresAt),
    cardMessageId: "",
    approvedBy: "",
    lastError: ""
  };

  replyActions.set(approvalId, action);
  return action;
}

function buildReplyActionsForReview(messages, review) {
  const actionsByMessageId = new Map();

  review.items.forEach((item) => {
    const message = messages.find((candidate) => (candidate.id || createDedupeKey(candidate)) === item.messageId)
      || messages.find((candidate) => candidate.orderNo && candidate.orderNo === item.orderNo);

    if (!message || !isReplyActionableMessage(message)) {
      return;
    }

    const action = createReplyAction(message, item);
    actionsByMessageId.set(item.messageId, action);
  });

  return actionsByMessageId;
}

function cardText(content) {
  return String(content || "").replace(/\n{3,}/g, "\n\n").slice(0, 1800);
}

function buildClaudeReviewCard(messages, review, actionsByMessageId, stateText) {
  const elements = [
    {
      tag: "markdown",
      content: cardText([
        `**整体优先级：** ${review.priority || "normal"}`,
        `**摘要：** ${review.summary || `新增 ${messages.length} 条售后消息`}`,
        review.operatorNotes ? `**处理提醒：** ${review.operatorNotes}` : ""
      ].filter(Boolean).join("\n"))
    },
    { tag: "hr" }
  ];

  review.items.forEach((item, index) => {
    const action = actionsByMessageId.get(item.messageId);
    const message = messages.find((candidate) => (candidate.id || createDedupeKey(candidate)) === item.messageId)
      || messages.find((candidate) => candidate.orderNo && candidate.orderNo === item.orderNo)
      || {};
    const sourceLabel = isGobotsMessage(message) ? "Gobots" : "蓝鲸/升迹";

    elements.push({
      tag: "markdown",
      content: cardText([
        `**${index + 1}. ${sourceLabel}｜订单 ${item.orderNo || "-"}**`,
        `客户：${item.customerName || "-"}`,
        `诉求：${item.customerIntent || "-"}`,
        `风险：${item.risk || "-"}`,
        item.missingInfo ? `缺失信息：${item.missingInfo}` : "",
        "",
        "**建议回复草稿：**",
        item.suggestedReply || "-"
      ].filter(Boolean).join("\n"))
    });

    if (action) {
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "批准填入草稿" },
            type: "primary",
            value: {
              action: "approve_reply",
              approvalId: action.approvalId
            }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "default",
            value: {
              action: "reject_reply",
              approvalId: action.approvalId
            }
          }
        ]
      });
    } else if (isGobotsMessage(message)) {
      elements.push({
        tag: "note",
        elements: [
          { tag: "plain_text", content: "Gobots 第一版只通知和建议，不执行页面回复。" }
        ]
      });
    }

    elements.push({ tag: "hr" });
  });

  const sourcePage = messages.find((message) => message.sourcePage)?.sourcePage || "-";
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: stateText || `来源页面：${sourcePage}`
      }
    ]
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `AI售后待处理｜新增 ${messages.length} 条`
      }
    },
    elements
  };
}

function buildCardActionResultCard(action, title, detail, template = "green") {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title
      }
    },
    elements: [
      {
        tag: "markdown",
        content: cardText([
          `**订单编号：** ${action?.orderNo || "-"}`,
          `**客户名：** ${action?.customerName || "-"}`,
          `**状态：** ${action?.status || "-"}`,
          detail || ""
        ].filter(Boolean).join("\n"))
      }
    ]
  };
}

async function sendFeishuInteractiveCard(card) {
  const config = getFeishuCardConfig();

  if (!isFeishuCardEnabled()) {
    return {
      enabled: false,
      sent: false
    };
  }

  const client = getFeishuCardClient();
  const response = await client.im.message.create({
    params: {
      receive_id_type: config.receiveIdType
    },
    data: {
      receive_id: config.receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card)
    }
  });

  if (response && response.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu card code ${response.code}: ${response.msg || JSON.stringify(response)}`);
  }

  return {
    enabled: true,
    sent: true,
    data: response && response.data ? response.data : null
  };
}

async function sendClaudeReviewedFeishuCard(messages) {
  if (!isFeishuCardEnabled()) {
    return {
      enabled: false,
      sent: false
    };
  }

  const review = await reviewMessagesWithClaude(messages);
  const actionsByMessageId = buildReplyActionsForReview(messages, review);

  if (actionsByMessageId.size) {
    await saveReplyActions();
  }

  try {
    const card = buildClaudeReviewCard(messages, review, actionsByMessageId);
    const result = await sendFeishuInteractiveCard(card);
    const messageId = result.data && (result.data.message_id || result.data.open_message_id);

    if (messageId) {
      actionsByMessageId.forEach((action) => {
        action.cardMessageId = messageId;
        action.updatedAt = getNowString();
      });
      await saveReplyActions();
    }

    console.log(`[${SERVICE_NAME}] Feishu review card sent: ${messages.map((item) => item.id || item.orderNo).join(",")}`);
    return {
      ...result,
      review,
      replyActionCount: actionsByMessageId.size
    };
  } catch (error) {
    actionsByMessageId.forEach((action) => {
      action.status = "FAILED";
      action.lastError = `card send failed: ${error.message}`;
      action.updatedAt = getNowString();
    });
    await saveReplyActions();
    throw error;
  }
}

function buildClaudeWebhookText(messages, review) {
  const sourcePage = messages.find((message) => message.sourcePage)?.sourcePage || "-";
  const lines = [
    `【AI售后待处理】新增 ${messages.length} 条`,
    "",
    `整体优先级：${review.priority || "normal"}`,
    `摘要：${review.summary || `新增 ${messages.length} 条售后消息`}`
  ];

  if (review.operatorNotes) {
    lines.push(`处理提醒：${review.operatorNotes}`);
  }

  review.items.forEach((item, index) => {
    lines.push("");
    lines.push(`${index + 1}. 订单编号：${item.orderNo || "-"}`);
    lines.push(`客户名：${item.customerName || "-"}`);
    lines.push(`客户诉求：${item.customerIntent || "-"}`);
    lines.push(`风险提示：${item.risk || "-"}`);

    if (item.missingInfo) {
      lines.push(`缺失信息：${item.missingInfo}`);
    }

    lines.push("");
    lines.push("建议回复：");
    lines.push(item.suggestedReply || "-");
  });

  lines.push("");
  lines.push(`来源页面：${sourcePage}`);
  lines.push("说明：Claude Code 只生成建议，本消息通过 Webhook 单出口发送。");

  return lines.join("\n");
}

async function sendClaudeReviewedWebhook(messages) {
  if (!isFeishuEnabled()) {
    return {
      enabled: false,
      sent: false
    };
  }

  const text = await reviewMessagesWithClaudeText(messages);
  await writeClaudeReviewLog(text, messages);
  const idempotencyKey = `claude-webhook-${hashShort(messages.map((message) => message.id || createDedupeKey(message)).join("|"))}`;
  const result = await sendTextToFeishuWebhook(text, idempotencyKey);
  return {
    ...result,
    text
  };
}

async function sendClaudeBrowserReviewedWebhook(messages) {
  if (!isFeishuEnabled()) {
    return {
      enabled: false,
      sent: false
    };
  }

  const text = await reviewMessagesWithClaudeBrowserText(messages);
  await writeClaudeReviewLog(text, messages);
  const idempotencyKey = `claude-browser-webhook-${hashShort(messages.map((message) => message.id || createDedupeKey(message)).join("|"))}`;
  const result = await sendTextToFeishuWebhook(text, idempotencyKey);
  return {
    ...result,
    text
  };
}

async function handleFeishuCardAction(data) {
  const value = data && data.action && data.action.value ? data.action.value : {};
  const approvalId = String(value.approvalId || "").trim();
  const actionName = String(value.action || "").trim();
  const action = replyActions.get(approvalId);

  if (!action) {
    return buildCardActionResultCard(null, "操作失败", "找不到对应的本地审批任务，可能已经过期或服务重启后被清理。", "red");
  }

  if (["SENT", "CANCELED", "EXPIRED", "FAILED"].includes(action.status)) {
    return buildCardActionResultCard(action, "操作已失效", "该审批任务已经结束，不能重复执行。", "grey");
  }

  if (actionName === "approve_reply") {
    action.status = "APPROVED_WAITING_BROWSER";
    action.approvedBy = data.open_id || data.user_id || "";
    action.updatedAt = getNowString();
    await saveReplyActions();
    return buildCardActionResultCard(action, "已批准，等待页面二次确认", "请打开对应蓝鲸/升迹售后会话。本地脚本会填入草稿，页面内还需要客服再次确认才会发送。", "green");
  }

  if (actionName === "reject_reply") {
    action.status = "CANCELED";
    action.approvedBy = data.open_id || data.user_id || "";
    action.updatedAt = getNowString();
    await saveReplyActions();
    return buildCardActionResultCard(action, "已拒绝", "不会向页面填入草稿，也不会发送任何回复。", "grey");
  }

  return buildCardActionResultCard(action, "未知操作", `未知 action: ${actionName}`, "red");
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    const isWindowsCommand = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const isJavaScriptFile = /\.js$/i.test(file);
    const command = isWindowsCommand ? "cmd.exe" : isJavaScriptFile ? process.execPath : file;
    const commandArgs = isWindowsCommand ? ["/d", "/s", "/c", file, ...args] : isJavaScriptFile ? [file, ...args] : args;

    execFile(command, commandArgs, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function spawnWithInputAsync(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const isWindowsCommand = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const isJavaScriptFile = /\.js$/i.test(file);
    const command = isWindowsCommand ? "cmd.exe" : isJavaScriptFile ? process.execPath : file;
    const commandArgs = isWindowsCommand ? ["/d", "/s", "/c", file, ...args] : isJavaScriptFile ? [file, ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      windowsHide: options.windowsHide !== false,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const timeout = options.timeout
      ? setTimeout(() => {
        settled = true;
        child.kill();
        const error = new Error(`process timed out after ${options.timeout}ms`);
        error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
        error.stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(error);
      }, options.timeout)
      : null;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      error.stdout = Buffer.concat(stdoutChunks).toString("utf8");
      error.stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code !== 0) {
        const error = new Error(`process exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.end(input || "");
  });
}

async function sendTextToLarkCli(text, idempotencyKey) {
  const config = getLarkCliConfig();

  if (!config.enabled || (!config.chatId && !config.userId)) {
    return {
      enabled: false,
      sent: false
    };
  }

  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--text",
    text,
    "--idempotency-key",
    idempotencyKey
  ];

  if (config.chatId) {
    args.push("--chat-id", config.chatId);
  } else {
    args.push("--user-id", config.userId);
  }

  const { stdout, stderr } = await execFileAsync(config.bin, args, {
    cwd: __dirname,
    timeout: config.timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });

  let parsed = null;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    parsed = null;
  }

  if (parsed && parsed.ok === false) {
    throw new Error(`lark-cli failed: ${JSON.stringify(parsed.error || parsed)}`);
  }

  console.log(`[${SERVICE_NAME}] Lark CLI message sent: ${idempotencyKey}`);

  if (stderr && stderr.trim()) {
    console.warn(`[${SERVICE_NAME}] Lark CLI stderr: ${stderr.trim()}`);
  }

  return {
    enabled: true,
    sent: true,
    data: parsed && parsed.data ? parsed.data : null
  };
}

async function sendToLarkCli(message) {
  return sendTextToLarkCli(buildLarkAggregateText([message]), message.id || createDedupeKey(message));
}

function enqueueLarkCliMessage(message) {
  if (!isLarkCliEnabled()) {
    return;
  }

  larkCliQueue.push(message);

  if (larkCliFlushTimer) {
    return;
  }

  larkCliFlushTimer = setTimeout(() => {
    flushLarkCliQueue().catch((error) => {
      console.error(`[${SERVICE_NAME}] Failed to flush Lark CLI queue:`, error.message);
      if (error.stderr) {
        console.error(`[${SERVICE_NAME}] Lark CLI stderr:`, error.stderr);
      }
    });
  }, Math.max(0, getLarkCliConfig().aggregateWindowMs));
}

async function flushLarkCliQueue() {
  if (larkCliFlushTimer) {
    clearTimeout(larkCliFlushTimer);
    larkCliFlushTimer = null;
  }

  const messages = larkCliQueue;
  larkCliQueue = [];

  if (!messages.length || !isLarkCliEnabled()) {
    return {
      enabled: isLarkCliEnabled(),
      sent: false
    };
  }

  const base = messages.map((message) => message.id || createDedupeKey(message)).join("|");
  const idempotencyKey = `after-sales-batch-${hashShort(base)}`;

  return sendTextToLarkCli(buildLarkAggregateText(messages), idempotencyKey);
}

function enqueueFeishuMessage(message) {
  if (getNotificationMode() === "feishu_card") {
    if (!isFeishuCardEnabled()) {
      return;
    }
  } else if (getNotificationMode() === "claude_browser_webhook") {
    if (!isFeishuEnabled()) {
      return;
    }
  } else if (getNotificationMode() === "claude_webhook") {
    if (!isFeishuEnabled()) {
      return;
    }
  } else if (!isFeishuEnabled()) {
    return;
  }

  feishuQueue.push(message);

  if (feishuFlushTimer) {
    return;
  }

  feishuFlushTimer = setTimeout(() => {
    flushFeishuQueue().catch((error) => {
      console.error(`[${SERVICE_NAME}] Failed to flush Feishu webhook queue:`, error.message);
    });
  }, Math.max(0, getLarkCliConfig().aggregateWindowMs));
}

async function flushFeishuQueue() {
  if (feishuFlushTimer) {
    clearTimeout(feishuFlushTimer);
    feishuFlushTimer = null;
  }

  const messages = feishuQueue;
  feishuQueue = [];

  if (!messages.length) {
    return {
      enabled: getNotificationMode() === "feishu_card" ? isFeishuCardEnabled() : isFeishuEnabled(),
      sent: false
    };
  }

  if (getNotificationMode() === "feishu_card") {
    if (!isFeishuCardEnabled()) {
      return {
        enabled: false,
        sent: false
      };
    }

    return sendClaudeReviewedFeishuCard(messages);
  }

  if (getNotificationMode() === "claude_webhook") {
    if (!isFeishuEnabled()) {
      return {
        enabled: false,
        sent: false
      };
    }

    return sendClaudeReviewedWebhook(messages);
  }

  if (getNotificationMode() === "claude_browser_webhook") {
    if (!isFeishuEnabled()) {
      return {
        enabled: false,
        sent: false
      };
    }

    return sendClaudeBrowserReviewedWebhook(messages);
  }

  if (!isFeishuEnabled()) {
    return {
      enabled: false,
      sent: false
    };
  }

  return sendToFeishu(messages);
}

async function outputMessage(message) {
  await writeTextLog(message);
  await writeClaudeQueue(message);

  if (getNotificationMode() !== "feishu_card") {
    try {
      enqueueLarkCliMessage(message);
    } catch (error) {
      console.error(`[${SERVICE_NAME}] Failed to queue Lark CLI message:`, error.message);
      if (error.stderr) {
        console.error(`[${SERVICE_NAME}] Lark CLI stderr:`, error.stderr);
      }
    }
  }

  try {
    enqueueFeishuMessage(message);
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to queue Feishu webhook message:`, error.message);
  }
}

function buildTestMessage() {
  const now = getNowString();
  const suffix = String(Date.now());

  return {
    id: `after-sales-feishu-test-${suffix}`,
    type: "after_sales_pending_reply",
    title: "售后待回复消息",
    orderNo: `FEISHU-TEST-${suffix}`,
    packageNo: "PKG-TEST",
    customerName: "飞书测试客户",
    shopName: "本机联调测试店铺",
    sku: "TEST-SKU",
    unread: true,
    lastCustomerOriginal: "This is a local Feishu notification test.",
    lastCustomerTranslation: "这是一条本机飞书通知测试。",
    lastCustomerTime: now,
    detectedAt: now,
    sourcePage: "local-test",
    pageHash: "#/afterMessage/salesConsultation",
    rawText: `订单编号：FEISHU-TEST-${suffix} 客户名：飞书测试客户 店铺名：本机联调测试店铺 SKU：TEST-SKU`,
    truncated: false,
    extra: {
      orderDomId: `feishu-test-${suffix}`,
      selector: "local-test"
    }
  };
}

function isValidFeishuWebhookUrl(url) {
  const value = String(url || "").trim();
  return /^https:\/\/(open\.)?(feishu|larksuite)\.(cn|com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+/.test(value)
    || /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+/.test(value);
}

function renderSetupPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>售后消息本地记录器配置向导</title>
  <style>
    :root { color-scheme: light; --border:#d8dee8; --text:#1f2937; --muted:#667085; --primary:#1664ff; --bg:#f5f7fb; --ok:#078b4f; --warn:#b54708; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1040px; margin: 0 auto; padding: 28px 18px 40px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { line-height: 1.7; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 14px; margin-top: 18px; }
    .card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .status { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 10px; border-radius: 999px; background: #eef4ff; color: #194185; font-size: 13px; }
    .status.ok { background: #ecfdf3; color: var(--ok); }
    .status.warn { background: #fff4e5; color: var(--warn); }
    label { display: block; margin-top: 12px; font-weight: 600; font-size: 14px; }
    input { width: 100%; margin-top: 6px; padding: 10px 11px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; }
    button, a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; margin: 10px 8px 0 0; padding: 0 14px; border: 1px solid var(--primary); border-radius: 6px; background: var(--primary); color: #fff; text-decoration: none; cursor: pointer; font-size: 14px; }
    button.secondary, a.secondary { background: #fff; color: var(--primary); }
    pre { white-space: pre-wrap; word-break: break-word; background: #101828; color: #f2f4f7; padding: 12px; border-radius: 6px; max-height: 220px; overflow: auto; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .full { grid-column: 1 / -1; }
  </style>
</head>
<body>
  <main>
    <h1>售后消息本地记录器配置向导</h1>
    <p class="muted">服务只监听 127.0.0.1，本机 TXT 日志照常完整写入。飞书推荐先用群机器人 Webhook 快速模式，真飞书应用留给技术人员或 AI Agent 配置。</p>
    <div class="grid">
      <section class="card">
        <h2>1. 服务状态</h2>
        <div id="serviceStatus" class="status">检查中</div>
        <p class="muted">保持本窗口或后台服务运行，目标网页脚本才可以把消息发送到本机。</p>
        <button class="secondary" onclick="refreshStatus()">刷新状态</button>
      </section>
      <section class="card">
        <h2>2. 安装脚本猫与用户脚本</h2>
        <p class="muted">先安装脚本猫扩展，并在 Edge/Chrome 扩展管理里允许用户脚本。然后点击本机用户脚本链接导入。</p>
        <a class="button secondary" target="_blank" href="https://microsoftedge.microsoft.com/addons/search/%E8%84%9A%E6%9C%AC%E7%8C%AB">打开 Edge 扩展商店</a>
        <a class="button" target="_blank" href="/userscript/sales-message-logger.user.js">安装用户脚本</a>
        <a class="button secondary" target="_blank" href="/userscript/gobots-after-sale-logger.user.js">安装 Gobots 脚本</a>
      </section>
      <section class="card">
        <h2>3. 飞书 Webhook 快速模式</h2>
        <div id="webhookStatus" class="status">未检查</div>
        <label>群机器人 Webhook</label>
        <input id="webhookUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." autocomplete="off">
        <label>签名 Secret，可选</label>
        <input id="webhookSecret" placeholder="开启签名校验时填写" autocomplete="off">
        <button onclick="saveWebhook()">保存 Webhook</button>
        <button class="secondary" onclick="testNotification('webhook')">发送测试消息</button>
      </section>
      <section class="card">
        <h2>4. 真飞书应用高级模式</h2>
        <div id="larkStatus" class="status">未检查</div>
        <label>lark-cli 路径</label>
        <input id="larkBin" placeholder="lark-cli 或 C:\\Users\\...\\run.js">
        <label>群 chat_id</label>
        <input id="larkChatId" placeholder="oc_...">
        <label>用户 open_id，可选</label>
        <input id="larkUserId" placeholder="ou_...">
        <label>聚合窗口毫秒</label>
        <input id="aggregateWindowMs" placeholder="5000">
        <button onclick="saveLarkCli()">保存高级配置</button>
        <button class="secondary" onclick="copyAgentPrompt()">复制 Agent 提示词</button>
        <button class="secondary" onclick="testNotification('lark')">发送测试消息</button>
      </section>
      <section class="card">
        <h2>5. Claude 审核 + 飞书审批卡片</h2>
        <div id="cardStatus" class="status">未检查</div>
        <label>Claude 命令</label>
        <input id="claudeBin" placeholder="claude.cmd">
        <label>Claude 模型</label>
        <input id="claudeModel" placeholder="sonnet">
        <label>飞书 App ID</label>
        <input id="feishuAppId" placeholder="cli_xxx" autocomplete="off">
        <label>飞书 App Secret</label>
        <input id="feishuAppSecret" placeholder="App Secret" autocomplete="off">
        <label>群 chat_id</label>
        <input id="feishuCardChatId" placeholder="oc_...">
        <label>回调模式</label>
        <input id="feishuCallbackMode" placeholder="http 或 ws">
        <button onclick="saveFeishuCard()">保存并启用审批卡片</button>
        <button class="secondary" onclick="testClaudeReview()">测试 Claude 审核</button>
        <button class="secondary" onclick="enableClaudeWebhook()">启用 Claude + Webhook</button>
        <button class="secondary" onclick="testNotification('claude-webhook')">测试 Claude + Webhook</button>
        <button class="secondary" onclick="testNotification('claude-feishu')">发送审批卡片测试</button>
      </section>
      <section class="card full">
        <h2>运行日志</h2>
        <pre id="output">等待操作...</pre>
      </section>
    </div>
  </main>
  <script>
    const output = document.getElementById("output");
    function write(value) { output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
    async function postJson(url, body) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || response.statusText);
      return data;
    }
    async function refreshStatus() {
      try {
        const data = await fetch("/api/setup-status").then((response) => response.json());
        document.getElementById("serviceStatus").textContent = "运行中 " + data.time;
        document.getElementById("serviceStatus").className = "status ok";
        document.getElementById("webhookStatus").textContent = data.feishuWebhook.enabled ? "已配置" : "未配置";
        document.getElementById("webhookStatus").className = "status " + (data.feishuWebhook.enabled ? "ok" : "warn");
        document.getElementById("larkStatus").textContent = data.larkCli.enabled ? "已配置" : "未配置";
        document.getElementById("larkStatus").className = "status " + (data.larkCli.enabled ? "ok" : "warn");
        document.getElementById("cardStatus").textContent = data.feishuCard.enabled ? "审批卡片已启用" : "审批卡片未启用";
        document.getElementById("cardStatus").className = "status " + (data.feishuCard.enabled ? "ok" : "warn");
        document.getElementById("larkBin").value = data.larkCli.bin || "lark-cli";
        document.getElementById("aggregateWindowMs").value = data.larkCli.aggregateWindowMs || 5000;
        document.getElementById("claudeBin").value = data.claudeReview.bin || "claude.cmd";
        document.getElementById("claudeModel").value = data.claudeReview.model || "sonnet";
        document.getElementById("feishuCallbackMode").value = data.feishuCard.callbackMode || "http";
        write(data);
      } catch (error) {
        document.getElementById("serviceStatus").textContent = "检查失败";
        document.getElementById("serviceStatus").className = "status warn";
        write(error.message);
      }
    }
    async function saveWebhook() {
      const data = await postJson("/config/feishu-webhook", {
        url: document.getElementById("webhookUrl").value,
        secret: document.getElementById("webhookSecret").value
      });
      write(data);
      refreshStatus();
    }
    async function saveLarkCli() {
      const data = await postJson("/config/lark-cli", {
        enabled: true,
        bin: document.getElementById("larkBin").value,
        chatId: document.getElementById("larkChatId").value,
        userId: document.getElementById("larkUserId").value,
        aggregateWindowMs: document.getElementById("aggregateWindowMs").value
      });
      write(data);
      refreshStatus();
    }
    async function testNotification(mode) {
      try { write(await postJson("/test-notification", { mode })); }
      catch (error) { write(error.message); }
    }
    async function testClaudeReview() {
      try { write(await postJson("/test-claude-review", {})); }
      catch (error) { write(error.message); }
    }
    async function saveFeishuCard() {
      const appSecret = document.getElementById("feishuAppSecret").value;
      const data = await postJson("/config/feishu-card", {
        appId: document.getElementById("feishuAppId").value,
        appSecret,
        chatId: document.getElementById("feishuCardChatId").value,
        callbackMode: document.getElementById("feishuCallbackMode").value || "http"
      });
      await postJson("/config/claude-review", {
        enabled: true,
        bin: document.getElementById("claudeBin").value || "claude.cmd",
        model: document.getElementById("claudeModel").value || "sonnet"
      });
      write(data);
      refreshStatus();
    }
    async function enableClaudeWebhook() {
      const data = await postJson("/config/claude-review", {
        enabled: true,
        notificationMode: "claude_webhook",
        bin: document.getElementById("claudeBin").value || "claude.cmd",
        model: document.getElementById("claudeModel").value || "sonnet"
      });
      write(data);
      refreshStatus();
    }
    async function copyAgentPrompt() {
      const text = await fetch("/AGENT_SETUP_PROMPT.md").then((response) => response.text());
      await navigator.clipboard.writeText(text);
      write("已复制 AGENT_SETUP_PROMPT.md 内容，可以粘贴给 Claude Code / Hermes / Codex。");
    }
    refreshStatus();
  </script>
</body>
</html>`;
}

app.get("/setup", (req, res) => {
  res.type("html").send(renderSetupPage());
});

app.get("/api/setup-status", (req, res) => {
  res.json(getSetupStatus());
});

app.get("/userscript/sales-message-logger.user.js", (req, res) => {
  res.type("application/javascript").sendFile(userscriptPath);
});

app.get("/userscript/gobots-after-sale-logger.user.js", (req, res) => {
  res.type("application/javascript").sendFile(gobotsUserscriptPath);
});

app.get("/AGENT_SETUP_PROMPT.md", (req, res) => {
  res.type("text/markdown").sendFile(path.join(__dirname, "AGENT_SETUP_PROMPT.md"));
});

app.post("/config/feishu-webhook", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const url = String((req.body && req.body.url) || "").trim();
  const secret = String((req.body && req.body.secret) || "").trim();
  const timeoutMs = parsePositiveNumber(req.body && req.body.timeoutMs, 10000);

  if (!isValidFeishuWebhookUrl(url)) {
    return res.status(400).json({
      success: false,
      message: "invalid Feishu webhook URL"
    });
  }

  await saveRuntimeConfig({
    feishuWebhook: {
      enabled: true,
      url,
      secret,
      timeoutMs
    }
  });

  return res.json({
    success: true,
    message: "feishu webhook saved",
    status: getSetupStatus()
  });
});

app.post("/config/lark-cli", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const bin = String((req.body && req.body.bin) || "lark-cli").trim();
  const chatId = String((req.body && req.body.chatId) || "").trim();
  const userId = String((req.body && req.body.userId) || "").trim();
  const timeoutMs = parsePositiveNumber(req.body && req.body.timeoutMs, 15000);
  const aggregateWindowMs = parsePositiveNumber(req.body && req.body.aggregateWindowMs, 5000);

  if (!chatId && !userId) {
    return res.status(400).json({
      success: false,
      message: "chatId or userId is required"
    });
  }

  await saveRuntimeConfig({
    larkCli: {
      enabled: req.body && req.body.enabled !== false,
      bin,
      chatId,
      userId,
      timeoutMs,
      aggregateWindowMs
    }
  });

  return res.json({
    success: true,
    message: "lark-cli config saved",
    status: getSetupStatus()
  });
});

app.post("/config/claude-review", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  await saveRuntimeConfig({
    notificationMode: req.body && req.body.notificationMode
      ? String(req.body.notificationMode).trim().toLowerCase()
      : getNotificationMode(),
    claudeReview: {
      enabled: req.body && req.body.enabled !== false,
      bin: String((req.body && req.body.bin) || "claude.cmd").trim(),
      model: String((req.body && req.body.model) || "sonnet").trim(),
      timeoutMs: parsePositiveNumber(req.body && req.body.timeoutMs, 120000),
      maxBudgetUsd: String((req.body && req.body.maxBudgetUsd) || "0.05").trim(),
      dataScope: String((req.body && req.body.dataScope) || "full").trim()
    }
  });

  return res.json({
    success: true,
    message: "claude review config saved",
    status: getSetupStatus()
  });
});

app.post("/config/feishu-card", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const appId = String((req.body && req.body.appId) || "").trim();
  const appSecret = String((req.body && req.body.appSecret) || "").trim();
  const chatId = String((req.body && req.body.chatId) || "").trim();
  const openId = String((req.body && req.body.openId) || "").trim();

  if (!appId || !appSecret || (!chatId && !openId)) {
    return res.status(400).json({
      success: false,
      message: "appId, appSecret, and chatId or openId are required"
    });
  }

  await saveRuntimeConfig({
    notificationMode: "feishu_card",
    feishuCard: {
      enabled: req.body && req.body.enabled !== false,
      appId,
      appSecret,
      chatId,
      openId,
      timeoutMs: parsePositiveNumber(req.body && req.body.timeoutMs, 15000),
      callbackMode: String((req.body && req.body.callbackMode) || "http").trim().toLowerCase(),
      verificationToken: String((req.body && req.body.verificationToken) || "").trim(),
      encryptKey: String((req.body && req.body.encryptKey) || "").trim()
    },
    claudeReview: {
      ...getRuntimeSection("claudeReview"),
      enabled: true
    }
  });
  startFeishuCardWsIfNeeded();

  return res.json({
    success: true,
    message: "feishu card config saved",
    status: getSetupStatus()
  });
});

app.post("/test-notification", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const mode = String((req.body && req.body.mode) || "auto").trim().toLowerCase();
  const message = buildTestMessage();

  try {
    if (mode === "claude-webhook" || mode === "claude_webhook" || (mode === "auto" && getNotificationMode() === "claude_webhook")) {
      const feishu = await sendClaudeReviewedWebhook([message]);
      return res.json({ success: true, message: "claude reviewed webhook sent", feishu });
    }

    if (mode === "claude-browser-webhook" || mode === "claude_browser_webhook" || (mode === "auto" && getNotificationMode() === "claude_browser_webhook")) {
      const feishu = await sendClaudeBrowserReviewedWebhook([message]);
      return res.json({ success: true, message: "claude browser reviewed webhook sent", feishu });
    }

    if (mode === "claude-feishu" || mode === "feishu-card" || (mode === "auto" && getNotificationMode() === "feishu_card")) {
      const feishuCard = await sendClaudeReviewedFeishuCard([message]);
      return res.json({ success: true, message: "claude reviewed feishu card sent", feishuCard });
    }

    if (mode === "webhook" || (mode === "auto" && isFeishuEnabled())) {
      const feishu = await sendToFeishu([message]);
      return res.json({ success: true, message: "webhook test sent", feishu });
    }

    if (mode === "lark" || mode === "lark-cli" || (mode === "auto" && isLarkCliEnabled())) {
      const larkCli = await sendToLarkCli(message);
      return res.json({ success: true, message: "lark-cli test sent", larkCli });
    }

    return res.status(400).json({
      success: false,
      message: "no notification channel configured"
    });
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Test notification failed:`, error);
    return res.status(502).json({
      success: false,
      message: "failed to send test notification",
      error: error.message,
      stderr: error.stderr || ""
    });
  }
});

app.post("/test-claude-review", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const message = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? normalizeIncomingMessage({
      ...buildTestMessage(),
      ...req.body
    })
    : buildTestMessage();

  try {
    const review = await reviewMessagesWithClaude([message]);
    return res.json({
      success: true,
      review
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: "failed to run Claude review",
      error: error.message,
      stderr: error.stderr || ""
    });
  }
});

app.post("/feishu/card-callback", express.json({ limit: "256kb", type: ["application/json", "*/json"] }), (req, res, next) => {
  const config = getFeishuCardConfig();
  const dispatcher = new Lark.CardActionHandler({
    verificationToken: config.verificationToken || undefined,
    encryptKey: config.encryptKey || undefined,
    loggerLevel: Lark.LoggerLevel.warn
  }, handleFeishuCardAction);

  return Lark.adaptExpress(dispatcher, { autoChallenge: true })(req, res, next);
});

app.get("/reply-actions/poll", (req, res) => {
  expireReplyActions();
  const source = String(req.query.source || "").trim();

  if (source !== "sales-consultation") {
    return res.status(400).json({
      success: false,
      message: "unsupported source"
    });
  }

  const actions = Array.from(replyActions.values())
    .filter((action) => action.source === source && action.status === "APPROVED_WAITING_BROWSER")
    .map((action) => ({
      approvalId: action.approvalId,
      orderNo: action.orderNo,
      customerName: action.customerName,
      shopName: action.shopName,
      sku: action.sku,
      packageNo: action.packageNo,
      suggestedReply: action.suggestedReply,
      customerIntent: action.customerIntent,
      risk: action.risk,
      missingInfo: action.missingInfo,
      sourcePage: action.sourcePage,
      pageHash: action.pageHash,
      expiresAt: action.expiresAt
    }));

  return res.json({
    success: true,
    actions
  });
});

app.post("/reply-actions/:approvalId/report", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const approvalId = String(req.params.approvalId || "").trim();
  const action = replyActions.get(approvalId);

  if (!action) {
    return res.status(404).json({
      success: false,
      message: "reply action not found"
    });
  }

  const status = String((req.body && req.body.status) || "").trim().toUpperCase();
  const allowed = new Set(["FILLED_DRAFT", "SENT", "CANCELED", "FAILED"]);

  if (!allowed.has(status)) {
    return res.status(400).json({
      success: false,
      message: "invalid status"
    });
  }

  if (["SENT", "CANCELED", "EXPIRED", "FAILED"].includes(action.status)) {
    return res.json({
      success: true,
      message: "already finalized",
      action
    });
  }

  action.status = status;
  action.updatedAt = getNowString();
  action.lastError = status === "FAILED" ? String((req.body && req.body.error) || "unknown error").slice(0, 1000) : "";
  action.report = {
    pageUrl: String((req.body && req.body.pageUrl) || ""),
    detail: String((req.body && req.body.detail) || "").slice(0, 2000)
  };
  await saveReplyActions();

  return res.json({
    success: true,
    message: "reply action updated",
    action
  });
});

app.get("/health", (req, res) => {
  const status = getSetupStatus();
  res.json({
    success: true,
    service: SERVICE_NAME,
    time: getNowString(),
    setupUrl: status.setupUrl,
    feishu: {
      enabled: status.feishuWebhook.enabled,
      secretConfigured: status.feishuWebhook.secretConfigured,
      queuedMessages: status.feishuWebhook.queuedMessages
    },
    larkCli: {
      enabled: status.larkCli.enabled,
      bin: status.larkCli.bin,
      chatConfigured: status.larkCli.chatConfigured,
      userConfigured: status.larkCli.userConfigured,
      aggregateWindowMs: status.larkCli.aggregateWindowMs,
      queuedMessages: status.larkCli.queuedMessages
    },
    claudeReview: status.claudeReview,
    feishuCard: status.feishuCard,
    pendingReplyActions: status.pendingReplyActions,
    notificationMode: status.notificationMode
  });
});

app.post("/test-lark-cli", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  if (!isLarkCliEnabled()) {
    return res.status(400).json({
      success: false,
      message: "LARK_CLI_ENABLED and LARK_CLI_CHAT_ID or LARK_CLI_USER_ID are required"
    });
  }

  const message = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? normalizeIncomingMessage({
      ...buildTestMessage(),
      ...req.body
    })
    : buildTestMessage();

  try {
    const larkCli = await sendToLarkCli(message);

    return res.json({
      success: true,
      message: "lark-cli test sent",
      larkCli
    });
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Lark CLI test failed:`, error);

    return res.status(502).json({
      success: false,
      message: "failed to send Lark CLI test message",
      error: error.message,
      stderr: error.stderr || ""
    });
  }
});

app.post("/test-feishu", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  if (!isFeishuEnabled()) {
    return res.status(400).json({
      success: false,
      message: "FEISHU_WEBHOOK_URL is not configured"
    });
  }

  const message = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? normalizeIncomingMessage({
      ...buildTestMessage(),
      ...req.body
    })
    : buildTestMessage();

  try {
    const feishu = await sendToFeishu(message);

    return res.json({
      success: true,
      message: "feishu test sent",
      feishu
    });
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Feishu test failed:`, error);

    return res.status(502).json({
      success: false,
      message: "failed to send Feishu test message",
      error: error.message
    });
  }
});

app.post("/log-message", express.json({ limit: "1mb", type: "application/json" }), async (req, res) => {
  if (!req.is("application/json")) {
    return res.status(415).json({
      success: false,
      message: "request body must be JSON"
    });
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      success: false,
      message: "invalid JSON body"
    });
  }

  await refreshDedupeIfNeeded();

  const incomingMessage = normalizeIncomingMessage(req.body);

  if (!requireNonEmptyOrderIdentifier(incomingMessage)) {
    return res.status(400).json({
      success: false,
      message: "orderNo or rawText is required"
    });
  }

  const message = enforceMessageSize(incomingMessage);
  const dedupeKey = createDedupeKey(message);

  if (dedupeKeys.has(dedupeKey)) {
    return res.json({
      success: true,
      message: "duplicate"
    });
  }

  dedupeKeys.add(dedupeKey);

  try {
    await outputMessage(message);
  } catch (error) {
    dedupeKeys.delete(dedupeKey);
    console.error(`[${SERVICE_NAME}] Failed to write log:`, error);

    return res.status(500).json({
      success: false,
      message: "failed to write log"
    });
  }

  try {
    await saveDedupe();
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to save dedupe file:`, error);

    return res.status(500).json({
      success: false,
      message: "failed to save dedupe file"
    });
  }

  return res.json({
    success: true,
    message: "logged"
  });
});

app.use((error, req, res, next) => {
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "invalid JSON body"
    });
  }

  if (error && error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "request body is too large"
    });
  }

  console.error(`[${SERVICE_NAME}] Unexpected server error:`, error);

  return res.status(500).json({
    success: false,
    message: "internal server error"
  });
});

function startFeishuCardWsIfNeeded() {
  const config = getFeishuCardConfig();

  if (!isFeishuCardEnabled() || config.callbackMode !== "ws" || feishuWsStarted) {
    return;
  }

  try {
    feishuWsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn
    });
    feishuWsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "card.action.trigger": handleFeishuCardAction
      })
    });
    feishuWsStarted = true;
    console.log(`[${SERVICE_NAME}] Feishu card WS callback listener started`);
  } catch (error) {
    feishuWsStarted = false;
    console.error(`[${SERVICE_NAME}] Failed to start Feishu card WS listener:`, error.message);
  }
}

async function start() {
  await refreshDedupeIfNeeded();
  await loadReplyActions();
  startFeishuCardWsIfNeeded();

  app.listen(PORT, HOST, () => {
    const status = getSetupStatus();
    console.log(`Sales Message Logger listening on http://${HOST}:${PORT}`);
    console.log(`Setup wizard available at http://${HOST}:${PORT}/setup`);
    console.log(`Lark CLI ${isLarkCliEnabled() ? "enabled" : "disabled"}`);
    console.log(`Lark aggregate window ${status.larkCli.aggregateWindowMs}ms`);
    console.log(`Feishu webhook ${isFeishuEnabled() ? "enabled" : "disabled"}`);
    console.log(`Notification mode ${status.notificationMode}`);
    console.log(`Feishu card ${status.feishuCard.enabled ? "enabled" : "disabled"}`);
    console.log(`Claude review ${status.claudeReview.enabled ? "enabled" : "disabled"}`);
  });
}

start().catch((error) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, error);
  process.exit(1);
});
