const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

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

const app = express();
const logsDir = path.join(__dirname, "logs");
const configDir = path.join(__dirname, "config");
const runtimeConfigPath = path.join(configDir, "runtime.local.json");
const userscriptPath = path.join(__dirname, "userscript", "sales-message-logger.user.js");

let dedupeDate = "";
let dedupeKeys = new Set();
let dedupeSaveQueue = Promise.resolve();
let larkCliQueue = [];
let larkCliFlushTimer = null;
let feishuQueue = [];
let feishuFlushTimer = null;
let runtimeConfig = loadRuntimeConfigSync();

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

function getSetupStatus() {
  const feishuConfig = getFeishuConfig();
  const larkConfig = getLarkCliConfig();
  return {
    success: true,
    service: SERVICE_NAME,
    time: getNowString(),
    setupUrl: `http://${HOST}:${PORT}/setup`,
    userscriptUrl: `http://${HOST}:${PORT}/userscript/sales-message-logger.user.js`,
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

function stringValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function booleanValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
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
      extra: {
        orderDomId: truncateUtf8(safeMessage.extra.orderDomId, 512),
        selector: truncateUtf8(safeMessage.extra.selector, 512)
      }
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

function buildFeishuText(message) {
  return [
    "【售后待回复消息】",
    `订单编号：${message.orderNo || "-"}`,
    `包裹编号：${message.packageNo || "-"}`,
    `客户名：${message.customerName || "-"}`,
    `店铺名：${message.shopName || "-"}`,
    `SKU：${message.sku || "-"}`,
    `是否未读：${message.unread}`,
    "",
    "客户原文：",
    message.lastCustomerOriginal || "-",
    "",
    "客户译文：",
    message.lastCustomerTranslation || "-",
    "",
    `客户消息时间：${message.lastCustomerTime || "-"}`,
    `脚本发现时间：${message.detectedAt || "-"}`,
    `来源页面：${message.sourcePage || "-"}`,
    message.truncated ? "" : null
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

function hasCustomerMessage(message) {
  return Boolean(
    String(message.lastCustomerOriginal || "").trim()
      || String(message.lastCustomerTranslation || "").trim()
      || String(message.lastCustomerTime || "").trim()
  );
}

function buildOrderSummaryLines(message, index) {
  const lines = [
    `${index}. 订单编号：${message.orderNo || "-"}`,
    `   包裹编号：${message.packageNo || "-"}`,
    `   客户名：${message.customerName || "-"}`,
    `   店铺名：${message.shopName || "-"}`,
    `   SKU：${message.sku || "-"}`,
    `   是否未读：${message.unread}`
  ];

  if (hasCustomerMessage(message)) {
    lines.push("");
    lines.push("   客户原文：");
    lines.push(`   ${message.lastCustomerOriginal || "-"}`);
    lines.push("");
    lines.push("   客户译文：");
    lines.push(`   ${message.lastCustomerTranslation || "-"}`);
    lines.push("");
    lines.push(`   客户消息时间：${message.lastCustomerTime || "-"}`);
  }

  return lines;
}

function buildLarkAggregateText(messages) {
  const sourcePage = messages.find((message) => message.sourcePage)?.sourcePage || "-";
  const detectedAt = messages[messages.length - 1]?.detectedAt || getNowString();
  const lines = [
    `【售后待回复消息】新增 ${messages.length} 条`,
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
  if (!isFeishuEnabled()) {
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

  if (!messages.length || !isFeishuEnabled()) {
    return {
      enabled: isFeishuEnabled(),
      sent: false
    };
  }

  return sendToFeishu(messages);
}

async function outputMessage(message) {
  await writeTextLog(message);

  try {
    enqueueLarkCliMessage(message);
  } catch (error) {
    console.error(`[${SERVICE_NAME}] Failed to queue Lark CLI message:`, error.message);
    if (error.stderr) {
      console.error(`[${SERVICE_NAME}] Lark CLI stderr:`, error.stderr);
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
        document.getElementById("larkBin").value = data.larkCli.bin || "lark-cli";
        document.getElementById("aggregateWindowMs").value = data.larkCli.aggregateWindowMs || 5000;
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

app.post("/test-notification", express.json({ limit: "64kb", type: ["application/json", "*/json"] }), async (req, res) => {
  const mode = String((req.body && req.body.mode) || "auto").trim().toLowerCase();
  const message = buildTestMessage();

  try {
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
    }
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

async function start() {
  await refreshDedupeIfNeeded();

  app.listen(PORT, HOST, () => {
    const status = getSetupStatus();
    console.log(`Sales Message Logger listening on http://${HOST}:${PORT}`);
    console.log(`Setup wizard available at http://${HOST}:${PORT}/setup`);
    console.log(`Lark CLI ${isLarkCliEnabled() ? "enabled" : "disabled"}`);
    console.log(`Lark aggregate window ${status.larkCli.aggregateWindowMs}ms`);
    console.log(`Feishu webhook ${isFeishuEnabled() ? "enabled" : "disabled"}`);
  });
}

start().catch((error) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, error);
  process.exit(1);
});
