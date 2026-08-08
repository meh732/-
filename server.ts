import express from "express";
import path from "path";
import fs from "fs";
import { Telegraf, Markup } from "telegraf";
import * as XLSX from "xlsx";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";

interface InventoryItem {
  code: string;
  name: string;
  stock: number;
}
interface BotConfig {
  token: string;
  adminId: string;
  groupId?: string;
  customerMessage?: string;
  groupAccess?: "all" | "admin" | "group_admins";
  botEnabled?: boolean;
  disableCustomerPm?: boolean;
  userbotApiId?: string;
  userbotApiHash?: string;
  userbotSession?: string;
  userbotEnabled?: boolean;
  userbotGroups?: string;
}
interface CustomerRequest {
  userId: string;
  username: string;
  chatId: string;
  chatTitle: string;
  itemCode: string;
  itemName: string;
  date: string;
}
interface DetectedGroup {
  id: string;
  title: string;
  username?: string;
  lastActive: string;
}
interface AppState {
  config: BotConfig;
  inventory: InventoryItem[];
  customers: CustomerRequest[];
  isRunning: boolean;
  groups?: DetectedGroup[];
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));

const normalizePersianArabicNumbers = (str: string): string => {
  const persianNumbers = [/۰/g, /۱/g, /۲/g, /۳/g, /۴/g, /۵/g, /۶/g, /۷/g, /۸/g, /۹/g];
  const arabicNumbers  = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
  let res = str;
  for (let i = 0; i < 10; i++) {
    res = res.replace(persianNumbers[i], String(i)).replace(arabicNumbers[i], String(i));
  }
  // Normalize Arabic Yeh and Kaf to Persian
  res = res.replace(/ي/g, "ی").replace(/ك/g, "ک");
  return res;
};

const sanitizeCode = (code: string | undefined): string => {
  if (!code) return "";
  let normalized = normalizePersianArabicNumbers(String(code)).toLowerCase();
  
  // Normalize key interchangeable typos/equivalents in part codes (especially common in auto parts)
  normalized = normalized
    .replace(/پ/g, 'p')
    .replace(/ک/g, 'k')
    .replace(/ی/g, 'y');

  return normalized.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '');
};

const isAdmin = (ctx: any): boolean => {
  loadState();
  if (!ctx || !ctx.from) return false;
  if (!state || !state.config || !state.config.adminId) return false;
  
  const adminIdClean = String(state.config.adminId).trim().toLowerCase();
  if (!adminIdClean) return false;

  const fromIdStr = String(ctx.from.id).trim().toLowerCase();
  if (fromIdStr === adminIdClean) return true;

  const fromUsername = ctx.from.username ? String(ctx.from.username).trim().toLowerCase() : "";
  if (fromUsername) {
    if (fromUsername === adminIdClean) return true;
    if (`@${fromUsername}` === adminIdClean) return true;
    if (adminIdClean === `@${fromUsername}`) return true;
  }

  return false;
};

const matchCodeInText = (text: string, code: string): boolean => {
  const cleanCode = sanitizeCode(code);
  if (!cleanCode) return false;

  // Rule: Ignore purely numeric codes of length < 4 to prevent matching quantities (like "1" in "1 عدد" or "12" in "12 عدد")
  const isPureNumeric = /^\d+$/.test(cleanCode);
  if (isPureNumeric && cleanCode.length < 4) {
    return false;
  }

  // Also ignore extremely short codes (length < 3) in general to prevent false matches with common abbreviations
  if (cleanCode.length < 3) {
    return false;
  }

  const normalizedText = normalizePersianArabicNumbers(text);

  // We construct a pattern where each character in cleanCode must match in sequence,
  // but can be optionally separated by common code delimiters (spaces, dots, hyphens, slashes, underscores).
  // This satisfies: "فاصله و حروف کوچک و بزرگ و خط تیره و نقطه فرق نکنه" (spaces, casing, hyphens, dots don't matter)
  const escapedChars = cleanCode.split('').map(char => {
    return char.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  });

  const charPattern = escapedChars.join('[-.\\s/_]*');

  // Boundaries: Lookbehind and Lookahead ensuring we don't start or end adjacent to alphanumeric or Persian/Arabic characters.
  // This satisfies: "بررسی کنه کد کامل باشه ... کد نصفه هم اعلام نکنه" (check that the code is complete and don't match partials).
  const regexStr = `(?<![a-zA-Z0-9\\u0600-\\u06FF])${charPattern}(?![a-zA-Z0-9\\u0600-\\u06FF])`;

  try {
    const regex = new RegExp(regexStr, 'i');
    return regex.test(normalizedText);
  } catch (err) {
    // Absolute fallback
    const simpleSanitizedText = sanitizeCode(normalizedText);
    return simpleSanitizedText === cleanCode;
  }
};

const isProd = process.env.NODE_ENV === "production";

const getStoragePath = (): string => {
  // 1. Try project root directory (process.cwd()) first (highly recommended for shared hosting/cPanel/VPS to ensure all concurrent processes sync on the same file)
  try {
    const rootPath = path.join(process.cwd(), "bot-data.json");
    fs.writeFileSync(rootPath + ".tmp", "test");
    fs.unlinkSync(rootPath + ".tmp");
    return rootPath;
  } catch (e) {
    // fallback
  }

  // 2. If project root is not writable, fall back to process.env.HOME
  if (process.env.HOME) {
    const homePath = path.join(process.env.HOME, "bot-data.json");
    try {
      fs.writeFileSync(homePath + ".tmp", "test");
      fs.unlinkSync(homePath + ".tmp");
      return homePath;
    } catch (e) {
      // fallback
    }
  }
  
  // 3. Try /tmp directory for serverless (like Cloud Run) or other jailed ephemeral hosting
  try {
    const tmpPath = path.join("/tmp", "bot-data.json");
    fs.writeFileSync(tmpPath + ".tmp", "test");
    fs.unlinkSync(tmpPath + ".tmp");
    return tmpPath;
  } catch (e) {
    // fallback
  }

  return path.join(process.cwd(), "bot-data.json");
};

const DATA_FILE = getStoragePath();
const OLD_DATA_FILE = path.join(__dirname, isProd ? ".." : "", "bot-data.json");
const WORKSPACE_DATA_FILE = path.join(process.cwd(), "bot-data.json");

const adminSessions: Record<string, { step: string, data: any }> = {};

let state: AppState = {
  config: { token: "", adminId: "", groupId: "", customerMessage: "", groupAccess: "all", botEnabled: true, disableCustomerPm: false },
  inventory: [],
  customers: [],
  isRunning: true,
  groups: [],
};

const BACKUP_FILE = DATA_FILE + ".bak";

let isLoaded = false;
let lastCheckedTime = 0;
let lastLoadedMtime = 0;
const DISK_CHECK_COOLDOWN_MS = 2000;

let lastKnownValidConfig: {
  token: string;
  adminId: string;
  groupId: string;
  customerMessage: string;
  groupAccess: "all" | "admin" | "group_admins";
  botEnabled: boolean;
  disableCustomerPm: boolean;
} = {
  token: "",
  adminId: "",
  groupId: "",
  customerMessage: "",
  groupAccess: "all",
  botEnabled: true,
  disableCustomerPm: false
};

function loadState(force = false) {
  const now = Date.now();
  if (!force && isLoaded && (now - lastCheckedTime < DISK_CHECK_COOLDOWN_MS)) {
    return;
  }
  lastCheckedTime = now;

  try {
    if (fs.existsSync(DATA_FILE)) {
      const stat = fs.statSync(DATA_FILE);
      if (!force && isLoaded && stat.mtimeMs === lastLoadedMtime) {
        return;
      }
      lastLoadedMtime = stat.mtimeMs;
    }
  } catch (e) {
    console.error("[State Load] Failed to check mtime", e);
  }

  let loadedSuccessfully = false;
  let targetFile = DATA_FILE;

  // Try to find any existing file
  if (!fs.existsSync(targetFile)) {
    if (fs.existsSync(BACKUP_FILE)) {
      targetFile = BACKUP_FILE;
    } else if (fs.existsSync(OLD_DATA_FILE)) {
      targetFile = OLD_DATA_FILE;
    } else if (fs.existsSync(WORKSPACE_DATA_FILE)) {
      targetFile = WORKSPACE_DATA_FILE;
    }
  }

  const tryLoadFromFile = (filePath: string): boolean => {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        if (!raw || raw.trim() === "") {
          console.warn(`[State Load] File ${filePath} is empty, skipping.`);
          return false;
        }
        const saved = JSON.parse(raw);
        if (saved && typeof saved === "object") {
          // Validate that it has at least some expected keys to avoid corrupt formats
          if (saved.config || saved.inventory || saved.customers || saved.groups) {
            state.config = { ...state.config, ...(saved.config || {}) };
            state.inventory = saved.inventory || [];
            state.customers = saved.customers || [];
            state.groups = saved.groups || [];
            state.isRunning = typeof saved.isRunning === 'boolean' ? saved.isRunning : true;
            
            // Cache the config if it contains valid values
            if (state.config.token || state.config.adminId) {
              lastKnownValidConfig = {
                token: state.config.token || lastKnownValidConfig.token,
                adminId: state.config.adminId || lastKnownValidConfig.adminId,
                groupId: state.config.groupId || lastKnownValidConfig.groupId,
                customerMessage: state.config.customerMessage || lastKnownValidConfig.customerMessage,
                groupAccess: state.config.groupAccess || lastKnownValidConfig.groupAccess,
                botEnabled: typeof state.config.botEnabled === "boolean" ? state.config.botEnabled : lastKnownValidConfig.botEnabled,
                disableCustomerPm: typeof state.config.disableCustomerPm === "boolean" ? state.config.disableCustomerPm : lastKnownValidConfig.disableCustomerPm,
              };
            }

            // Save back to safe storage path if we migrated or loaded from backup
            if (filePath !== DATA_FILE) {
              console.log(`[State Load] Successfully migrated/restored state from ${filePath} to safe path: ${DATA_FILE}`);
              // Use direct write to initialize the main file safely
              fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
            }
            return true;
          }
        }
      }
    } catch (e) {
      console.error(`[State Load] Error reading or parsing state file ${filePath}:`, e);
    }
    return false;
  };

  // 1. Try primary file
  loadedSuccessfully = tryLoadFromFile(DATA_FILE);

  // 2. If primary failed, try backup file
  if (!loadedSuccessfully && DATA_FILE !== BACKUP_FILE) {
    console.warn("[State Load] Primary state file load failed. Trying backup file...");
    loadedSuccessfully = tryLoadFromFile(BACKUP_FILE);
  }

  // 3. If backup failed, try OLD_DATA_FILE
  if (!loadedSuccessfully) {
    console.warn("[State Load] Backup state file load failed. Trying old/workspace fallback files...");
    loadedSuccessfully = tryLoadFromFile(OLD_DATA_FILE);
    if (!loadedSuccessfully) {
      tryLoadFromFile(WORKSPACE_DATA_FILE);
    }
  }

  // Fallback to .env variables if not set in state
  if (!state.config.adminId && process.env.ADMIN_ID) {
    state.config.adminId = process.env.ADMIN_ID;
  }
  if (!state.config.token && process.env.BOT_TOKEN) {
    state.config.token = process.env.BOT_TOKEN;
  }

  // Update last known valid config if we got them from .env fallbacks
  if (state.config.token || state.config.adminId) {
    lastKnownValidConfig.token = lastKnownValidConfig.token || state.config.token;
    lastKnownValidConfig.adminId = lastKnownValidConfig.adminId || state.config.adminId;
  }

  // Double guard: restore from memory cache if fields got wiped
  if (!state.config.token && lastKnownValidConfig.token) {
    state.config.token = lastKnownValidConfig.token;
  }
  if (!state.config.adminId && lastKnownValidConfig.adminId) {
    state.config.adminId = lastKnownValidConfig.adminId;
  }

  isLoaded = true;
}

// Initial load
loadState(true);

function saveState() {
  // Guard against saving an empty config if we previously had a valid one in memory
  if (!state.config.token && !state.config.adminId) {
    if (lastKnownValidConfig.token || lastKnownValidConfig.adminId) {
      console.warn("[State Save] Refusing to overwrite state with empty config. Restoring config from memory.");
      state.config = { ...state.config, ...lastKnownValidConfig };
    } else {
      console.warn("[State Save] Both token and adminId are empty, skipping save to avoid corrupting file.");
      return;
    }
  }

  // If one of them became empty but we had it in memory, restore it to be completely safe
  if (!state.config.token && lastKnownValidConfig.token) {
    state.config.token = lastKnownValidConfig.token;
  }
  if (!state.config.adminId && lastKnownValidConfig.adminId) {
    state.config.adminId = lastKnownValidConfig.adminId;
  }

  try {
    const rawData = JSON.stringify(state, null, 2);
    const tmpFile = DATA_FILE + ".tmp";
    
    // 1. Write to a temporary file first
    fs.writeFileSync(tmpFile, rawData, "utf-8");
    
    // 2. If backup file is supported, backup the current valid DATA_FILE
    if (fs.existsSync(DATA_FILE)) {
      try {
        fs.copyFileSync(DATA_FILE, BACKUP_FILE);
      } catch (err) {
        console.error("[State Save] Failed to create backup file", err);
      }
    }
    
    // 3. Atomically rename the temp file to the target DATA_FILE (atomic rename protects against incomplete file read/write issues)
    fs.renameSync(tmpFile, DATA_FILE);

    // Update loaded timestamp so we don't reload our own written file immediately
    try {
      const stat = fs.statSync(DATA_FILE);
      lastLoadedMtime = stat.mtimeMs;
    } catch (e) {}

  } catch (e) {
    console.error("[State Save] Failed to save state atomically:", e);
    // Fallback to direct write if renameSync fails
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      console.error("[State Save] Direct write fallback also failed:", err);
    }
  }
}

process.on('uncaughtException', (err) => {
  console.error("Uncaught Exception (Ignored to keep bot running):", err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("Unhandled Rejection (Ignored to keep bot running):", reason);
});

let bot: any = null;
let botMe: any = null;

const groupMessageQueue: Array<() => Promise<void>> = [];
let isProcessingGroupQueue = false;

const processGroupQueue = async () => {
  if (isProcessingGroupQueue) return;
  isProcessingGroupQueue = true;
  while (groupMessageQueue.length > 0) {
    const task = groupMessageQueue.shift();
    if (task) {
      try {
        await task();
      } catch (err) {
        console.error("Error executing queued group message task:", err);
      }
      // Delay of 300ms protects against Telegram API rate limits (avoiding concurrent 429 when sending/forwarding in rapid succession)
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  isProcessingGroupQueue = false;
};

const enqueueGroupMessageTask = (task: () => Promise<void>) => {
  groupMessageQueue.push(task);
  processGroupQueue();
};

function isPurchaseRequest(rawText: string): boolean {
  const normText = rawText.toLowerCase().replace(/\u200c/g, ' ').trim();

  // Negative keywords (only absolute seller/automatic confirmations to avoid self-loops or admin confirmation logs)
  const sellerKeywords = [
    "فروخته شد",
    "ارسال شد",
    "فرستاده شد",
    "ثبت شد",
    "ثبت گردید",
    "تایید شد",
    "تایید گردید",
    "حواله شد",
    "واریز شد",
    "تموم شد",
    "تمام شد",
    "ناموجود"
  ];

  for (const kw of sellerKeywords) {
    if (normText.includes(kw)) {
      return false; // Identified as a seller confirmation/update
    }
  }

  return true;
}

let userbotClient: TelegramClient | null = null;

const escapeHtml = (t: string | undefined): string => {
  if (!t) return "";
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

async function stopUserbot() {
  if (userbotClient) {
    try {
      await userbotClient.disconnect();
    } catch (e) {}
    userbotClient = null;
  }
}

async function startUserbot() {
  await stopUserbot();

  if (!state.config.userbotSession || !state.config.userbotApiId || !state.config.userbotApiHash) {
    return false;
  }

  if (state.config.userbotEnabled === false) {
    return false;
  }

  try {
    const session = new StringSession(state.config.userbotSession);
    userbotClient = new TelegramClient(
      session,
      Number(state.config.userbotApiId),
      state.config.userbotApiHash,
      { connectionRetries: 10 }
    );

    await userbotClient.connect();

    userbotClient.addEventHandler(async (event: any) => {
      try {
        const message = event.message;
        if (!message || !message.text) return;

        // Skip userbot functions if userbot is disabled
        if (state.config.userbotEnabled === false) return;

        let chat: any = null;
        try {
          chat = await message.getChat();
        } catch (e) {
          console.warn("getChat failed inside Userbot event handler, using peer details", e);
        }

        const chatIdObject = message.chatId || (chat ? chat.id : null);
        if (!chatIdObject) return;

        const chatId = String(chatIdObject);
        const chatTitle = chat ? (chat.title || "گروه") : "گروه تحت پایش سلف";
        const chatUsername = chat?.username ? String(chat.username) : "";

        // Skip if chat title indicates deleted, deactivated, or inactive group
        const lowerTitle = (chatTitle || "").toLowerCase();
        if (
          lowerTitle.includes("deleted account") || 
          lowerTitle.includes("deactivated") || 
          lowerTitle.includes("حذف شده") || 
          lowerTitle.includes("حذفی")
        ) {
          return; // Skip deleted/inactive groups
        }

        // Check if targeted to specific userbot groups
        if (state.config.userbotGroups && state.config.userbotGroups.trim() !== "") {
          const watched = state.config.userbotGroups.split(",")
            .map(x => x.trim().toLowerCase())
            .filter(Boolean);
          if (watched.length > 0) {
            const normalizeId = (id: string) => id.trim().toLowerCase().replace(/^-100/, "").replace(/^-/, "");
            const normChatId = normalizeId(chatId);
            
            const cleanStringForMatch = (s: string) => {
              const normalized = normalizePersianArabicNumbers(s).toLowerCase();
              return normalized.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, "");
            };
            const normChatTitle = cleanStringForMatch(chatTitle || "");

            const isMatch = watched.some(w => {
              const normW = normalizeId(w);
              
              // 1. Match by ID
              if (normChatId === normW) return true;
              
              // 2. Match by Username (ignores @ and is case-insensitive)
              if (chatUsername) {
                const cleanU = chatUsername.toLowerCase().replace(/^@/, "");
                const cleanW = w.replace(/^@/, "");
                if (cleanU === cleanW) return true;
              }

              // 3. Match by Group Title (ignores spaces, dots, and is case-insensitive)
              const normWTitle = cleanStringForMatch(w);
              if (normWTitle && (normChatTitle.includes(normWTitle) || normWTitle.includes(normChatTitle))) {
                return true;
              }

              return false;
            });

            if (!isMatch) return; // ignore unwatched chat
          }
        }

        // Perform purchase intent checks
        if (!isPurchaseRequest(message.text)) return;

        const normalizedText = normalizePersianArabicNumbers(message.text);
        const foundItems = state.inventory.filter(item => {
          // Check code match strictly
          if (matchCodeInText(normalizedText, item.code)) return true;
          return false;
        });

        if (foundItems.length > 0) {
          let adminNotifyMsg = `📥 <b>ثبت درخواست خرید جدید از طریق ربات کاربر (سلف)!</b>\n\n`;
          adminNotifyMsg += `👥 <b>مشخصات گروه:</b> ${escapeHtml(chatTitle)}\n`;
          adminNotifyMsg += `🆔 <b>آیدی گروه:</b> <code>${chatId}</code>\n\n`;

          const sender = await message.getSender().catch(() => null);
          const senderId = sender ? String(sender.id) : String(message.senderId || "");
          const senderFirstName = sender ? (sender.firstName || "") : "";
          const senderLastName = sender ? (sender.lastName || "") : "";
          const senderUsername = sender ? (sender.username || "") : "";

          adminNotifyMsg += `👤 <b>مشخصات خریدار:</b>\n`;
          adminNotifyMsg += `🔹 نام: <a href="tg://user?id=${senderId}"><b>${escapeHtml((senderFirstName + " " + senderLastName).trim() || "ناشناس")}</b></a>\n`;
          adminNotifyMsg += `🔹 نام کاربری: <a href="tg://user?id=${senderId}">${senderUsername ? `@${escapeHtml(senderUsername)}` : "بدون‌یوزرنیم"}</a>\n`;
          adminNotifyMsg += `🆔 <b>آیدی عددی خریدار:</b> <a href="tg://user?id=${senderId}"><code>${senderId}</code></a>\n\n`;
          adminNotifyMsg += `📦 <b>کالاهای اسکن‌شده:</b> \n\n`;

          let hasAvailable = false;
          for (const item of foundItems) {
            if (Number(item.stock) > 0) {
              hasAvailable = true;

              if (!state.customers) state.customers = [];
              state.customers.push({
                 userId: senderId,
                 username: senderUsername || "بدون‌نام",
                 chatId: chatId,
                 chatTitle: chatTitle,
                 itemCode: String(item.code),
                 itemName: String(item.name),
                 date: new Date().toISOString()
              });

              adminNotifyMsg += `✅ <b>کد محصول:</b> <code>${escapeHtml(item.code)}</code>\n`;
              adminNotifyMsg += `🔸 <b>نام محصول:</b> ${escapeHtml(item.name)}\n`;
              adminNotifyMsg += `🔢 <b>موجودی در انبار:</b> <b>${escapeHtml(String(item.stock))}</b>\n\n`;

              // Send private alert template to customer
              if (state.config.disableCustomerPm !== true && senderId) {
                let pmText = state.config.customerMessage && state.config.customerMessage.trim() !== ""
                  ? state.config.customerMessage
                  : `سلام دوست گرامی، درخواست شما برای خرید کالای «<b>{name}</b>» با کد «<b>{code}</b>» با موفقیت ثبت شد.\nمدیریت ربات به زودی برای هماهنگی‌های لازم با شما ارتباط می‌گیرد.🌸`;
                pmText = pmText.replace(/{code}/g, item.code).replace(/{name}/g, item.name);

                let customerNotifiedByBot = false;
                if (bot) {
                  try {
                    await bot.telegram.sendMessage(senderId, pmText, { parse_mode: 'HTML' });
                    customerNotifiedByBot = true;
                  } catch (e) {
                    console.warn(`Main bot failed to PM client ${senderId}. Trying via Userbot...`, e);
                  }
                }

                if (!customerNotifiedByBot && userbotClient) {
                  try {
                    await userbotClient.sendMessage(senderId, { message: pmText, parseMode: 'html' });
                  } catch (ue) {
                    console.error("Userbot failed to PM client:", ue);
                  }
                }
              }
            }
          }

          if (hasAvailable) {
            saveState();
            adminNotifyMsg += `📝 <b>متن پیام خریدار:</b>\n« ${escapeHtml(message.text)} »\n\n`;

            let notifiedAdminByBot = false;
            if (bot && state.config.adminId) {
              try {
                await bot.telegram.sendMessage(state.config.adminId, adminNotifyMsg, { parse_mode: 'HTML' });
                notifiedAdminByBot = true;
              } catch (notifyErr) {
                console.error("Failed to notify admin via main Bot:", notifyErr);
              }
            }

            // Fallback: Notify admin directly via Userbot PV!
            if (!notifiedAdminByBot && state.config.adminId && userbotClient) {
              try {
                const target = (botMe && botMe.username) ? botMe.username : state.config.adminId;
                await userbotClient.sendMessage(target, {
                  message: adminNotifyMsg,
                  parseMode: 'html'
                });
              } catch (uErr) {
                console.error("Failed to notify admin via Userbot client:", uErr);
              }
            }

            // Forward the original post to admin for context
            if (state.config.adminId && userbotClient) {
              try {
                const forwardTarget = (botMe && botMe.username) ? botMe.username : state.config.adminId;
                await userbotClient.forwardMessages(forwardTarget, {
                  messages: [message.id],
                  fromPeer: chatIdObject
                });
              } catch (forwardErr) {
                console.error("Failed userbot message forwarding to admin:", forwardErr);
              }
            }
          }
        }
      } catch (evtErr) {
        console.error("Error inside Userbot message handler", evtErr);
      }
    }, new NewMessage({}));

    console.log("🚀 Userbot successfully connected and listening to target groups.");
    return true;
  } catch (err) {
    console.error("Failed to start Userbot client", err);
    return false;
  }
}

const showInventoryPage = async (ctx: any, page: number, isEdit = false) => {
  const itemsPerPage = 10;
  const totalItems = state.inventory.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  
  const startIdx = safePage * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const items = state.inventory.slice(startIdx, endIdx);

  if (items.length === 0) {
    const emptyMsg = "📦 لیست کالاها خالی است.";
    if (isEdit) {
      return ctx.editMessageText(emptyMsg).catch(() => {});
    }
    return ctx.reply(emptyMsg);
  }

  let text = `📦 *لیست کالاهای موجود* (صفحه ${safePage + 1} از ${totalPages})\n\n`;
  const buttons: any[][] = [];

  items.forEach((item) => {
    text += `🔹 *کد:* \`${item.code}\`\n`;
    text += `📝 *نام:* ${item.name}\n`;
    text += `📦 *موجودی:* ${item.stock}\n\n`;
    
    // Add inline buttons for this item with style fields (Telegram Bot API 9.4+)
    buttons.push([
      { text: `🗑️ حذف ${item.code}`, callback_data: `inv_del_${item.code}`, style: 'danger' },
      { text: `✏️ ویرایش ${item.code}`, callback_data: `inv_edit_${item.code}`, style: 'primary' },
      { text: `➕ موجودی ${item.code}`, callback_data: `inv_addstock_${item.code}`, style: 'success' }
    ]);
  });

  // Pagination row
  const paginationRow = [];
  if (safePage > 0) {
    paginationRow.push({ text: "◀️ صفحه قبلی", callback_data: `inv_page_${safePage - 1}`, style: 'primary' });
  }
  if (safePage < totalPages - 1) {
    paginationRow.push({ text: "صفحه بعدی ▶️", callback_data: `inv_page_${safePage + 1}`, style: 'primary' });
  }
  if (paginationRow.length > 0) {
    buttons.push(paginationRow);
  }

  // Add Search Button
  buttons.push([{ text: "🔍 جستجوی سریع کالا", callback_data: "action_search_product", style: 'primary' }]);

  const replyOptions = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  };

  if (isEdit) {
    try {
      await ctx.editMessageText(text, replyOptions);
    } catch (err: any) {
      if (!err.message?.includes('message is not modified')) {
        console.error(err);
      }
    }
  } else {
    await ctx.reply(text, replyOptions);
  }
};

async function startBot() {
  if (bot) {
    try {
      bot.stop();
    } catch (e) {}
  }

  if (!state.config.token || !state.config.adminId) {
    state.isRunning = false;
    saveState();
    return false;
  }

  try {
    bot = new Telegraf(state.config.token);

    // Middleware to hot-reload state on every bot request to stay synced across processes
    bot.use(async (ctx: any, next: any) => {
      loadState();
      return await next();
    });

    // Retrieve bot details and configure command list (Menu button next to chat box)
    try {
      botMe = await bot.telegram.getMe();
      
      // Clear global commands for everyone
      await bot.telegram.setMyCommands([]);
      
      // Set commands specifically only in the private chat scopes so they don't show up in groups
      const adminCommands = [
        { command: 'start', description: 'شروع ربات و منوی راهنما' },
        { command: 'add', description: 'افزودن دستی کالا' },
        { command: 'delete', description: 'حذف دستی کالا' },
        { command: 'backup', description: 'دریافت بکاپ' },
        { command: 'settings', description: 'تنظیمات ربات' },
        { command: 'setmsg', description: 'تغییر پیام ارسال' },
        { command: 'help', description: 'راهنما' }
      ];
      
      await bot.telegram.setMyCommands(adminCommands, { scope: { type: 'all_private_chats' } });
      
      console.log(`Bot @${botMe.username} is connected.`);
    } catch (cmdErr) {
      console.error("Failed to get bot details or set commands menu", cmdErr);
    }

    // Command handle to test if bot reacts to admin or user
    bot.command('start', (ctx: any) => {
      if (ctx.chat.type === "private") {
        if (isAdmin(ctx)) {
          ctx.reply(
            "سلام مدیر محترم! 🌹\n" +
            "به بخش کنترل انبار و سفارش‌ها خوش آمدید.\n\n" +
            "📌 برای مدیریت سریع‌تر، می‌توانید از گرید منوی شیک زیر برای انجام کارها استفاده کنید یا به سادگی دستورات را ارسال دارید:\n\n" +
            "📥 ۱. ثبت دسته‌جمعی کالاها:\n" +
            "کافیست فایل اکسل خود را مستقیماً به همینجا بفرستید تا فوراً جایگزین شود.\n\n" +
            "✍️ ۲. افزودن/ویرایش دستی کالا:\n" +
            "روی دکمه «✍️ ثبت و ویرایش دستی کالا» در منوی پایین کلیک کنید تا مرحله به مرحله کالا را اضافه کنید.\n\n" +
            "🗑 ۳. حذف دستی کالا:\n" +
            "فرمت دستور: `/delete کد کالا`\n\n" +
            "📥 ۴. پشتیبان‌گیری:\n" +
            "روی دکمه دریافت پشتیبان بزنید تا بلافاصله آخرین وضعیت اکسل انبار و مشتریان ارسال شود.",
            Markup.keyboard([
              [
                "✍️ ثبت و ویرایش دستی کالا",
                "📦 لیست کالاهای موجود"
              ],
              [
                "🔎 جستجوی کالا",
                "🗑️ حذف دستی کالا"
              ],
              [
                "📤 آپلود موجودی انبار (اکسل)",
                "📥 دریافت فایل پشتیبان انبار"
              ],
              [
                "⚙️ تنظیمات ربات",
                "💡 راهنمای کامل"
              ]
            ]).resize()
          );
        } else {
          ctx.reply(`سلام گرامی! خوش آمدید. 🌸\nشما امکان دسترسی به پنل مدیریتی این ربات را ندارید. ربات در گروه‌های کاری تنظیم‌شده فعال است و کدهای کالا را پایش می‌نماید.`);
        }
      }
    });

    // Custom Button Listeners for Admin Menu
    bot.hears(/✍️.*ثبت و ویرایش دستی کالا/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        ctx.reply(
          "👇 جهت افزودن یا ویرایش دستی کالا از طریق دکمه زیر اقدام کنید:",
          Markup.inlineKeyboard([
            [Markup.button.callback("➕ افزودن/ویرایش کالا", "start_add_product")]
          ])
        );
      }
    });

    bot.action("start_add_product", async (ctx: any) => {
      if (isAdmin(ctx)) {
        adminSessions[ctx.from.id] = { step: 'awaiting_product_code', data: {} };
        await ctx.answerCbQuery();
        await ctx.editMessageText("📝 لطفاً **کد کالا** را ارسال کنید:\n\n(برای انصراف از دکمه زیر استفاده کنید)", {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]]
          }
        });
      }
    });

    bot.action("cancel_add_product", async (ctx: any) => {
      if (isAdmin(ctx)) {
        delete adminSessions[ctx.from.id];
        await ctx.answerCbQuery("عملیات لغو شد.");
        await ctx.editMessageText("❌ عملیات جاری لغو شد.");
      }
    });

    bot.hears(/🗑️.*حذف دستی کالا/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        adminSessions[ctx.from.id] = { step: 'awaiting_delete_search', data: {} };
        ctx.reply("🗑️ لطفاً **نام** یا **کد** کالا را برای حذف ارسال کنید:", {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]]
          }
        });
      }
    });

    bot.hears(/📦.*لیست کالاهای موجود/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        showInventoryPage(ctx, 0);
      }
    });

    bot.hears(/🔎.*جستجوی کالا/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        adminSessions[ctx.from.id] = { step: 'awaiting_search_query', data: {} };
        ctx.reply("🔎 لطفاً **کد** یا **نام** کالا را برای جستجو وارد کنید:\n\n(برای انصراف از دکمه زیر استفاده کنید)", {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]] }
        });
      }
    });

    bot.action("action_search_product", async (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        adminSessions[ctx.from.id] = { step: 'awaiting_search_query', data: {} };
        await ctx.answerCbQuery();
        ctx.reply("🔎 لطفاً **کد** یا **نام** کالا را برای جستجو وارد کنید:\n\n(برای انصراف از دکمه زیر استفاده کنید)", {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]] }
        });
      } else {
        await ctx.answerCbQuery("❌ شما دسترسی ندارید.", { show_alert: true }).catch(() => {});
      }
    });

    bot.action(/^inv_page_(\d+)$/, (ctx: any) => {
      if (isAdmin(ctx)) {
        const page = parseInt(ctx.match[1], 10);
        showInventoryPage(ctx, page, true);
      }
    });

    bot.action(/^inv_del_(.+)$/, async (ctx: any) => {
      if (isAdmin(ctx)) {
        const code = ctx.match[1];
        const querySanitized = sanitizeCode(code);
        const existingItems = state.inventory.filter(item => {
          return item.code === code || sanitizeCode(item.code) === querySanitized || sanitizeCode(item.name) === querySanitized;
        });
        if (existingItems.length > 0) {
          state.inventory = state.inventory.filter(item => !existingItems.includes(item));
          saveState();
          await ctx.answerCbQuery(`✅ کالا (${code}) با موفقیت حذف شد.`, { show_alert: true });
          
          const pageStr = ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.flat()?.find((b: any) => b.callback_data?.startsWith('inv_page_'))?.callback_data?.split('_')[2];
          const page = pageStr ? parseInt(pageStr, 10) : 0;
          showInventoryPage(ctx, page, true);
        } else {
          await ctx.answerCbQuery(`❌ کالا با مشخصات ${code} یافت نشد.`, { show_alert: true });
        }
      }
    });

    bot.action(/^inv_edit_(.+)$/, async (ctx: any) => {
      if (isAdmin(ctx)) {
        const code = ctx.match[1];
        adminSessions[ctx.from.id] = { step: 'awaiting_product_name', data: { code: code } };
        await ctx.answerCbQuery();
        ctx.reply(`✍️ ویرایش کالای ${code}\n\nلطفاً **نام جدید کالا** را وارد کنید:`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]] }
        });
      }
    });

    bot.action(/^inv_addstock_(.+)$/, async (ctx: any) => {
      if (isAdmin(ctx)) {
        const code = ctx.match[1];
        adminSessions[ctx.from.id] = { step: 'awaiting_add_stock', data: { code: code } };
        await ctx.answerCbQuery();
        ctx.reply(`➕ تغییر موجودی کالای ${code}\n\nلطفاً **تعداد موجودی جدید** را به صورت عدد وارد کنید:`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]] }
        });
      }
    });

    bot.hears(/📤.*آپلود موجودی انبار/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        ctx.replyWithMarkdown(
          "📤 *بارگذاری دسته‌جمعی لیست کالاها از اکسل:*\n\n" +
          "شما می‌توانید یک فایل اکسل با فرمت `.xlsx` که شامل حداقل سه ستون `کد`، `نام` و `موجودی` است را مستقیماً همینجا در بات ارسال کنید تا موجودی انبار بلافاصله بروز و جایگزین شود.\n\n" +
          "همین حالا می‌توانید فایل اکسل خود را بفرستید. 📎👇"
        );
      }
    });

    bot.hears(/📥.*دریافت فایل پشتیبان/i, async (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
         try {
            ctx.reply("در حال بازیابی اطلاعات و ساخت فایل اکسل پشتیبان...");
            
            const wb = XLSX.utils.book_new();
            
            // Sheet 1: Inventory
            const wsInv = XLSX.utils.json_to_sheet(state.inventory || []);
            XLSX.utils.book_append_sheet(wb, wsInv, "Inventory");

            // Sheet 2: Customers
            const wsCust = XLSX.utils.json_to_sheet(state.customers || []);
            XLSX.utils.book_append_sheet(wb, wsCust, "Customers");

            const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

            await ctx.replyWithDocument({
              source: buffer,
              filename: `backup_${new Date().toISOString().split('T')[0]}.xlsx`
            }, { caption: "✅ فایل پشتیبان شامل آخرین تغییرات موجودی انبار و لیست تقاضای مشتریان مجاز." });

         } catch (e: any) {
              console.error(e);
              ctx.reply("❌ خطا در اجرای پشتیبان‌گیری: " + e.message);
         }
      }
    });

    bot.hears(/💡.*راهنمای کامل/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        ctx.reply(
          "💡 *راهنمای کامل سیستم پایش هوشمند انبار:*\n\n" +
          "۱. ربات را وارد گروه‌ها یا سوپرگروه‌های مبادلات و فروش خود کنید.\n" +
          "۲. بر روی یکی از کدهای ارسال‌شده کالا کلیک یا پایش کنید. ربات پیام گروه را اسکن کرده و چنانچه با لیست انبار مطابقت داشته باشد، فرایند ثبت شروع می‌شود.\n" +
          "۳. ربات جزئیات محصول و توضیحات انتخابی شما را مستقیماً و به شکل پیام خصوصی (PV) به دست مشتری واگذار می‌کند.\n" +
          "۴. همزمان یک گزارش دقیق حاوی کد محصول، نام دقیق و آیدی عددی خریدار برای پیگیری نهایی برای پی‌وی شما (مدیر محترم) مخابره خواهد شد.\n" +
          "۵. در صورتی که مشتری پیشتر دکمه استارت ربات را در پی‌وی نزده باشد، ربات به او در گروه یادآور می‌شود تا ربات را استارت کند.",
          { parse_mode: 'Markdown' }
        );
      }
    });

    const showAdminSettingsKeyboard = (ctx: any) => {
      const isScanOn = state.config.botEnabled !== false;
      const isPmEnabled = !state.config.disableCustomerPm;
      
      let msg = `⚙️ *تنظیمات و پیکربندی ربات مانیتورینگ:*\n\n`;
      msg += `🤖 *وضعیت اسکن و پایش کدها:* ${isScanOn ? "🟢 *روشن (فعال)*" : "🔴 *خاموش (غیرفعال)*"}\n`;
      msg += `💬 *ارسال پیام به خریدار در پی‌وی:* ${isPmEnabled ? "🟢 *فعال*" : "🔴 *غیرفعال (فقط اطلاع‌رسانی به ادمین)*"}\n\n`;
      
      const currentMsg = state.config.customerMessage && state.config.customerMessage.trim() !== ""
        ? state.config.customerMessage
        : `سلام دوست گرامی، درخواست شما برای خرید کالای «*{name}*» با کد «*{code}*» با موفقیت ثبت شد.\nمدیریت ربات به زودی برای هماهنگی‌های لازم با شما ارتباط می‌گیرد.🌸`;
      
      msg += `📝 *متن پیام ارسالی به خریدار (قالب):*\n_${currentMsg}_\n\n`;
      msg += `💡 *دکمه‌های زیر را برای تغییر وضعیت‌های بالا انتخاب کنید:*`;

      return ctx.replyWithMarkdown(msg, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${isScanOn ? "🟢 فعال | 🤖 پایش و اسکن آنلاین" : "🔴 غیرفعال | 🤖 پایش خاموش"}`,
                callback_data: "toggle_scan",
                style: isScanOn ? "success" : "danger"
              }
            ],
            [
              {
                text: `${isPmEnabled ? "🟢 فعال | 💬 ارسال پیام به خریدار" : "🔴 خاموش | 💬 عدم ارسال پیام خریدار"}`,
                callback_data: "toggle_pm",
                style: isPmEnabled ? "success" : "danger"
              }
            ],
            [
              {
                text: "✍️ ویرایش قالب متن پیام خریدار",
                callback_data: "edit_msg_template",
                style: "primary"
              }
            ]
          ]
        }
      });
    };

    bot.hears(/⚙️.*تنظیمات ربات/i, (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        showAdminSettingsKeyboard(ctx);
      }
    });

    bot.command("settings", (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        showAdminSettingsKeyboard(ctx);
      }
    });

    bot.command("setmsg", (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        const text = ctx.message.text || "";
        const pfx = "/setmsg";
        const newMsg = text.slice(pfx.length).trim();
        if (!newMsg) {
          return ctx.reply("❌ لطفاً قالب متن مدنظرتان را بعد از دستور `/setmsg` بنویسید.\n\nمثال:\n`/setmsg سفارش خرید کالا {name} ثبت شد.`", { parse_mode: 'Markdown' });
        }
        state.config.customerMessage = newMsg;
        saveState();
        ctx.reply(`✅ قالب متن پیام خریدار با موفقیت بروزرسانی شد:\n\n«${newMsg}»`);
      }
    });

    bot.action("toggle_scan", async (ctx: any) => {
      if (isAdmin(ctx)) {
        state.config.botEnabled = state.config.botEnabled === false ? true : false;
        saveState();
        await ctx.answerCbQuery(`پایش اسکن کد کالا به ${state.config.botEnabled ? "روشن" : "خاموش"} تغییر یافت.`);
        try {
          await ctx.deleteMessage();
        } catch (e) {}
        showAdminSettingsKeyboard(ctx);
      } else {
        await ctx.answerCbQuery("❌ دسترسی غیرمجاز", { show_alert: true });
      }
    });

    bot.action("toggle_pm", async (ctx: any) => {
      if (isAdmin(ctx)) {
        state.config.disableCustomerPm = !state.config.disableCustomerPm;
        saveState();
        await ctx.answerCbQuery(`ارسال پیام به خریدار ${state.config.disableCustomerPm ? "غیرفعال" : "فعال"} شد.`);
        try {
          await ctx.deleteMessage();
        } catch (e) {}
        showAdminSettingsKeyboard(ctx);
      } else {
        await ctx.answerCbQuery("❌ دسترسی غیرمجاز", { show_alert: true });
      }
    });

    bot.action("edit_msg_template", async (ctx: any) => {
      if (isAdmin(ctx)) {
        await ctx.answerCbQuery();
        ctx.reply(
          "✍️ *دستور تغییر متن ارسالی به خریدار:*\n\n" +
          "برای ثبت قالب دلخواه جدید، دستور `/setmsg` را در ابتدای پیام قرار داده و در ادامه متن مدنظرتان را بنویسید.\n\n" +
          "👉 `/setmsg سلام سفارش کالا {name} با موفقیت ثبت شد.`\n\n" +
          "💡 *نکته:* می‌توانید در متن از کلمات کلیدی `{code}` و `{name}` استفاده کنید تا خودکار جایگزین شوند.",
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.answerCbQuery("❌ دسترسی غیرمجاز", { show_alert: true });
      }
    });

    bot.command('add', (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        const text = ctx.message.text || "";
        const parts = text.slice(5).split('|'); // skip '/add '
        if (parts.length < 2) {
          return ctx.reply(
            "✍️ *راهنمای ثبت و ویرایش دستی کالا:*\n\n" +
            "فرمت دستور به شکل زیر است:\n" +
            "👉 `/add کد کالا | نام کالا | تعداد موجودی`\n\n" +
            "مثال: `/add SH-101 | تیشرت نخی قرمز | 15`"
          );
        }

        const code = parts[0].trim();
        const name = parts[1].trim();
        const stockStr = parts[2] ? parts[2].trim() : "1";
        const stock = isNaN(Number(stockStr)) ? 1 : Number(stockStr);

        if (!state.inventory) state.inventory = [];
        const existingIdx = state.inventory.findIndex(item => sanitizeCode(item.code) === sanitizeCode(code));

        if (existingIdx !== -1) {
          state.inventory[existingIdx] = { code, name, stock };
          ctx.reply(`✅ کالا با موفقیت ویرایش شد:\nکد: \`${code}\`\nنام: ${name}\nموجودی جدید: ${stock}`);
        } else {
          state.inventory.push({ code, name, stock });
          ctx.reply(`✅ کالا با موفقیت افزوده شد:\nکد: \`${code}\`\nنام: ${name}\nموجودی: ${stock}`);
        }
        saveState();
      } else {
        if (ctx.chat.type === "private") {
          ctx.reply("❌ این دستور مخصوص مدیر ربات است.");
        }
      }
    });

    bot.command('delete', (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        const text = ctx.message.text || "";
        const targetQuery = text.slice(7).trim(); // skip '/delete'
        if (!targetQuery) {
          return ctx.reply(
            "✍️ *راهنمای حذف دستی کالا:*\n\n" +
            "کافیست دستور را به همراه کد یا نام محصول قرار دهید:\n" +
            "👈 `/delete کد یا نام کالا`\n\n" +
            "مثال: `/delete SH-101` یا `/delete تیشرت`"
          );
        }

        if (!state.inventory) state.inventory = [];
        const querySanitized = sanitizeCode(targetQuery);
        const queryNormalized = normalizePersianArabicNumbers(targetQuery).toLowerCase();

        const existingItems = state.inventory.filter(item => {
          const codeSan = sanitizeCode(item.code);
          const nameSan = sanitizeCode(item.name);
          const codeNorm = normalizePersianArabicNumbers(item.code || "").toLowerCase();
          const nameNorm = normalizePersianArabicNumbers(item.name || "").toLowerCase();

          return codeSan === querySanitized ||
                 nameSan === querySanitized ||
                 codeNorm === queryNormalized ||
                 nameNorm === queryNormalized ||
                 (queryNormalized.length >= 2 && (codeNorm.includes(queryNormalized) || nameNorm.includes(queryNormalized)));
        });

        if (existingItems.length > 0) {
          const deletedListStr = existingItems.map(i => `${i.code} (${i.name})`).join(', ');
          state.inventory = state.inventory.filter(item => !existingItems.includes(item));
          saveState();
          ctx.reply(`✅ کالا(های) زیر با موفقیت از انبار حذف شد(ند):\n\n${deletedListStr}`);
        } else {
          ctx.reply(`❌ کالایی با کد یا نام \`${targetQuery}\` در لیست انبار یافت نشد.`);
        }
      } else {
        if (ctx.chat.type === "private") {
          ctx.reply("❌ این دستور مخصوص مدیر ربات است.");
        }
      }
    });

    bot.command('help', (ctx: any) => {
      if (ctx.chat.type === "private") {
        if (isAdmin(ctx)) {
          ctx.reply("💡 راهنمای استفاده از ربات مانیتورینگ موجودی کالا:\n\n۱. برای شروع، ربات را در گروه‌های کاری خود عضو کنید.\n۲. هر کدی که در چت گروه نوشته شود و دقیقاً با یکی از کدهای تعریف‌ شده در انبار همخوانی داشته باشد توسط ربات اسکن می‌گردد.\n۳. بلافاصله مشخصات محصول برای کاربر ارسال شده و برای مدیر نیز یک پیام اطلاع‌رسانی فرستاده خواهد شد.\n۴. در صورتی که کاربر ربات را استارت نکرده باشد، ربات در همان گروه به او یادآوری می‌کند تا ابتدا ربات را استارت نماید.");
        } else {
          ctx.reply(`سلام! این ربات برای پیدا کردن کدهای انبار در گروه‌های مبادله‌ای تعریف شده است. پیامی شامل کد صحیح محصول بفرستید تا اطلاعات خرید به چت شخصی شما فرستاده شود.`);
        }
      }
    });

    // Helper commands to get Group ID or User ID easily
    bot.command(['myid', 'getid', 'groupid', 'id'], async (ctx: any) => {
      const senderId = String(ctx.from.id);
      const adminId = state.config.adminId;

      if (ctx.chat.type === "private") {
        ctx.reply(`🆔 آیدی عددی شما: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
        return;
      }

      // In group/supergroup: Only answer if sender is the bot admin to prevent regular members access
      if (adminId && senderId === adminId) {
        ctx.reply(
          `👥 *اطلاعات گروه فعلی شما:*\n\n` +
          `🔹 *عنوان گروه:* ${ctx.chat.title || 'بدون نام'}\n` +
          `🆔 *آیدی عددی گروه:* \`${ctx.chat.id}\` ${ctx.chat.username ? `\n🔗 *یوزرنیم گروه:* @${ctx.chat.username}` : ""}\n\n` +
          `💡 برای اینکه اسکن کالاها محدود به همین گروه شود، این آیدی عددی را در بخش گروه هدف پنل مدیریت ذخیره کنید.`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Event listener when bot is added to a new group/supergroup
    bot.on("new_chat_members", async (ctx: any) => {
      const meAdmin = botMe?.username;
      const addedMembers = ctx.message?.new_chat_members || [];
      const wasBotAdded = addedMembers.some((member: any) => member.username === meAdmin);

      if (wasBotAdded && ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        const grpId = String(ctx.chat.id);
        const grpTitle = ctx.chat.title || "گروه بدون نام";
        const grpUsername = ctx.chat.username ? String(ctx.chat.username) : "";

        if (!state.groups) state.groups = [];
        const existingGrpIdx = state.groups.findIndex(g => String(g.id) === grpId);
        const groupInfo = {
          id: grpId,
          title: grpTitle,
          username: grpUsername ? `@${grpUsername}` : undefined,
          lastActive: new Date().toISOString()
        };

        if (existingGrpIdx !== -1) {
          state.groups[existingGrpIdx] = groupInfo;
        } else {
          state.groups.push(groupInfo);
        }
        saveState();

        // Inform admin about newly joined group ID securely in PV
        if (state.config.adminId) {
          try {
            await bot.telegram.sendMessage(state.config.adminId, 
              `🔔 *ربات به گروه جدیدی اضافه شد!*\n\n` +
              `👥 نام گروه: *${grpTitle}*\n` +
              `🆔 آیدی عددی گروه (Group ID): \`${grpId}\` ${grpUsername ? `\n🔗 یوزرنیم گروه: @${grpUsername}` : ""}\n\n` +
              `💡 برای اسکن کالاها فقط در این گروه خاص، می‌توانید این آیدی عددی را کپی کرده و در بخش تنظیمات پنل مدیریت ذخیره کنید تا فعال شود.`,
              { parse_mode: 'Markdown' }
            );
          } catch (err) {
            console.error("Failed to notify admin on new_chat_members", err);
          }
        }
      }
    });

    bot.command('backup', async (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
         try {
            ctx.reply("در حال آماده‌سازی فایل بکاپ...");
            
            const wb = XLSX.utils.book_new();
            
            // Sheet 1: Inventory
            const wsInv = XLSX.utils.json_to_sheet(state.inventory || []);
            XLSX.utils.book_append_sheet(wb, wsInv, "Inventory");

            // Sheet 2: Customers
            const wsCust = XLSX.utils.json_to_sheet(state.customers || []);
            XLSX.utils.book_append_sheet(wb, wsCust, "Customers");

            const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

            await ctx.replyWithDocument({
              source: buffer,
              filename: `backup_${new Date().toISOString().split('T')[0]}.xlsx`
            }, { caption: "✅ فایل بکاپ شامل موجودی فعلی و لیست درخواست‌های مشتریان" });

         } catch (e: any) {
             console.error(e);
             ctx.reply("❌ خطا در گرفتن بکاپ: " + e.message);
          }
      }
    });

    bot.on("document", async (ctx: any) => {
      if (ctx.chat.type === "private" && isAdmin(ctx)) {
        const doc = ctx.message.document;
        if (doc.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || doc.file_name?.endsWith('.xlsx') || doc.file_name?.endsWith('.xls')) {
           ctx.reply("در حال بررسی و بروزرسانی موجودی انبار...");
           try {
              const fileLink = await ctx.telegram.getFileLink(doc.file_id);
              const response = await fetch(fileLink.toString());
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              
              const wb = XLSX.read(buffer, { type: 'buffer' });
              const wsname = wb.SheetNames[0];
              const ws = wb.Sheets[wsname];
              const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
              
              if (data.length < 2) {
                return ctx.reply("❌ فایل اکسل خالی است یا ستون‌های مناسب را ندارد.");
              }

              const headers = data[0].map((h: string) => h?.toString().toLowerCase().trim());
              const codeIdx = headers.findIndex((h: string) => h === 'کد' || h === 'code');
              const nameIdx = headers.findIndex((h: string) => h === 'نام' || h === 'name' || h === 'title' || h === 'عنوان');
              const stockIdx = headers.findIndex((h: string) => h === 'موجودی' || h === 'stock' || h === 'qty' || h === 'تعداد');

              if (codeIdx === -1) {
                return ctx.reply("❌ ستون 'کد' (یا code) in ردیف اول فایل اکسل پیدا نشد.");
              }

              const existingInventory = [...(state.inventory || [])];
              let addedCount = 0;
              let updatedCount = 0;

              for (let i = 1; i < data.length; i++) {
                const row = data[i];
                if (!row || row.length === 0 || !row[codeIdx]) continue;
                
                const rawCode = String(row[codeIdx]).trim();
                const rawName = nameIdx !== -1 && row[nameIdx] ? String(row[nameIdx]).trim() : 'بدون نام';
                
                // If stock column/value is missing, default it to 1 so the item is in-stock by default.
                let itemStock = 1;
                if (stockIdx !== -1 && row[stockIdx] !== undefined && row[stockIdx] !== null && String(row[stockIdx]).trim() !== "") {
                  const numValue = Number(row[stockIdx]);
                  itemStock = isNaN(numValue) ? 0 : numValue;
                }

                const sanitizedInputCode = sanitizeCode(rawCode);
                const existingIdx = existingInventory.findIndex(item => sanitizeCode(item.code) === sanitizedInputCode);

                if (existingIdx !== -1) {
                  // Update existing item
                  existingInventory[existingIdx] = {
                    code: rawCode, // keep the format of the code from the latest Excel
                    name: rawName !== 'بدون نام' ? rawName : existingInventory[existingIdx].name,
                    stock: itemStock
                  };
                  updatedCount++;
                } else {
                  // Add as new item
                  existingInventory.push({
                    code: rawCode,
                    name: rawName,
                    stock: itemStock
                  });
                  addedCount++;
                }
              }

              state.inventory = existingInventory;
              saveState();
              ctx.reply(`✅ موجودی انبار با موفقیت با فایل اکسل همگام‌سازی و بروزرسانی شد.\n\n➕ تعداد کالا‌های جدید: ${addedCount}\n✏️ تعداد کالاهای بروزرسانی‌شده: ${updatedCount}\n📦 کل کالاهای موجود در انبار: ${state.inventory.length}`);
           } catch (e: any) {
              console.error(e);
              ctx.reply("❌ خطا در پردازش فایل: " + e.message);
           }
        } else {
           ctx.reply("❌ لطفا یک فایل اکسل با فرمت xlsx ارسال کنید.");
        }
      }
    });



    bot.on("text", async (ctx: any) => {
      const text = ctx.message.text || "";

      if (ctx.chat.type === "private") {
        if (isAdmin(ctx)) {
          
          const session = adminSessions[ctx.from.id];
          if (session) {
            if (session.step === 'awaiting_product_code') {
              session.data.code = text.trim();
              session.step = 'awaiting_product_name';
              return ctx.reply("✅ کد دریافت شد.\n\n📝 حالا **نام کالا** را وارد کنید:\n\n(برای انصراف از دکمه زیر استفاده کنید)", {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]]
                }
              });
            } else if (session.step === 'awaiting_product_name') {
              session.data.name = text.trim();
              session.step = 'awaiting_product_stock';
              return ctx.reply("✅ نام دریافت شد.\n\n📝 لطفاً **موجودی** را به صورت عدد وارد کنید:\n\n(برای انصراف از دکمه زیر استفاده کنید)", {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]]
                }
              });
            } else if (session.step === 'awaiting_product_stock') {
              const stock = parseInt(normalizePersianArabicNumbers(text.trim()), 10);
              if (isNaN(stock)) {
                return ctx.reply("❌ لطفا موجودی را فقط به صورت عدد صحیح وارد کنید:", {
                  reply_markup: {
                    inline_keyboard: [[{ text: "❌ انصراف", callback_data: "cancel_add_product", style: "danger" }]]
                  }
                });
              }
              const { code, name } = session.data;
              
              if (!state.inventory) state.inventory = [];
              const existingIdx = state.inventory.findIndex(item => sanitizeCode(item.code) === sanitizeCode(code));

              if (existingIdx !== -1) {
                state.inventory[existingIdx] = { code, name, stock };
                ctx.reply(`✅ کالا با موفقیت ویرایش شد:\nکد: \`${code}\`\nنام: ${name}\nموجودی جدید: ${stock}`, { parse_mode: 'Markdown' });
              } else {
                state.inventory.push({ code, name, stock });
                ctx.reply(`✅ کالا با موفقیت افزوده شد:\nکد: \`${code}\`\nنام: ${name}\nموجودی: ${stock}`, { parse_mode: 'Markdown' });
              }
              saveState();
              delete adminSessions[ctx.from.id];
              return;
            } else if (session.step === 'awaiting_add_stock') {
              const stockToAdd = parseInt(normalizePersianArabicNumbers(text.trim()), 10);
              if (isNaN(stockToAdd)) {
                return ctx.reply("❌ لطفا تعداد موجودی جدید را به صورت عدد وارد کنید:");
              }
              const { code } = session.data;
              const existingIdx = state.inventory.findIndex(item => sanitizeCode(item.code) === sanitizeCode(code));
              if (existingIdx !== -1) {
                state.inventory[existingIdx].stock = stockToAdd;
                saveState();
                ctx.reply(`✅ موجودی کالا بروز شد.\nکد: \`${code}\`\nموجودی جدید: ${state.inventory[existingIdx].stock}`, { parse_mode: 'Markdown' });
              } else {
                ctx.reply("❌ کالا یافت نشد.");
              }
              delete adminSessions[ctx.from.id];
              return;
            } else if (session.step === 'awaiting_search_query') {
              const queryRaw = text.trim();
              const queryNormalized = normalizePersianArabicNumbers(queryRaw).toLowerCase();
              const querySanitized = sanitizeCode(queryRaw);

              const results = state.inventory.filter(item => {
                const codeRaw = String(item.code || "");
                const codeNormalized = normalizePersianArabicNumbers(codeRaw).toLowerCase();
                const codeSanitized = sanitizeCode(codeRaw);

                const nameRaw = String(item.name || "");
                const nameNormalized = normalizePersianArabicNumbers(nameRaw).toLowerCase();

                return codeNormalized.includes(queryNormalized) || 
                       nameNormalized.includes(queryNormalized) || 
                       (querySanitized && codeSanitized.includes(querySanitized));
              }).slice(0, 20); // max 20 results

              if (results.length === 0) {
                ctx.reply(`❌ کالایی با مشخصات "${queryRaw}" یافت نشد.`);
              } else {
                let replyText = `🔎 نتایج جستجو برای "${queryRaw}":\n\n`;
                const buttons: any[][] = [];
                results.forEach(item => {
                  replyText += `🔹 *کد:* \`${item.code}\`\n📝 *نام:* ${item.name}\n📦 *موجودی:* ${item.stock}\n\n`;
                  buttons.push([
                    { text: `🗑️ حذف ${item.code}`, callback_data: `inv_del_${item.code}`, style: 'danger' },
                    { text: `✏️ ویرایش ${item.code}`, callback_data: `inv_edit_${item.code}`, style: 'primary' },
                    { text: `➕ موجودی ${item.code}`, callback_data: `inv_addstock_${item.code}`, style: 'success' }
                  ]);
                });
                ctx.reply(replyText, {
                  parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: buttons }
                });
              }
              delete adminSessions[ctx.from.id];
              return;
            } else if (session.step === 'awaiting_delete_search') {
              const queryRaw = text.trim();
              const queryNormalized = normalizePersianArabicNumbers(queryRaw).toLowerCase();
              const querySanitized = sanitizeCode(queryRaw);

              const results = state.inventory.filter(item => {
                const codeRaw = String(item.code || "");
                const codeNormalized = normalizePersianArabicNumbers(codeRaw).toLowerCase();
                const codeSanitized = sanitizeCode(codeRaw);

                const nameRaw = String(item.name || "");
                const nameNormalized = normalizePersianArabicNumbers(nameRaw).toLowerCase();

                return codeNormalized.includes(queryNormalized) || 
                       nameNormalized.includes(queryNormalized) || 
                       (querySanitized && codeSanitized.includes(querySanitized));
              }).slice(0, 20); // max 20 results

              if (results.length === 0) {
                ctx.reply(`❌ کالایی با مشخصات "${queryRaw}" برای حذف یافت نشد.`);
              } else {
                let replyText = `🗑️ نتایج یافت‌شده برای حذف کالا "${queryRaw}":\n\n`;
                const buttons: any[][] = [];
                results.forEach(item => {
                   replyText += `🔹 *کد:* \`${item.code}\`\n📝 *نام:* ${item.name}\n📦 *موجودی:* ${item.stock}\n\n`;
                   buttons.push([
                     { text: `🗑️ حذف قطعی ${item.code}`, callback_data: `inv_del_${item.code}`, style: 'danger' }
                   ]);
                });
                ctx.reply(replyText, {
                  parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: buttons }
                });
              }
              delete adminSessions[ctx.from.id];
              return;
            }
          }

          // If admin types a raw text message that doesn't match our custom menu buttons
          const btnTitles = [
            "✍️ ثبت و ویرایش دستی کالا", "📦 لیست کالاهای موجود", "🔎 جستجوی کالا", "🗑️ حذف دستی کالا", "📤 آپلود موجودی انبار (اکسل)", "📥 دریافت فایل پشتیبان انبار", "⚙️ تنظیمات ربات", "💡 راهنمای کامل",
            "✍️🟡 ثبت و ویرایش دستی کالا", "📦🟢 لیست کالاهای موجود", "🔎🔵 جستجوی کالا", "🗑️🔴 حذف دستی کالا", "📤🟢 آپلود موجودی انبار (اکسل)", "📥🔵 دریافت فایل پشتیبان انبار", "⚙️🟣 تنظیمات ربات"
          ];
          if (!text.startsWith('/') && !btnTitles.includes(text)) {
             ctx.reply("مدیر گرامی، برای بروزرسانی موجودی انبار کافیست فایل اکسل جدید انبار (.xlsx) خود را مستقیماً به همینجا بفرستید.");
          }
          return;
        } else {
          // Non-admin talking in private (PV)
          ctx.reply("⚠️ شما دسترسی به پنل مدیریت یا اطلاعات در پی‌وی ندارید.\nاین ربات صرفاً فرمان‌های پایش کد کالا را در گروه‌های کاری متصل‌شده پردازش می‌کند.");
          return;
        }
      }

      // Ignore all slash commands in groups to prevent command clutter and false scanners
      if (text.startsWith('/')) {
        return;
      }

      // Check if scanner bot scanning is disabled (turned off)
      if (state.config.botEnabled === false) {
        return;
      }

      // Enqueue group processing so sequential messaging works beautifully without rate limits or data races
      enqueueGroupMessageTask(async () => {
        // Automatically register group for auto-discovery
        if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
          const grpId = String(ctx.chat.id);
          const grpTitle = ctx.chat.title || "گروه بدون نام";
          const grpUsername = ctx.chat.username ? String(ctx.chat.username) : "";

          if (!state.groups) state.groups = [];
          const existingGrpIdx = state.groups.findIndex(g => String(g.id) === grpId);
          const groupInfo = {
            id: grpId,
            title: grpTitle,
            username: grpUsername ? `@${grpUsername}` : undefined,
            lastActive: new Date().toISOString()
          };

          if (existingGrpIdx !== -1) {
            state.groups[existingGrpIdx] = groupInfo;
          } else {
            state.groups.push(groupInfo);
            saveState();

            // Securing notice to admin on discovering a new group in background
            if (state.config.adminId) {
              try {
                await bot.telegram.sendMessage(state.config.adminId, 
                  `🔔 *ربات در گروه جدیدی فعالیت خود را آغاز کرد!*\n\n` +
                  `👥 نام گروه: *${grpTitle}*\n` +
                  `🆔 آیدی عددی گروه (Group ID): \`${grpId}\` ${grpUsername ? `\n🔗 یوزرنیم گروه: @${grpUsername}` : ""}\n\n` +
                  `💡 برای محدود کردن اسکن کالاها به همین گروه، می‌توانید هم‌اکنون این آیدی را در تنظیمات پنل کپی و ذخیره کنید.`,
                  { parse_mode: 'Markdown' }
                );
              } catch (err) {
                console.error("Failed to notify admin on group text detection", err);
              }
            }
          }
        }

        // Optional Group ID restriction check
        if (state.config.groupId && state.config.groupId.trim() !== "") {
           const configGroup = state.config.groupId.trim();
           const currentChatId = String(ctx.chat.id);
           const currentChatUsername = ctx.chat.username ? String(ctx.chat.username) : "";

           const isGroupMatch = currentChatId === configGroup || 
                               (currentChatUsername && (configGroup === `@${currentChatUsername}` || configGroup === currentChatUsername));
           
           if (!isGroupMatch) {
              return; // Ignore updates from other non-registered groups
           }
        }

        // Secure purchase intent confirmation check
        if (!isPurchaseRequest(text)) {
          return; // Ignore
        }

        const normalizedText = normalizePersianArabicNumbers(text);

        const foundItems = state.inventory.filter((item) => {
           if (matchCodeInText(normalizedText, item.code)) return true;
           if (item.name && item.name !== "بدون نام" && matchCodeInText(normalizedText, item.name)) return true;
           return false;
        });

        const escapeHtml = (t: string | undefined): string => {
          if (!t) return "";
          return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        };

        if (foundItems.length > 0) {
          let adminNotifyMsg = `📥 <b>ثبت درخواست خرید جدید در گروه!</b>\n\n`;
          adminNotifyMsg += `👥 <b>مشخصات گروه:</b> ${escapeHtml(ctx.chat.title || "بدون نام")}\n`;
          adminNotifyMsg += `🆔 <b>آیدی گروه:</b> <code>${ctx.chat.id}</code>\n\n`;
          adminNotifyMsg += `👤 <b>مشخصات خریدار:</b>\n`;
          adminNotifyMsg += `🔹 نام: <a href="tg://user?id=${ctx.from.id}"><b>${escapeHtml((ctx.from.first_name || "") + " " + (ctx.from.last_name || "").trim())}</b></a>\n`;
          adminNotifyMsg += `🔹 نام کاربری: <a href="tg://user?id=${ctx.from.id}">${ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : "بدون‌یوزرنیم"}</a>\n`;
          adminNotifyMsg += `🆔 <b>آیدی عددی خریدار:</b> <a href="tg://user?id=${ctx.from.id}"><code>${ctx.from.id}</code></a>\n\n`;
          adminNotifyMsg += `📦 <b>کالاهای اسکن‌شده:</b> \n\n`;

          let hasAvailable = false;
          
          for (const item of foundItems) {
            if (Number(item.stock) > 0) {
              hasAvailable = true;
              
              // Add customer request record to local database
              if (!state.customers) state.customers = [];
              state.customers.push({
                 userId: String(ctx.from.id),
                 username: ctx.from.username || "بدون‌نام",
                 chatId: String(ctx.chat.id),
                 chatTitle: ctx.chat.title || "گروه ناشناس",
                 itemCode: String(item.code),
                 itemName: String(item.name),
                 date: new Date().toISOString()
              });

              adminNotifyMsg += `✅ <b>کد محصول:</b> <code>${escapeHtml(item.code)}</code>\n`;
              adminNotifyMsg += `🔸 <b>نام محصول:</b> ${escapeHtml(item.name)}\n`;
              adminNotifyMsg += `🔢 <b>موجودی در انبار:</b> <b>${escapeHtml(String(item.stock))}</b>\n\n`;

              // Prepare customized private message text to customer
              let pmText = state.config.customerMessage && state.config.customerMessage.trim() !== ""
                ? state.config.customerMessage
                : `سلام دوست گرامی، درخواست شما برای خرید کالای «<b>{name}</b>» با کد «<b>{code}</b>» با موفقیت ثبت شد.\nمدیریت ربات به زودی برای هماهنگی‌های لازم با شما ارتباط می‌گیرد.🌸`;
              
              pmText = pmText
                .replace(/{code}/g, item.code)
                .replace(/{name}/g, item.name);

              // Send in private chat with user (PV) unless disabled by admin
              if (state.config.disableCustomerPm === true) {
                console.log("Customer PM alerts are disabled, forwarding only to admin");
              } else {
                try {
                  await bot.telegram.sendMessage(ctx.from.id, pmText, { parse_mode: 'HTML' });
                } catch (pvError: any) {
                  console.warn("Failed to send PM directly to user, completely silent in group per admin preference.", pvError);
                }
              }
            }
          }

          if (hasAvailable) {
            saveState();

            adminNotifyMsg += `📝 <b>متن پیام خریدار:</b>\n« ${escapeHtml(text)} »\n\n`;

            try {
              await bot?.telegram.sendMessage(state.config.adminId, adminNotifyMsg, { parse_mode: 'HTML' });
              
              // Forward the original triggering message from the group to the admin PV
              if (ctx.message && ctx.message.message_id) {
                 try {
                    await bot?.telegram.forwardMessage(state.config.adminId, ctx.chat.id, ctx.message.message_id);
                 } catch (fwdErr) {
                    // Forwarding might fail if the user hid their account or the group restricts forwarding.
                    console.warn("Could not forward original message", fwdErr);
                 }
              }
            } catch (err) {
              console.error("Failed to forward requesting message to admin", err);
            }
          }
        }
      });
    });

    bot.catch((err: any) => {
      console.error("Bot Error", err);
      // ONLY set state.isRunning to false on absolute unauthorized failures (invalid token).
      // Keep state.isRunning to true on conflicts or network issues, allowing the supervisor to recover it nicely.
      if (err.message && (err.message.includes("Unauthorized") || err.message.includes("401"))) {
         console.warn("Fatal unauthorized bot log. Stopping bot permanently...");
         try { bot.stop(); } catch(e){}
         bot = null;
         state.isRunning = false;
         saveState();
      } else {
         console.warn("Transient or conflict bot connection error detected. Resetting bot instance but keeping isRunning=true for supervisor recovery...");
         try { bot.stop(); } catch(e){}
         bot = null;
      }
    });

    // We use long polling
    await bot.launch();
    state.isRunning = true;
    saveState();
    console.log("Bot started successfully");
    return true;
  } catch (e: any) {
    console.error("Failed to start bot", e);
    // Crucial fix: Do NOT set state.isRunning to false on connection/network/polling/conflict errors.
    // Setting bot to null triggers the supervisor restart.
    bot = null;
    
    // Check if it is a fatal token error (like 401 Unauthorized)
    if (e.message && (e.message.includes("401") || e.message.includes("Unauthorized"))) {
      state.isRunning = false;
      saveState();
    }
    return false;
  }
}

// Reconnection supervisor
let isReconnecting = false;
async function checkAndRecoverBot() {
  if (isReconnecting) return;
  isReconnecting = true;
  try {
    // 1. Recover main Telegraf bot if active but instance is null/stopped
    if (state.isRunning && !bot) {
      console.log("🔄 Background Supervisor: Bot was supposed to be running but is inactive. Recovering...");
      await startBot();
    }
    
    // 2. Recover userbot client if it gets disconnected or connection drops
    if (state.config.userbotSession && state.config.userbotEnabled !== false) {
      const isUserbotAlive = userbotClient && userbotClient.connected;
      if (!isUserbotAlive) {
        console.log("🔄 Background Supervisor: Userbot is configured to be active but is disconnected. Recovering...");
        await startUserbot();
      }
    }
  } catch (err) {
    console.error("🔄 Background Supervisor: Error trying to recover bots:", err);
  } finally {
    isReconnecting = false;
  }
}

// Check every 30 seconds to make sure the bot is up and running if intended
setInterval(checkAndRecoverBot, 30000);

// Auto-start on boot if configured and wasn't explicitly shut down by user
if (state.isRunning !== false && state.config.token && state.config.adminId) {
  console.log("🚀 Server boot: Auto-starting bot since it was previously active...");
  startBot().catch(console.error);
} else {
  console.log("⚠️ Server boot: Bot registration ignored or previously disabled.");
}

if (state.config.userbotSession && state.config.userbotEnabled !== false) {
  console.log("🚀 Server boot: Auto-starting userbot since it is configured...");
  startUserbot().catch(console.error);
}

// API Routes
app.get("/api/cron-keepalive", async (req, res) => {
  console.log("⏰ Cron Keepalive ping received.");
  await checkAndRecoverBot();
  res.json({
    success: true,
    status: state.isRunning ? "running" : "stopped",
    botActive: !!bot,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/state", (req, res) => {
  loadState(true);
  res.json({
    config: state.config,
    inventory: state.inventory,
    customers: state.customers || [],
    groups: state.groups || [],
    isRunning: state.isRunning,
  });
});

app.get("/api/download-deploy", (req, res) => {
  const possiblePaths = [
    path.join(process.cwd(), "dist", "cpanel-deploy.zip"),
    path.join(__dirname, "dist", "cpanel-deploy.zip"),
    path.join(__dirname, "cpanel-deploy.zip"),
    path.resolve("dist", "cpanel-deploy.zip"),
    "/dist/cpanel-deploy.zip"
  ];
  
  let validPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      validPath = p;
      break;
    }
  }

  if (validPath) {
    res.download(validPath, "cpanel-deploy.zip");
  } else {
    res.status(404).send("فایل زیپ بیلد هنوز ساخته نشده است. لطفا پروژه را در AI Studio مجدداً کامپایل/بیلد کنید.");
  }
});

app.post("/api/config", async (req, res) => {
  loadState(true);
  state.config = { ...state.config, ...req.body };
  if (state.config.adminId) state.config.adminId = String(state.config.adminId).trim();
  if (state.config.groupId) state.config.groupId = String(state.config.groupId).trim();
  
  // If token and adminId are supplied and it wasn't explicitly disabled, let's target to run
  if (state.isRunning !== false && state.config.token && state.config.adminId) {
    state.isRunning = true;
  }
  
  saveState();
  
  let started = false;
  if (state.isRunning) {
    started = await startBot();
  }

  // Restart userbot if configured
  if (state.config.userbotSession) {
    await startUserbot().catch(console.error);
  }
  
  res.json({ success: true, isRunning: started });
});

function translateTelegramError(errorStr: string): string {
  const upperError = String(errorStr).toUpperCase();
  
  if (upperError.includes("AUTH_USER_CANCEL") || upperError.includes("USER_CANCEL")) {
    return "ورود تایید نشد. درخواست ورود در تلگرام توسط شما یا یک دستگاه دیگر لغو (Cancel) شد. لطفا چند لحظه دیگر مجدداً دکمه ارسال کد را لمس نموده و این‌بار درخواست ورود را تایید کنید.";
  }
  if (upperError.includes("PHONE_CODE_EXPIRED")) {
    return "کد تایید تلگرام منقضی شده است. لطفا مجددا درخواست کد جدید بدهید.";
  }
  if (upperError.includes("PHONE_CODE_INVALID") || upperError.includes("CODE_INVALID")) {
    return "کد تایید تلگرام وارد شده صحیح نمی باشد. لطفا دوباره بررسی نمایید.";
  }
  if (upperError.includes("PASSWORD_HASH_INVALID") || upperError.includes("PASSWORD_INVALID")) {
    return "رمز عبور دو مرحله‌ای (2FA) نادرست است.";
  }
  if (upperError.includes("FLOOD_WAIT")) {
    return "محدودیت زمانی موقت تلگرام (Flood Wait). تعداد دفعات تلاش شما بیش از حد مجاز بوده است. لطفا چند دقیقه صبر کرده و سپس اقدام به ورود کنید.";
  }
  if (upperError.includes("PHONE_NUMBER_INVALID")) {
    return "شماره تلفن وارد شده صحیح نیست یا در سیستم تلگرام به عنوان حساب فعال شناخته نشده است.";
  }
  if (upperError.includes("SESSION_PASSWORD_NEEDED")) {
    return "رمز دو مرحله‌ای برای این حساب تلگرام فعال است. لطفا آن را وارد کنید.";
  }
  if (upperError.includes("API_ID_INVALID") || upperError.includes("API_HASH_INVALID") || upperError.includes("API_ID_PUBLISHED_LIMIT")) {
    return "مشخصات API ID или API Hash اشتباه است یا به حد لیمیت رسیده است. از بای‌پس پیش‌فرض یا اطلاعات معتبر استفاده کنید.";
  }
  
  return errorStr || "خطای نامشخص در احراز هویت تلگرام.";
}

const pendingUserbots = new Map<string, {
  client: any;
  apiId: number;
  apiHash: string;
  codePromise: Promise<string>;
  resolveCode?: (code: string) => void;
  passwordPromise: Promise<string>;
  resolvePassword?: (pass: string) => void;
  status: "pending_code" | "pending_password" | "success" | "error";
  error?: string;
  requiresPassword?: boolean;
  sentCodeType?: string;
  emailPattern?: string;
  codeLength?: number;
}>();

// 1. Send authentication code
app.post("/api/userbot/send-code", async (req, res) => {
  const { apiId, apiHash, phoneNumber } = req.body;
  if (!phoneNumber) {
    res.status(400).json({ error: "شماره تلفن الزامی است." });
    return;
  }

  // Fallback to official Telegram Desktop credentials if not provided
  // This bypasses errors/blocks on my.telegram.org for the user
  const finalApiId = apiId ? Number(apiId) : 2040;
  const finalApiHash = apiHash ? String(apiHash).trim() : "b18441a1ff607e10a989891a5462e627";

  const cleanPhone = String(phoneNumber).trim();

  try {
    const existing = pendingUserbots.get(cleanPhone);
    if (existing) {
      try { await existing.client.disconnect(); } catch (e) {}
    }

    const client = new TelegramClient(
      new StringSession(""),
      finalApiId,
      finalApiHash,
      { connectionRetries: 5 }
    );

    await client.connect();

    let resolveCode: ((code: string) => void) | undefined;
    const codePromise = new Promise<string>((resolve) => {
      resolveCode = resolve;
    });

    let resolvePassword: ((pass: string) => void) | undefined;
    const passwordPromise = new Promise<string>((resolve) => {
      resolvePassword = resolve;
    });

    const pendingSession: {
      client: any;
      apiId: number;
      apiHash: string;
      codePromise: Promise<string>;
      resolveCode?: (code: string) => void;
      passwordPromise: Promise<string>;
      resolvePassword?: (pass: string) => void;
      status: "pending_code" | "pending_password" | "success" | "error";
      error?: string;
      requiresPassword?: boolean;
      sentCodeType?: string;
      emailPattern?: string;
      codeLength?: number;
    } = {
      client,
      apiId: finalApiId,
      apiHash: finalApiHash,
      codePromise,
      resolveCode,
      passwordPromise,
      resolvePassword,
      status: "pending_code",
      requiresPassword: false,
      error: undefined,
      sentCodeType: undefined,
      emailPattern: undefined,
      codeLength: undefined
    };

    // Capture the type of verification code (SMS, App, or Email)
    const originalInvoke = client.invoke.bind(client);
    client.invoke = async (request: any, ...args: any[]) => {
      const result = await originalInvoke(request, ...args);
      if (result && result.className === "auth.SentCode") {
        console.log("Captured Telegram SentCode Response:", JSON.stringify({
          className: result.className,
          type: result.type?.className,
          emailPattern: result.type?.emailPattern,
          length: result.type?.length
        }));
        pendingSession.sentCodeType = result.type?.className;
        pendingSession.emailPattern = result.type?.emailPattern;
        pendingSession.codeLength = result.type?.length;
      }
      return result;
    };

    pendingUserbots.set(cleanPhone, pendingSession);

    // Call high-level signInUser, which triggers sendCode and then waits on our callbacks
    client.signInUser(
      { apiId: finalApiId, apiHash: finalApiHash },
      {
        phoneNumber: cleanPhone,
        phoneCode: async () => {
          return await codePromise;
        },
        password: async () => {
          pendingSession.requiresPassword = true;
          pendingSession.status = "pending_password";
          return await passwordPromise;
        },
        onError: async (err: Error) => {
          console.error("Userbot authenticating error callback:", err);
          pendingSession.status = "error";
          pendingSession.error = err.message;
          return true; // Stop authorization
        }
      }
    ).then((user) => {
      console.log("signInUser success");
      pendingSession.status = "success";
    }).catch((err: any) => {
      console.error("signInUser background catch:", err);
      pendingSession.status = "error";
      pendingSession.error = err.message || String(err);
    });

    // Wait a brief moment to ensure client.sendCode has been executed inside client.signInUser
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (pendingSession.status === "error") {
      const friendlyError = translateTelegramError(pendingSession.error || "خطا در تنظیم و ارسال کد تایید با سرور تلگرام.");
      res.status(400).json({ error: friendlyError });
      try { await client.disconnect(); } catch (e) {}
      pendingUserbots.delete(cleanPhone);
      return;
    }

    res.json({
      success: true,
      message: "کد تایید با موفقیت ارسال شد.",
      sentCodeType: pendingSession.sentCodeType,
      emailPattern: pendingSession.emailPattern,
      codeLength: pendingSession.codeLength
    });
  } catch (err: any) {
    console.error("Failed to setup userbot code send", err);
    const friendlyError = translateTelegramError(err.message || String(err));
    res.status(500).json({ error: friendlyError });
  }
});

// 2. Verify authentication code
app.post("/api/userbot/verify-code", async (req, res) => {
  const { phoneNumber, code, password } = req.body;
  if (!phoneNumber || !code) {
    res.status(400).json({ error: "شماره تلفن و کد تایید الزامی هستند." });
    return;
  }

  const cleanPhone = String(phoneNumber).trim();
  const sessionData = pendingUserbots.get(cleanPhone);

  if (!sessionData) {
    res.status(400).json({ error: "جلسه منقضی شده یا یافت نشد. لطفا کد تایید را مجدداً درخواست کنید." });
    return;
  }

  try {
    // 1. Resolve code promise to unblock client.signInUser
    if (sessionData.resolveCode) {
      sessionData.resolveCode(String(code).trim());
    }

    // 2. Wait for status to change from "pending_code" (e.g. to "pending_password", "success", or "error")
    let checks = 0;
    while (sessionData.status === "pending_code" && checks < 40) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      checks++;
    }

    // 3. See if we require password (2FA) and password was not provided yet
    if (sessionData.status === "pending_password" && !password) {
      sessionData.requiresPassword = true;
      res.json({ success: false, requiresPassword: true, message: "رمز عبور دو مرحله‌ای (2FA) الزامی است." });
      return;
    }

    // 4. If password provided, resolve passwordPromise
    if (sessionData.status === "pending_password" && password && sessionData.resolvePassword) {
      sessionData.resolvePassword(String(password).trim());
      // Wait for status to change from pending_password to success or error
      let passChecks = 0;
      while (sessionData.status === "pending_password" && passChecks < 40) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        passChecks++;
      }
    }

    // 5. If we faced an error
    if (sessionData.status === "error") {
      throw new Error(sessionData.error || "خطای تایید هویت در سمت تلگرام.");
    }

    if (sessionData.status !== "success") {
      throw new Error("پاسخی از سرور تلگرام دریافت نشد یا تایید هویت هنوز کامل نشده است. لطفاً دوباره تلاش کنید.");
    }

    const { client } = sessionData;
    const sessionString = (client.session as any).save() as string;

    state.config.userbotApiId = String(sessionData.apiId);
    state.config.userbotApiHash = sessionData.apiHash;
    state.config.userbotSession = sessionString;
    state.config.userbotEnabled = true;

    saveState();
    pendingUserbots.delete(cleanPhone);

    await startUserbot().catch(console.error);

    res.json({ success: true, message: "ربات کاربر با موفقیت متصل و فعال شد!" });
  } catch (err: any) {
    console.error("Failed to verify userbot code", err);
    try {
      if (sessionData && sessionData.client) {
        await sessionData.client.disconnect();
      }
    } catch (e) {}
    pendingUserbots.delete(cleanPhone);
    const friendlyError = translateTelegramError(err.message || String(err));
    res.status(500).json({ error: friendlyError });
  }
});

// 3. Logout/Disconnect userbot
app.post("/api/userbot/logout", async (req, res) => {
  try {
    await stopUserbot();

    state.config.userbotApiId = undefined;
    state.config.userbotApiHash = undefined;
    state.config.userbotSession = undefined;
    state.config.userbotEnabled = false;
    saveState();

    res.json({ success: true, message: "ربات کاربر با موفقیت قطع ارتباط شد." });
  } catch (err: any) {
    console.error("Failed to logout userbot", err);
    res.status(500).json({ error: err.message || "خطا در قطع ارتباط ربات کاربر." });
  }
});

// 4. List userbot groups/dialogs
app.get("/api/userbot/dialogs", async (req, res) => {
  if (!userbotClient) {
    if (state.config.userbotSession && state.config.userbotApiId && state.config.userbotApiHash) {
      console.log("Userbot client is null but session exists. Attempting to start userbot...");
      try {
        await startUserbot();
      } catch (e) {
        res.status(400).json({ error: "ربات کاربر متصل نیست و تلاش برای راه‌اندازی خودکار با خطا مواجه شد." });
        return;
      }
    } else {
      res.status(400).json({ error: "ربات کاربر متصل نیست. لطفا ابتدا وارد حساب کاربری خود شوید." });
      return;
    }
  }

  try {
    if (userbotClient && !userbotClient.connected) {
      await userbotClient.connect();
    }
    
    // GramJS getDialogs retrieves active chats
    const dialogs = await userbotClient!.getDialogs({});
    const groups = [];
    
    for (const d of dialogs) {
      if (d.isGroup || d.isChannel) {
        let username = "";
        const entity = d.entity as any;
        if (entity && entity.username) {
          username = String(entity.username);
        }
        
        // Skip deleted, left, kicked, or empty/forbidden groups/channels
        if (entity) {
          if (entity.left || entity.kicked || entity.deactivated) continue;
          const className = entity.className || "";
          if (className.includes("Forbidden") || className.includes("Empty")) continue;
        }
        
        const title = d.title || "";
        const lowerTitle = title.toLowerCase();
        if (
          lowerTitle.includes("deleted account") || 
          lowerTitle.includes("deactivated") || 
          lowerTitle.includes("حذف شده") || 
          lowerTitle.includes("حذفی")
        ) {
          continue;
        }
        
        groups.push({
          id: String(d.id),
          title: title || "بدون نام",
          username: username,
          isChannel: !!d.isChannel
        });
      }
    }
    
    res.json({ success: true, groups });
  } catch (err: any) {
    console.error("Failed to fetch userbot dialogs", err);
    res.status(500).json({ error: err.message || "خطا در دریافت لیست گروه‌ها از تلگرام." });
  }
});

app.post("/api/bot/stop", (req, res) => {
  loadState(true);
  if (bot) {
    try { bot.stop(); } catch(e) {}
  }
  state.isRunning = false;
  saveState();
  res.json({ success: true, isRunning: false });
});

app.post("/api/bot/start", async (req, res) => {
  loadState(true);
  state.isRunning = true;
  saveState();
  const started = await startBot();
  res.json({ success: started, isRunning: state.isRunning });
});

app.post("/api/inventory", (req, res) => {
  loadState(true);
  if (!Array.isArray(req.body)) {
    res.status(400).json({ error: "Invalid inventory format" });
    return;
  }
  state.inventory = req.body;
  saveState();
  res.json({ success: true, inventoryCount: state.inventory.length });
});

app.post("/api/customers", (req, res) => {
  loadState(true);
  if (!Array.isArray(req.body)) {
    res.status(400).json({ error: "Invalid customers format" });
    return;
  }
  state.customers = req.body;
  saveState();
  res.json({ success: true, count: state.customers.length });
});

async function startServer() {
  if (process.env.NODE_ENV === "development") {
    const vite = await import("vite").then(m => (m as any).createServer({
      server: { middlewareMode: true },
      appType: "spa",
    }));
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Support Vue/React router proxy to index.html
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (typeof PORT === "string" && (PORT.startsWith("/") || PORT.startsWith("\\") || !/^\d+$/.test(PORT))) {
    // Unix domain socket for cPanel / Phusion Passenger (or named socket)
    app.listen(PORT, () => {
      console.log(`Server running on Unix socket: ${PORT}`);
    });
  } else {
    // Standard TCP port
    const numericPort = Number(PORT) || 3000;
    app.listen(numericPort, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${numericPort}`);
    });
  }
}

startServer();
