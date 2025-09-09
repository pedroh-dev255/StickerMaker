const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const waitingForSticker = new Map();

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

const logFile = path.join(__dirname, "stickers.json");

// Inicializa o log de stickers
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, JSON.stringify({}, null, 2));
}

function loadLog() {
  return JSON.parse(fs.readFileSync(logFile, "utf-8"));
}

function saveLog(data) {
  fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
}

// Configuração do cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Bot on");
});

client.on("message", async (msg) => {
  const chatId = msg.from;

  // Caso o usuário envie "!sticker"
  if (msg.body.toLowerCase() === "!sticker") {
    waitingForSticker.set(chatId, true);
    return msg.reply("🤖: Envie agora uma *imagem* ou *vídeo* para transformar em sticker.");
  }

  // Caso o usuário envie "!todos"
  if (msg.body.toLowerCase() === "!todos") {
    const logData = loadLog();
    const userStickers = logData[chatId] || [];

    if (userStickers.length === 0) {
      return msg.reply("🤖: Nenhum sticker foi criado por você ainda.");
    }

    for (const file of userStickers) {
      const filePath = path.join(tempDir, file);
      if (!fs.existsSync(filePath)) continue;

      const data = fs.readFileSync(filePath, { encoding: "base64" });
      const mimeType = file.endsWith(".mp4") ? "video/mp4" : "image/png";

      const media = new MessageMedia(mimeType, data, file);
      await client.sendMessage(chatId, media, { sendMediaAsSticker: true });
    }
    return;
  }

  // Usuário enviou mídia para gerar sticker
  if (waitingForSticker.has(chatId)) {
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();

        if (msg.type === "image" || msg.type === "video") {
          const ext = media.mimetype.includes("video") ? ".mp4" : ".png";
          const fileName = `sticker_${Date.now()}${ext}`;
          const filePath = path.join(tempDir, fileName);

          fs.writeFileSync(filePath, media.data, "base64");

          // Atualiza log
          const logData = loadLog();
          if (!logData[chatId]) logData[chatId] = [];
          logData[chatId].push(fileName);
          saveLog(logData);

          // Enviar como sticker
          await client.sendMessage(chatId, new MessageMedia(media.mimetype, media.data, null), {
            sendMediaAsSticker: true,
          });

          msg.reply("✅ Sticker criado e salvo com sucesso!");
        } else {
          msg.reply("🤖: Apenas imagem ou vídeo são aceitos para criar sticker. Processo cancelado.");
        }
      } catch (err) {
        console.error("Erro ao processar mídia:", err);
        msg.reply("🤖: Ocorreu um erro ao criar o sticker. Tente novamente.");
      }

      waitingForSticker.delete(chatId);
    } else {
      waitingForSticker.delete(chatId);
      msg.reply("🤖: Nenhuma imagem/vídeo recebido. Processo cancelado.");
    }
  }
});

// Inicializar cliente
client.initialize();
