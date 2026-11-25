
import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  proto,
} from '@whiskeysockets/baileys';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(ROOT, 'temp');
const SESSION_DIR = path.resolve(ROOT, process.env.SESSION_DIR || 'baileys_auth');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const MAX_VIDEO_SECONDS = Math.max(1, Number(process.env.MAX_VIDEO_SECONDS || 25));
const MAX_STICKER_BYTES = Math.min(500 * 1024, Number(process.env.MAX_STICKER_BYTES || 500 * 1024));
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 2 * 1024 * 1024);
const STICKER_SIZE = 512;
const AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';

await fsp.mkdir(TEMP_DIR, { recursive: true });

// -------------------- MySQL --------------------
let dbPool;

async function connectDB() {
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
  });

  await dbPool.query('SELECT 1');
  console.log('✅ Banco MySQL conectado');

  const [columns] = await dbPool.query('SHOW COLUMNS FROM stickers');
  const names = new Set(columns.map(c => c.Field));

  if (!names.has('audio_file_name')) {
    await dbPool.query(
      'ALTER TABLE stickers ADD COLUMN audio_file_name VARCHAR(255) NULL'
    );
    console.log('🛠️ Coluna audio_file_name adicionada');
  }

  if (!names.has('is_sound')) {
    await dbPool.query(
      'ALTER TABLE stickers ADD COLUMN is_sound TINYINT(1) NOT NULL DEFAULT 0'
    );
    console.log('🛠️ Coluna is_sound adicionada');
  }
}

async function saveStickerToDB(
  contactName,
  contactId,
  isGroup,
  groupName,
  fileName,
  audioFileName = null
) {
  await dbPool.execute(
    `INSERT INTO stickers
      (contact_name, contact_id, is_group, group_name,
       file_name, audio_file_name, is_sound)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      contactName,
      contactId,
      isGroup ? 1 : 0,
      groupName,
      fileName,
      audioFileName,
      audioFileName ? 1 : 0,
    ]
  );
}

async function getStickersByContact(contactId) {
  const [rows] = await dbPool.execute(
    `SELECT file_name, audio_file_name, is_sound
     FROM stickers
     WHERE contact_id = ?
     ORDER BY id ASC`,
    [contactId]
  );

  return rows;
}

async function getStickerCounts(contactId) {
  const [rows] = await dbPool.execute(
    `SELECT is_group, COUNT(*) AS total
     FROM stickers
     WHERE contact_id = ?
     GROUP BY is_group`,
    [contactId]
  );

  return rows;
}

// -------------------- Sound Stickers --------------------

const pendingStickerAudio = new Map();
const PATCHED = Symbol.for('phcore.baileys.sound-sticker-patched');

const keyOf = hash => Buffer.from(hash).toString('base64');

function attachStickerAudio(fileSha256, audioMessageBytes) {
  pendingStickerAudio.set(keyOf(fileSha256), audioMessageBytes);
}

function detachStickerAudio(fileSha256) {
  pendingStickerAudio.delete(keyOf(fileSha256));
}

function installSoundStickerPatch() {
  const StickerMessage = proto.Message.StickerMessage;

  if (!StickerMessage?.encode) {
    throw new Error(
      'Baileys não expôs proto.Message.StickerMessage.encode'
    );
  }

  if (StickerMessage.encode[PATCHED]) return;

  const originalEncode = StickerMessage.encode;

  const patchedEncode = function (message, writer) {
    const result = originalEncode.call(this, message, writer);

    if (message?.fileSha256) {
      const audioBytes = pendingStickerAudio.get(
        keyOf(message.fileSha256)
      );

      if (audioBytes) {
        result.uint32((26 << 3) | 2).bytes(audioBytes);
      }
    }

    return result;
  };

  patchedEncode[PATCHED] = true;
  StickerMessage.encode = patchedEncode;

  console.log(
    '🔊 Patch experimental Sound Sticker instalado (campo 26)'
  );
}

function ownJidFor(sock, chatJid) {
  const me = sock.user || {};

  return chatJid.endsWith('@lid') && me.lid
    ? me.lid
    : me.id;
}

async function sendSoundSticker(sock, jid, webpPath, oggPath, quoted) {
  const upload = {
    upload: sock.waUploadToServer,
  };

  const audioUpload = await prepareWAMessageMedia(
    {
      audio: await fsp.readFile(oggPath),
      mimetype: AUDIO_MIMETYPE,
      seconds: await getDuration(oggPath),
    },
    upload
  );

  const stickerUpload = await prepareWAMessageMedia(
    {
      sticker: await fsp.readFile(webpPath),
      isAnimated: true,
    },
    upload
  );

  const a = audioUpload.audioMessage;

  const duration = Math.max(
    1,
    Math.ceil(await getDuration(oggPath))
  );

  const audioProto = proto.Message.AudioMessage.create({
    url: a.url,
    mimetype: AUDIO_MIMETYPE,
    fileSha256: a.fileSha256,
    fileLength: a.fileLength,
    seconds: duration,
    ptt: true,
    mediaKey: a.mediaKey,
    fileEncSha256: a.fileEncSha256,
    directPath: a.directPath,
    mediaKeyTimestamp:
      a.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
  });

  const audioBytes = proto.Message.AudioMessage
    .encode(audioProto)
    .finish();

  const sticker = stickerUpload.stickerMessage;

  sticker.isAnimated = true;
  sticker.width = STICKER_SIZE;
  sticker.height = STICKER_SIZE;

  attachStickerAudio(sticker.fileSha256, audioBytes);

  try {
    const outgoing = generateWAMessageFromContent(
      jid,
      {
        stickerMessage: sticker,
      },
      {
        quoted,
        userJid: ownJidFor(sock, jid),
      }
    );

    const encoded = proto.Message.encode(outgoing.message).finish();

    if (!encoded || encoded.length === 0) {
      throw new Error('Falha ao serializar Sound Sticker');
    }

    await sock.relayMessage(
      jid,
      outgoing.message,
      {
        messageId: outgoing.key.id,
      }
    );
  } finally {
    detachStickerAudio(sticker.fileSha256);
  }
}

// -------------------- FFmpeg --------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...options,
    });

    let stderr = '';

    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} terminou com código ${code}: ${stderr.slice(-2500)}`
          )
        );
      }
    });
  });
}

async function getDuration(file) {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';

    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());

    child.on('error', reject);

    child.on('close', code => {
      const n = Number.parseFloat(out.trim());

      if (code !== 0 || !Number.isFinite(n)) {
        reject(new Error(`ffprobe falhou: ${err}`));
      } else {
        resolve(n);
      }
    });
  });
}

async function hasAudio(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFPROBE,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'csv=p=0',
        file,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let out = '';
    let err = '';

    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());

    child.on('error', reject);

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe falhou ao verificar áudio: ${err}`));
      } else {
        resolve(
          out.trim().split(/\r?\n/).some(
            line => line.trim() === 'audio'
          )
        );
      }
    });
  });
}

async function convertImageToWebp(input, output) {
  await run(FFMPEG, [
    '-y',
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
    '-vcodec',
    'libwebp',
    '-lossless',
    '0',
    '-q:v',
    '80',
    '-compression_level',
    '6',
    output,
  ]);
}


async function convertVideoToSticker(input, webpOutput, audioOutput) {
  const duration = Math.min(await getDuration(input), MAX_VIDEO_SECONDS);

  if (!Number.isFinite(duration) || duration < 0.25) {
    throw new Error('Vídeo muito curto ou duração inválida.');
  }

  const audioExists = await hasAudio(input);

  // Tenta diferentes combinações até conseguir um WebP abaixo de 480 KB.
  // Deixamos margem em relação ao limite de 512 KB do WhatsApp.
  const targetBytes = 480 * 1024;

  const profiles = [
    { size: 512, fps: 10, qualities: [65, 55, 45, 35] },
    { size: 448, fps: 10, qualities: [55, 45, 35, 25] },
    { size: 384, fps: 8, qualities: [55, 45, 35, 25] },
    { size: 320, fps: 8, qualities: [45, 35, 25, 18] },
    { size: 256, fps: 6, qualities: [35, 25, 18] },
  ];

  let success = false;
  let finalQuality = 0;
  let finalSize = 0;
  let finalFps = 0;

  for (const profile of profiles) {
    const filter =
      `fps=${profile.fps},` +
      `scale=${profile.size}:${profile.size}:force_original_aspect_ratio=decrease,` +
      `pad=${profile.size}:${profile.size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

    for (const quality of profile.qualities) {
      await run(FFMPEG, [
        '-y',
        '-i', input,
        '-t', String(duration),
        '-an',
        '-vf', filter,
        '-loop', '0',
        '-vsync', '0',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-compression_level', '6',
        '-preset', 'default',
        webpOutput,
      ]);

      const stat = await fsp.stat(webpOutput);

      console.log(
        `[STICKER] ${profile.size}px | ${profile.fps} FPS | qualidade ${quality} | ${(stat.size / 1024).toFixed(1)} KB`
      );

      if (stat.size <= targetBytes) {
        success = true;
        finalQuality = quality;
        finalSize = stat.size;
        finalFps = profile.fps;
        finalSize = profile.size;
        break;
      }
    }

    if (success) break;
  }

  if (!success) {
    throw new Error(
      `Não foi possível reduzir o sticker abaixo de ${targetBytes} bytes.`
    );
  }

  // Extrai o áudio original para Sound Sticker, quando existir.
  if (audioExists) {
    await run(FFMPEG, [
      '-y',
      '-i', input,
      '-t', String(duration),
      '-vn',
      '-map', '0:a:0',
      '-c:a', 'libopus',
      '-b:a', process.env.AUDIO_BITRATE || '32k',
      '-ar', '48000',
      '-ac', '1',
      '-application', 'voip',
      '-f', 'ogg',
      audioOutput,
    ]);

    const audioStat = await fsp.stat(audioOutput);

    if (audioStat.size > MAX_AUDIO_BYTES) {
      throw new Error(
        `Áudio excedeu o limite configurado (${audioStat.size} bytes).`
      );
    }
  }

  console.log(
    `[STICKER] Conversão concluída: ${(finalSize / 1024).toFixed(1)} KB | ${finalFps} FPS | ${finalSize}px`
  );

  return {
    duration,
    hasAudio: audioExists,
    quality: finalQuality,
  };
}


async function convertVideoToSilentSticker(input, output) {
  const duration = Math.min(
    await getDuration(input),
    MAX_VIDEO_SECONDS
  );

  const filter =
    `fps=10,scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

  for (const q of [65, 55, 45, 35, 25, 18]) {
    await run(FFMPEG, [
      '-y',
      '-i',
      input,
      '-t',
      String(duration),
      '-an',
      '-vf',
      filter,
      '-loop',
      '0',
      '-vsync',
      '0',
      '-vcodec',
      'libwebp',
      '-lossless',
      '0',
      '-q:v',
      String(q),
      '-compression_level',
      '6',
      output,
    ]);

    if ((await fsp.stat(output)).size <= MAX_STICKER_BYTES) {
      return;
    }
  }

  throw new Error(
    'Não foi possível gerar WebP dentro do limite de tamanho do WhatsApp.'
  );
}

// -------------------- Mensagens e mídias --------------------

function unwrapMessage(message) {
  let m = message;

  for (let i = 0; i < 6; i++) {
    if (m?.ephemeralMessage?.message) {
      m = m.ephemeralMessage.message;
    } else if (m?.viewOnceMessage?.message) {
      m = m.viewOnceMessage.message;
    } else if (m?.viewOnceMessageV2?.message) {
      m = m.viewOnceMessageV2.message;
    } else if (m?.documentWithCaptionMessage?.message) {
      m = m.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  return m || {};
}

function getText(message) {
  const m = unwrapMessage(message);

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

function getMediaType(message) {
  const m = unwrapMessage(message);

  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';

  return null;
}

function safeName(ext) {
  return `${Date.now()}_${crypto.randomBytes(5).toString('hex')}${ext}`;
}

async function downloadIncomingMedia(sock, message) {
  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage,
    }
  );

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Não foi possível baixar a mídia recebida.');
  }

  return buffer;
}

function getSender(message) {
  const jid = message.key.remoteJid || '';
  const isGroup = jid.endsWith('@g.us');

  const contactId = isGroup
    ? (message.key.participant || message.key.participantAlt || jid)
    : jid;

  const contactName = message.pushName || 'Desconhecido';

  return {
    isGroup,
    contactId,
    contactName,
    groupName: null,
  };
}

async function createStickerFromBuffer(
  buffer,
  type,
  { allowSound = true } = {}
) {
  if (!['image', 'video'].includes(type)) {
    throw new Error('Envie uma imagem ou vídeo.');
  }

  const id = crypto.randomBytes(8).toString('hex');

  const input = path.join(TEMP_DIR, `${id}.input`);
  const webp = path.join(TEMP_DIR, `${id}.webp`);
  const ogg = path.join(TEMP_DIR, `${id}.ogg`);

  try {
    await fsp.writeFile(input, buffer);

    let isSound = false;

    if (type === 'image') {
      await convertImageToWebp(input, webp);
    } else if (allowSound) {
      const result = await convertVideoToSticker(
        input,
        webp,
        ogg
      );

      isSound = result.hasAudio;

      if (!isSound) {
        await convertVideoToSilentSticker(input, webp);
      }
    } else {
      await convertVideoToSilentSticker(input, webp);
    }

    return {
      webp,
      ogg: isSound ? ogg : null,
      isSound,
    };
  } catch (error) {
    await Promise.all(
      [webp, ogg].map(f =>
        fsp.rm(f, { force: true }).catch(() => {})
      )
    );

    throw error;
  } finally {
    await fsp.rm(input, { force: true }).catch(() => {});
  }
}

async function createStickerFromIncoming(
  sock,
  message,
  { allowSound = true } = {}
) {
  const type = getMediaType(message.message);

  if (!type) {
    throw new Error('Envie uma imagem ou vídeo.');
  }

  const buffer = await downloadIncomingMedia(sock, message);

  return createStickerFromBuffer(
    buffer,
    type,
    { allowSound }
  );
}

async function sendStickerResult(
  sock,
  jid,
  quotedMessage,
  result,
  sender
) {
  const stickerFile = safeName('.webp');
  const audioFile = result.isSound ? safeName('.ogg') : null;

  const stickerPath = path.join(TEMP_DIR, stickerFile);

  const audioPath = audioFile
    ? path.join(TEMP_DIR, audioFile)
    : null;

  await fsp.copyFile(result.webp, stickerPath);

  if (audioPath) {
    await fsp.copyFile(result.ogg, audioPath);
  }

  try {
    if (result.isSound && audioPath) {
      await sendSoundSticker(
        sock,
        jid,
        stickerPath,
        audioPath,
        quotedMessage
      );
    } else {
      await sock.sendMessage(
        jid,
        {
          sticker: await fsp.readFile(stickerPath),
        },
        {
          quoted: quotedMessage,
        }
      );
    }

    await saveStickerToDB(
      sender.contactName,
      sender.contactId,
      sender.isGroup,
      sender.groupName,
      stickerFile,
      audioFile
    );
  } catch (error) {
    await Promise.all(
      [stickerPath, audioPath]
        .filter(Boolean)
        .map(f => fsp.rm(f, { force: true }).catch(() => {}))
    );

    throw error;
  }
}

// -------------------- Sessões e comandos --------------------

const waitingForSticker = new Map();
const multiStickerSessions = new Map();
const processingChats = new Set();

async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : {}
  );
}

async function processSingleSticker(sock, message, sender) {
  const jid = message.key.remoteJid;

  await sendText(
    sock,
    jid,
    '🤖 Recebi sua mídia! Processando a figurinha...',
    message
  );

  let result;

  try {
    result = await createStickerFromIncoming(
      sock,
      message,
      { allowSound: true }
    );

    await sendStickerResult(
      sock,
      jid,
      message,
      result,
      sender
    );

    await sendText(
      sock,
      jid,
      result.isSound
        ? '🔊 Sound Sticker criado e salvo com sucesso!'
        : '✅ Sticker criado e salvo com sucesso!',
      message
    );
  } finally {
    if (result) {
      await Promise.all(
        [result.webp, result.ogg]
          .filter(Boolean)
          .map(f => fsp.rm(f, { force: true }).catch(() => {}))
      );
    }
  }
}

async function processBatch(sock, jid, queue) {
  if (!queue.length) {
    return sendText(
      sock,
      jid,
      '🤖 Nenhuma mídia recebida. Processo cancelado.'
    );
  }

  await sendText(
    sock,
    jid,
    `🤖 Processando ${queue.length} sticker(s)...`
  );

  let processed = 0;
  let failed = 0;
  let sound = 0;

  for (const item of queue) {
    let result;

    try {
      const mediaBuffer = await item.mediaPromise;

      result = await createStickerFromBuffer(
        mediaBuffer,
        item.mediaType,
        { allowSound: true }
      );

      await sendStickerResult(
        sock,
        jid,
        item.message,
        result,
        item.sender
      );

      processed++;

      if (result.isSound) sound++;
    } catch (error) {
      failed++;
      console.error('Erro no lote:', error.message);
    } finally {
      if (result) {
        await Promise.all(
          [result.webp, result.ogg]
            .filter(Boolean)
            .map(f => fsp.rm(f, { force: true }).catch(() => {}))
        );
      }
    }
  }

  await sendText(
    sock,
    jid,
    `🤖 Processamento concluído!
✅ Sucesso: ${processed}
🔊 Com som: ${sound}
❌ Falha: ${failed}`
  );
}

async function handleCommand(sock, message, sender, text) {
  const jid = message.key.remoteJid;
  const lower = text.trim().toLowerCase();

  if (lower === '!sticker') {
    multiStickerSessions.delete(jid);
    waitingForSticker.set(jid, true);

    await sendText(
      sock,
      jid,
      '🤖 Envie agora uma imagem ou vídeo. Vídeos com áudio serão convertidos em Sound Stickers.',
      message
    );

    return true;
  }

  if (lower === '!stickers') {
    waitingForSticker.delete(jid);
    multiStickerSessions.set(jid, []);

    await sendText(
      sock,
      jid,
      '🤖 Modo múltiplos stickers ativado! Envie várias imagens ou vídeos e digite !pronto quando terminar.',
      message
    );

    return true;
  }

  if (lower === '!pronto' && multiStickerSessions.has(jid)) {
    const queue = multiStickerSessions.get(jid) || [];

    multiStickerSessions.delete(jid);

    await processBatch(sock, jid, queue);

    return true;
  }

  if (lower === '!todos' || lower === '!relatorio') {
    try {
      const rows = await getStickerCounts(sender.contactId);

      let total = 0;
      let groupCount = 0;
      let privateCount = 0;

      for (const row of rows) {
        total += Number(row.total);

        if (row.is_group) {
          groupCount += Number(row.total);
        } else {
          privateCount += Number(row.total);
        }
      }

      await sendText(
        sock,
        jid,
        `🤖 Você já gerou ${total} sticker(s)
✅ Pelo grupo: ${groupCount}
✅ Pelo privado: ${privateCount}

Para exibir os stickers, digite !exibir`,
        message
      );
    } catch (error) {
      console.error('Erro no relatório:', error);

      await sendText(
        sock,
        jid,
        '🤖 Erro ao gerar relatório. Tente novamente mais tarde.',
        message
      );
    }

    return true;
  }

  if (lower.startsWith('!exibir')) {
    try {
      let page = 1;

      const match = lower.match(/^!exibir\s+(\d+)/);

      if (match) {
        page = Number.parseInt(match[1], 10) || 1;
      }

      const stickers = await getStickersByContact(
        sender.contactId
      );

      if (!stickers.length) {
        await sendText(
          sock,
          jid,
          '🤖 Você ainda não criou nenhum sticker.',
          message
        );

        return true;
      }

      const perPage = 5;
      const totalPages = Math.ceil(stickers.length / perPage);

      if (page < 1 || page > totalPages) {
        await sendText(
          sock,
          jid,
          `🤖 Página inválida. Informe um número entre 1 e ${totalPages}.`,
          message
        );

        return true;
      }

      if (page === 1) {
        await sendText(
          sock,
          jid,
          '🤖 Exibição paginada. Use !exibir [número da página], exemplo: !exibir 2.',
          message
        );
      }

      for (const item of stickers.slice(
        (page - 1) * perPage,
        page * perPage
      )) {
        const stickerPath = path.join(
          TEMP_DIR,
          item.file_name
        );

        if (!fs.existsSync(stickerPath)) {
          await sendText(
            sock,
            jid,
            `🤖 O sticker ${item.file_name} não está mais acessível.`,
            message
          );

          continue;
        }

        const audioPath = item.audio_file_name
          ? path.join(TEMP_DIR, item.audio_file_name)
          : null;

        if (audioPath && fs.existsSync(audioPath)) {
          await sendSoundSticker(
            sock,
            jid,
            stickerPath,
            audioPath,
            message
          );
        } else {
          await sock.sendMessage(
            jid,
            {
              sticker: await fsp.readFile(stickerPath),
            },
            {
              quoted: message,
            }
          );
        }
      }

      await sendText(
        sock,
        jid,
        `Página ${page} de ${totalPages}`,
        message
      );
    } catch (error) {
      console.error('Erro ao exibir stickers:', error);

      await sendText(
        sock,
        jid,
        '🤖 Ocorreu um erro ao exibir os stickers. Tente novamente mais tarde.',
        message
      );
    }

    return true;
  }

  return false;
}

async function handleIncomingMessage(sock, message) {
  if (!message.message || message.key.fromMe) return;

  const jid = message.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const sender = getSender(message);

  // Extrai o texto do conteúdo real da mensagem recebida
  const text = getText(message.message);

  const type = getMediaType(message.message);


  if (
    text &&
    await handleCommand(sock, message, sender, text)
  ) {
    return;
  }

  if (waitingForSticker.has(jid)) {
    if (!type) {
      await sendText(
        sock,
        jid,
        '🤖 Envie uma imagem ou vídeo para criar o sticker.',
        message
      );

      return;
    }

    waitingForSticker.delete(jid);

    if (processingChats.has(jid)) return;

    processingChats.add(jid);

    try {
      await processSingleSticker(
        sock,
        message,
        sender
      );
    } catch (error) {
      console.error('Erro ao criar sticker:', error);

      await sendText(
        sock,
        jid,
        `🤖 Erro ao criar o sticker: ${error.message}`,
        message
      );
    } finally {
      processingChats.delete(jid);
    }

    return;
  }

  if (multiStickerSessions.has(jid) && type) {
    const queue = multiStickerSessions.get(jid);

    const mediaPromise = downloadIncomingMedia(
      sock,
      message
    );

    queue.push({
      message,
      sender,
      mediaType: type,
      mediaPromise,
    });

    await sendText(
      sock,
      jid,
      `📥 Mídia adicionada à fila (${queue.length}). Envie mais ou digite !pronto.`,
      message
    );
  }
}

// -------------------- Inicialização / reconexão --------------------

let reconnecting = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    SESSION_DIR
  );

  let version;

  try {
    const latest = await fetchLatestBaileysVersion();

    version = latest.version;

    console.log(
      `📱 WhatsApp Web version: ${version.join('.')}`
    );
  } catch (error) {
    console.warn(
      'Não foi possível consultar a versão mais recente; usando padrão da biblioteca:',
      error.message
    );
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: pino({
      level: process.env.LOG_LEVEL || 'silent',
    }),
    printQRInTerminal: false,
    browser: ['PH Core Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => ({
      conversation: '',
    }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const {
      connection,
      lastDisconnect,
      qr,
    } = update;

    if (qr) {
      console.log(
        '\n📲 Escaneie o QR Code em WhatsApp > Aparelhos conectados > Conectar aparelho:\n'
      );

      qrcode.generate(qr, {
        small: true,
      });
    }

    if (connection === 'open') {
      reconnecting = false;

      console.log(
        `✅ Bot conectado como ${sock.user?.name || sock.user?.id || 'WhatsApp'}`
      );
    }

    if (connection === 'close' && !reconnecting) {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        status === DisconnectReason.loggedOut;

      console.error(
        'Conexão encerrada:',
        status,
        lastDisconnect?.error?.message || 'sem detalhes'
      );

      if (loggedOut) {
        console.error(
          `❌ Sessão deslogada. Remova a pasta ${SESSION_DIR} e faça novo pareamento.`
        );

        return;
      }

      reconnecting = true;

      setTimeout(() => {
        startBot().catch(err => {
          reconnecting = false;
          console.error('Falha ao reconectar:', err);
        });
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleIncomingMessage(sock, message);
      } catch (error) {
        console.error(
          'Erro no evento de mensagem:',
          error
        );
      }
    }
  });

  return sock;
}

// -------------------- Inicialização principal --------------------

async function main() {
  for (const key of [
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
  ]) {
    if (!process.env[key]) {
      throw new Error(
        `Variável ${key} não configurada no .env`
      );
    }
  }

  await connectDB();

  await run(FFMPEG, ['-version']);
  await run(FFPROBE, ['-version']);

  installSoundStickerPatch();

  await startBot();
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

process.on('SIGINT', async () => {
  console.log('\nEncerrando bot...');

  try {
    await dbPool?.end();
  } catch {}

  process.exit(0);
});

main().catch(error => {
  console.error('❌ Falha na inicialização:', error);
  process.exit(1);
});
