const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const waitingForSticker = new Map();

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
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
    const files = fs.readdirSync(tempDir);
    if (files.length === 0) {
      return msg.reply("🤖: Nenhum sticker foi criado ainda.");
    }

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const data = fs.readFileSync(filePath, { encoding: "base64" });
      const mimeType = file.endsWith(".mp4") ? "video/mp4" : "image/png";

      const media = new MessageMedia(mimeType, data, file);
      await client.sendMessage(chatId, media, { sendMediaAsSticker: true });
    }
    return;
  }

  if (waitingForSticker.has(chatId)) {
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();

        if (msg.type === "image" || msg.type === "video") {
          const ext = media.mimetype.includes("video") ? ".mp4" : ".png";
          const fileName = `sticker_${Date.now()}${ext}`;
          const filePath = path.join(tempDir, fileName);

          fs.writeFileSync(filePath, media.data, "base64");

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
