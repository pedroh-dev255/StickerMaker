require("dotenv").config();
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const mysql = require("mysql2/promise");

const waitingForSticker = new Map();

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// ----------------- Configuração do DB -----------------
let dbPool;
async function connectDB() {
  dbPool = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  console.log("✅ Banco de dados conectado");
}

async function saveStickerToDB(contactName, contactId, isGroup, groupName, fileName) {
  try {
    await dbPool.execute(
      `INSERT INTO stickers (contact_name, contact_id, is_group, group_name, file_name)
       VALUES (?, ?, ?, ?, ?)`,
      [contactName, contactId, isGroup ? 1 : 0, groupName, fileName]
    );
  } catch (err) {
    console.error("Erro ao salvar sticker no DB:", err);
    throw err;
  }
}

async function getStickersByContact(contactId) {
  try {
    const [rows] = await dbPool.execute(
      "SELECT file_name FROM stickers WHERE contact_id = ? ORDER BY id ASC",
      [contactId]
    );
    return rows.map((r) => r.file_name);
  } catch (err) {
    console.error("Erro ao obter stickers do DB:", err);
    return [];
  }
}

// ----------------- Configuração do cliente WhatsApp -----------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ],
  },
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Bot on");
});

const multiStickerSessions = new Map();

client.on("message", async (msg) => {
  // pega chat e contato (sempre tentei usar msg.getChat/getContact como você já estava fazendo)
  let chat, contact;
  try {
    chat = await msg.getChat();
  } catch (e) {
    console.warn("Não foi possível obter chat:", e && e.message);
  }
  try {
    contact = await msg.getContact();
  } catch (e) {
    console.warn("Não foi possível obter contact:", e && e.message);
  }

  const isGroup = chat ? !!chat.isGroup : false;
  const contactName = (contact && (contact.pushname || contact.name)) || "Desconhecido";
  const contactId = (contact && contact.id && contact.id._serialized) || (msg.author || msg.from);
  const groupName = isGroup ? (chat.name || null) : null;

  const chatId = msg.from; // mantém seu uso original para replies e para casos que queira identificar o chat de origem
  
  const lowerBody = msg.body?.toLowerCase();

  // Caso o usuário envie "!sticker"
  if (lowerBody === "!sticker") {
    waitingForSticker.set(chatId, true);
    return msg.reply("🤖: Envie agora uma *imagem* ou *vídeo* para transformar em sticker.");
  }

  // --- Início do novo comando !stickers ---
  if (lowerBody === "!stickers") {
    multiStickerSessions.set(chatId, []);
    return msg.reply("🤖: Modo múltiplos stickers ativado!\n Envie várias imagens ou vídeos e digite\n*!pronto* quando terminar.");
  }

  if (lowerBody === "!pronto" && multiStickerSessions.has(chatId)) {
    const queue = multiStickerSessions.get(chatId);
    multiStickerSessions.delete(chatId);

    if (!queue || queue.length === 0) {
      return msg.reply("🤖: Nenhuma mídia recebida. Processo cancelado.");
    }

    msg.reply("🤖: Processando Stickers...");

    let processed = 0;
    let failed = 0;

    // Aguarda todas as mídias baixarem
    const files = await Promise.all(queue);

    await Promise.all(files.map(async (fileObj) => {
      if (!fileObj) { // download falhou
        failed++;
        return;
      }

      try {
        const { media, msgType, contactName, contactId, isGroup, groupName } = fileObj;

        if (!["image", "video"].includes(msgType)) {
          failed++;
          return;
        }

        const ext = media.mimetype.includes("video") ? ".mp4" : ".png";
        const fileName = `sticker_${Date.now()}_${Math.floor(Math.random()*1000)}${ext}`;
        const filePath = path.join(tempDir, fileName);

        await fsp.writeFile(filePath, media.data, "base64");
        await saveStickerToDB(contactName, contactId, isGroup, groupName, fileName);

        await client.sendMessage(chatId, new MessageMedia(media.mimetype, media.data, null), { sendMediaAsSticker: true });
        processed++;
      } catch (err) {
        console.error("Erro ao processar mídia:", err);
        failed++;
      }
    }));

    return msg.reply(`🤖: Stickers processados!\n✅ Sucesso: ${processed}\n❌ Falha: ${failed}`);
  }

  // --- Caso esteja em modo múltiplos stickers e receba uma mídia ---
  if (multiStickerSessions.has(chatId) && msg.hasMedia) {
    const downloadPromise = msg.downloadMedia({ unsafeMime: true })
      .then(media => ({
        media,
        msgType: msg.type,
        contactName,
        contactId,
        isGroup,
        groupName
      }))
      .catch(err => {
        console.error("Erro ao baixar mídia:", err);
        return null; // marca como falha
      });

    const queue = multiStickerSessions.get(chatId);
    queue.push(downloadPromise);
    multiStickerSessions.set(chatId, queue);

    //return msg.reply("🤖: Mídia adicionada à fila. Continue enviando ou digite !pronto.");
  }


  // --- Relatório de stickers (!todos) ---
  if (lowerBody === "!todos" || lowerBody === "!relatorio") {
    try {
      const [rows] = await dbPool.execute(
        "SELECT is_group, COUNT(*) AS total FROM stickers WHERE contact_id = ? GROUP BY is_group",
        [contactId]
      );

      let total = 0, groupCount = 0, privateCount = 0;
      for (const row of rows) {
        total += row.total;
        if (row.is_group) groupCount += row.total;
        else privateCount += row.total;
      }

      return msg.reply(`🤖: Você já gerou ${total} sticker(s)\n✅ Pelo grupo: ${groupCount}\n✅ Pelo privado: ${privateCount}\n\nPara exibir os stickers, digite !exibir`);
    } catch (err) {
      console.error("Erro ao gerar relatório de stickers:", err);
      return msg.reply("🤖: Erro ao gerar relatório. Tente novamente mais tarde.");
    }
  }

  // --- Exibir stickers paginados (!exibir ou !exibir X) ---
  if (lowerBody.startsWith("!exibir")) {
    try {
      // Página solicitada
      let page = 1;
      const match = lowerBody.match(/!exibir\s+(\d+)/);
      if (match) page = parseInt(match[1]) || 1;

      const stickers = await getStickersByContact(contactId);
      if (!stickers || stickers.length === 0) {
        return msg.reply("🤖: Você ainda não criou nenhum sticker.");
      }

      const perPage = 5;
      const totalPages = Math.ceil(stickers.length / perPage);

      if (page < 1 || page > totalPages) {
        return msg.reply(`🤖: Página inválida. Informe um número entre 1 e ${totalPages}`);
      }

      const start = (page - 1) * perPage;
      const end = start + perPage;
      const stickersPage = stickers.slice(start, end);

      for (const file of stickersPage) {
        const filePath = path.join(tempDir, file);
        if (!fs.existsSync(filePath)) {
          await msg.reply(`🤖: O sticker ${file} não está mais acessível`);
          continue;
        }

        const data = fs.readFileSync(filePath, { encoding: "base64" });
        const mimeType = file.endsWith(".mp4") ? "video/mp4" : "image/png";
        const media = new MessageMedia(mimeType, data, file);

        await client.sendMessage(chatId, media, { sendMediaAsSticker: true });
      }

      await msg.reply(`Página ${page} de ${totalPages}`);
    } catch (err) {
      console.error("Erro ao exibir stickers:", err);
      return msg.reply("🤖: Ocorreu um erro ao exibir os stickers. Tente novamente mais tarde.");
    }
  }

  // Usuário enviou mídia para gerar sticker
  if (waitingForSticker.has(chatId)) {
    waitingForSticker.delete(chatId); // remove imediatamente para evitar duplicidade
    msg.reply("🤖: Recebi sua mídia! Processando o sticker...");

    // Processamento paralelo em segundo plano
    (async () => {
      try {
        console.log("iniciando Download");
        const media = await msg.downloadMedia({ unsafeMime: true });
        console.log("download concluído");

        if (msg.type === "image" || msg.type === "video") {
          const ext = media.mimetype.includes("video") ? ".mp4" : ".png";
          const fileName = `sticker_${Date.now()}${ext}`;
          const filePath = path.join(tempDir, fileName);

          // Salva arquivo local em base64
          await fsp.writeFile(filePath, media.data, "base64");

          // Salva no banco de dados
          try {
            await saveStickerToDB(contactName, contactId, isGroup, groupName, fileName);
          } catch (err) {
            console.error("Erro ao persistir no DB:", err);
          }

          // Envia como sticker
          await client.sendMessage(chatId, new MessageMedia(media.mimetype, media.data, null), {
            sendMediaAsSticker: true,
          });

          await client.sendMessage(chatId, "🤖: Sticker criado e salvo com sucesso!");
        } else {
          await client.sendMessage(chatId, "🤖: Apenas imagem ou vídeo são aceitos para criar sticker. Processo cancelado.");
        }
      } catch (err) {
        console.error("Erro ao processar mídia:", err);
        await client.sendMessage(chatId, `🤖: Ocorreu um erro ao criar o sticker. Tente novamente.\n ${err}`);
      }
    })();
  }

});

// Inicializar DB e cliente
(async () => {
  try {
    await connectDB();
    client.initialize();
  } catch (err) {
    console.error("Erro na inicialização:", err);
    process.exit(1);
  }
})();
