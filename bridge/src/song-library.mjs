import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = path.join(BRIDGE_ROOT, 'state');
const CACHE_ROOT = path.join(STATE_ROOT, 'song-cache');
const ARCHIVE_ROOT = path.resolve(BRIDGE_ROOT, '..', '..', 'state', 'song-library');
const DB_PATH = path.join(STATE_ROOT, 'song-library.sqlite');
const DEFAULT_FFMPEG = path.resolve(BRIDGE_ROOT, '..', '..', 'state', 'singing-rvc', 'ffmpeg', 'bin', 'ffmpeg.exe');
const MIN_AUDIO_BYTES = 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const PROCESS_PID = process.pid;

let database;

function db() {
  if (database) return database;
  mkdirSync(STATE_ROOT, { recursive: true });
  database = new DatabaseSync(process.env.DSH_SONG_LIBRARY_DB || DB_PATH);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS songs (
      song_id TEXT PRIMARY KEY, title TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL, voice_variant TEXT NOT NULL DEFAULT '', audio_path TEXT NOT NULL,
      preview_path TEXT NOT NULL, audio_sha256 TEXT NOT NULL UNIQUE, duration REAL NOT NULL,
      start_seconds REAL NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE TABLE IF NOT EXISTS preview_requests (
      request_id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, sender_id TEXT NOT NULL,
      song_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS preview_requests_created ON preview_requests(created_at, status);
    CREATE INDEX IF NOT EXISTS preview_requests_chat ON preview_requests(chat_key, status);
    CREATE TABLE IF NOT EXISTS credit_ledger (
      entry_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL, receipt_id TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE(receipt_id, kind)
    );
    CREATE TABLE IF NOT EXISTS paid_song_orders (
      order_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, chat_key TEXT NOT NULL,
      query TEXT NOT NULL, kind TEXT NOT NULL, price_cents INTEGER NOT NULL,
      status TEXT NOT NULL, confirmed_segments INTEGER NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source_identity TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', output_path TEXT NOT NULL DEFAULT '',
      voice_variant TEXT NOT NULL DEFAULT '', process_pid INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS paid_song_segments (
      order_id TEXT NOT NULL, segment_index INTEGER NOT NULL, start_seconds REAL NOT NULL,
      seconds REAL NOT NULL, cache_path TEXT NOT NULL, status TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(order_id,segment_index)
    );
    CREATE TABLE IF NOT EXISTS red_packet_receipts (
      receipt_id TEXT PRIMARY KEY, packet_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      chat_key TEXT NOT NULL, amount_cents INTEGER NOT NULL, receipt TEXT NOT NULL,
      received_at INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE(packet_id, receipt_id)
    );
    CREATE TABLE IF NOT EXISTS red_packet_candidates (
      candidate_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, chat_key TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', notification_status TEXT NOT NULL DEFAULT 'pending',
      receipt_ref TEXT, UNIQUE(bot_id, message_id)
    );
  `);
  if (!database.prepare('PRAGMA table_info(paid_song_orders)').all().some((column) => column.name === 'output_path')) {
    database.exec("ALTER TABLE paid_song_orders ADD COLUMN output_path TEXT NOT NULL DEFAULT ''");
  }
  if (!database.prepare('PRAGMA table_info(paid_song_orders)').all().some((column) => column.name === 'voice_variant')) {
    database.exec("ALTER TABLE paid_song_orders ADD COLUMN voice_variant TEXT NOT NULL DEFAULT ''");
  }
  if (!database.prepare('PRAGMA table_info(paid_song_orders)').all().some((column) => column.name === 'process_pid')) {
    database.exec('ALTER TABLE paid_song_orders ADD COLUMN process_pid INTEGER NOT NULL DEFAULT 0');
  }
  return database;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function mediaDuration(audio) {
  let offset = 0;
  if (audio.length >= 10 && audio.toString('ascii', 0, 3) === 'ID3') {
    const size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) | ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
    offset = 10 + size + ((audio[5] & 0x10) ? 10 : 0);
  }
  const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const mpeg1Bitrates = {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  };
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const mpeg2Layer1Bitrates = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= audio.length) {
    const header = audio.readUInt32BE(offset);
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000) break;
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const sampleIndex = (header >>> 10) & 3;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) break;
    const layerNumber = 4 - layer;
    const bitrate = (version === 3 ? mpeg1Bitrates[layerNumber]
      : layerNumber === 1 ? mpeg2Layer1Bitrates : mpeg2Bitrates)[bitrateIndex] * 1000;
    const sampleRate = rates[version]?.[sampleIndex];
    if (!bitrate || !sampleRate) break;
    const padding = (header >>> 9) & 1;
    const mpeg2Layer3 = layerNumber === 3 && version !== 3;
    const samples = layerNumber === 1 ? 384 : (mpeg2Layer3 ? 576 : 1152);
    const frameLength = layerNumber === 1
      ? Math.floor(12 * bitrate / sampleRate + padding) * 4
      : Math.floor((mpeg2Layer3 ? 72 : 144) * bitrate / sampleRate) + padding;
    if (frameLength < 4 || offset + frameLength > audio.length) break;
    seconds += samples / sampleRate;
    frames++;
    offset += frameLength;
  }
  const trailing = audio.length - offset;
  const hasId3v1 = trailing === 128 && audio.toString('ascii', offset, offset + 3) === 'TAG';
  const hasApeTag = trailing === 32 && audio.toString('ascii', offset, offset + 8) === 'APETAGEX';
  return frames >= 10 && (trailing === 0 || hasId3v1 || hasApeTag) ? seconds : null;
}

export function inspectMp3Duration(audio) { return Buffer.isBuffer(audio) ? mediaDuration(audio) : null; }

function decodeMp3(file) {
  const ffmpeg = process.env.DSH_FFMPEG || DEFAULT_FFMPEG;
  const command = existsSync(ffmpeg) ? ffmpeg : 'ffmpeg';
  const result = spawnSync(command, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024
  });
  return !result.error && result.status === 0;
}

function insertVerifiedSong({ file, title, query = '', mode = 'ai', voiceVariant = '', startSeconds = 0, expectedSeconds = 30, createdAt = Date.now() }, { decodeImpl = decodeMp3 } = {}) {
  if (!existsSync(file)) return false;
  let info;
  try { info = statSync(file); } catch { return false; }
  if (!info.isFile() || info.size < MIN_AUDIO_BYTES || info.size > MAX_AUDIO_BYTES) return false;
  const audio = readFileSync(file);
  const duration = mediaDuration(audio);
  // The playlist only exposes actual 30-second material. A missing/unknown duration is not trusted.
  if (!Number.isFinite(duration) || duration < 29.5 || duration > 30.5 || expectedSeconds !== 30) return false;
  if (!decodeImpl(file)) return false;
  const digest = sha256(audio);
  const songId = digest.slice(0, 12);
  const insert = db().prepare(`INSERT INTO songs
    (song_id,title,query,mode,voice_variant,audio_path,preview_path,audio_sha256,duration,start_seconds,created_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'ready')
    ON CONFLICT(audio_sha256) DO UPDATE SET title=excluded.title, query=excluded.query,
      mode=excluded.mode, voice_variant=excluded.voice_variant, audio_path=excluded.audio_path,
      preview_path=excluded.preview_path, duration=excluded.duration, start_seconds=excluded.start_seconds,
      status='ready'`);
  insert.run(songId, String(title).slice(0, 160), String(query).slice(0, 160), mode,
    String(voiceVariant), file, file, digest, duration, startSeconds, createdAt);
  return true;
}

export function refreshSongLibrary({ cacheRoot = CACHE_ROOT, archiveRoot = process.env.DSH_SONG_ARCHIVE || ARCHIVE_ROOT, decodeImpl = decodeMp3 } = {}) {
  const results = { indexed: 0, rejected: 0 };
  const scanCache = (root) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('recent-song-')) continue;
      const metaPath = path.join(root, entry.name);
      const audioPath = metaPath.slice(0, -5) + '.mp3';
      let meta;
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { results.rejected++; continue; }
      const expectedSeconds = Number(meta.seconds ?? meta.durationSeconds);
      if (expectedSeconds !== 30 || !meta.title || !audioPath.toLowerCase().endsWith('.mp3')) { results.rejected++; continue; }
      if (insertVerifiedSong({ file: audioPath, title: meta.title, query: meta.query, mode: meta.mode,
        voiceVariant: meta.voiceVariant, startSeconds: Number(meta.startSeconds) || 0,
        expectedSeconds, createdAt: Number(meta.at) || Date.now() }, { decodeImpl })) results.indexed++;
      else results.rejected++;
    }
  };
  scanCache(cacheRoot);
  scanCache(archiveRoot);
  return results;
}

export function listSongs({ offset = 0, limit = 20 } = {}) {
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = db().prepare(`SELECT song_id,title,mode,voice_variant,duration,created_at
    FROM songs WHERE status='ready' ORDER BY created_at DESC,song_id LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
  const count = db().prepare("SELECT COUNT(*) AS count FROM songs WHERE status='ready'").get().count;
  return { songs: rows, total: count, offset: safeOffset, limit: safeLimit };
}

export function getSong(songId) {
  return db().prepare("SELECT * FROM songs WHERE song_id=? AND status='ready'").get(String(songId).toLowerCase()) ?? null;
}

export function getVerifiedSongPreview(songId) {
  const song = getSong(songId);
  if (!song || song.preview_path !== song.audio_path || !existsSync(song.preview_path)) return null;
  let audio;
  try { audio = readFileSync(song.preview_path); } catch { return null; }
  if (audio.length < MIN_AUDIO_BYTES || audio.length > MAX_AUDIO_BYTES || sha256(audio) !== song.audio_sha256) return null;
  const duration = mediaDuration(audio);
  if (!Number.isFinite(duration) || duration < 29.5 || duration > 30.5) return null;
  return { ...song, audio };
}

export function reserveFreePreview({ chatKey, senderId, songId, now = Date.now() }) {
  const database = db();
  const song = database.prepare("SELECT song_id FROM songs WHERE song_id=? AND status='ready'").get(String(songId).toLowerCase());
  if (!song) return { ok: false, reason: 'missing-song' };
  database.exec('BEGIN IMMEDIATE');
  try {
    const busy = database.prepare("SELECT request_id FROM preview_requests WHERE chat_key=? AND status IN ('reserved','uncertain')").get(chatKey);
    if (busy) { database.exec('COMMIT'); return { ok: false, reason: 'conversation-busy' }; }
    const local = new Date(now + 8 * 60 * 60 * 1000);
    local.setUTCHours(0, 0, 0, 0);
    const dayStart = local.getTime() - 8 * 60 * 60 * 1000;
    const daily = database.prepare("SELECT COUNT(*) AS n FROM preview_requests WHERE created_at>=? AND created_at<=? AND status IN ('reserved','sent','uncertain')").get(dayStart, now).n;
    if (daily >= 30) { database.exec('COMMIT'); return { ok: false, reason: 'daily-limit' }; }
    const rolling = database.prepare("SELECT COUNT(*) AS n FROM preview_requests WHERE created_at>? AND created_at<=? AND status IN ('reserved','sent','uncertain')").get(now - 10 * 60_000, now).n;
    if (rolling >= 3) { database.exec('COMMIT'); return { ok: false, reason: 'rolling-limit' }; }
    const requestId = createHash('sha256').update(`${chatKey}\0${senderId}\0${song.song_id}\0${now}\0${Math.random()}`).digest('hex');
    database.prepare('INSERT INTO preview_requests(request_id,chat_key,sender_id,song_id,created_at,status) VALUES(?,?,?,?,?,?)')
      .run(requestId, String(chatKey), String(senderId), song.song_id, now, 'reserved');
    database.exec('COMMIT');
    return { ok: true, requestId };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function settleFreePreview(requestId, status) {
  if (!['sent', 'failed', 'uncertain'].includes(status)) throw new Error('invalid preview state');
  return db().prepare("UPDATE preview_requests SET status=? WHERE request_id=? AND status='reserved'").run(status, requestId).changes === 1;
}

export function reconcilePreviewReservations({ now = Date.now(), staleAfterMs = 120_000 } = {}) {
  return db().prepare("UPDATE preview_requests SET status='uncertain' WHERE status='reserved' AND created_at<?")
    .run(now - Math.max(30_000, staleAfterMs)).changes;
}

export function listUncertainPreviews({ limit = 20 } = {}) {
  return db().prepare(`SELECT request_id,chat_key,sender_id,song_id,created_at FROM preview_requests
    WHERE status='uncertain' ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(100, Math.trunc(limit))));
}

export function resolveUncertainPreview(requestId, outcome) {
  if (!['sent', 'failed'].includes(outcome)) throw new Error('invalid resolution');
  return db().prepare("UPDATE preview_requests SET status=? WHERE request_id=? AND status='uncertain'")
    .run(outcome, String(requestId)).changes === 1;
}

export function getFreeQuota({ now = Date.now() } = {}) {
  const database = db();
  const local = new Date(now + 8 * 60 * 60 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  const dayStart = local.getTime() - 8 * 60 * 60 * 1000;
  const statuses = "('reserved','sent','uncertain')";
  const daily = database.prepare(`SELECT COUNT(*) AS n FROM preview_requests WHERE created_at>=? AND created_at<=? AND status IN ${statuses}`).get(dayStart, now).n;
  const rolling = database.prepare(`SELECT COUNT(*) AS n FROM preview_requests WHERE created_at>? AND created_at<=? AND status IN ${statuses}`).get(now - 10 * 60_000, now).n;
  return { dailyUsed: daily, dailyLimit: 30, rollingUsed: rolling, rollingLimit: 3 };
}

export function getVerifiedCreditBalance(senderId) {
  const database = db();
  const row = database.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount_cents FROM credit_ledger WHERE sender_id=? AND status='verified'")
    .get(String(senderId));
  const reserved = database.prepare("SELECT COALESCE(SUM(price_cents),0) AS amount_cents FROM paid_song_orders WHERE sender_id=? AND status IN ('reserved','processing','partial','uncertain')")
    .get(String(senderId));
  return Number(row?.amount_cents ?? 0) - Number(reserved?.amount_cents ?? 0);
}

export function reservePaidSongOrder({ senderId, chatKey, query, kind, now = Date.now(), processPid = PROCESS_PID }) {
  const price = kind === 'preview' ? 100 : kind === 'full' ? 300 : 0;
  if (!price || !String(query ?? '').trim()) return { ok: false, reason: 'invalid-input' };
  const database = db();
  recoverAbandonedPaidSongOrders({ now, isProcessAlive: defaultProcessAlive });
  database.exec('BEGIN IMMEDIATE');
  try {
    const resumable = database.prepare(`SELECT order_id,status,price_cents FROM paid_song_orders
      WHERE sender_id=? AND chat_key=? AND query=? AND kind=? AND status='partial' ORDER BY created_at DESC LIMIT 1`)
      .get(String(senderId), String(chatKey), String(query).trim(), kind);
    if (resumable) {
      const claimed = database.prepare("UPDATE paid_song_orders SET status='processing',updated_at=?,process_pid=? WHERE order_id=? AND status='partial'")
        .run(now, Number(processPid), resumable.order_id);
      if (claimed.changes === 1) {
        database.exec('COMMIT');
        return { ok: true, orderId: resumable.order_id, priceCents: resumable.price_cents, resume: true };
      }
    }
    const busy = database.prepare("SELECT order_id FROM paid_song_orders WHERE chat_key=? AND status IN ('reserved','processing','partial','uncertain')").get(String(chatKey));
    if (busy) { database.exec('COMMIT'); return { ok: false, reason: 'conversation-busy' }; }
    const outstanding = Number(database.prepare("SELECT COALESCE(SUM(price_cents),0) AS amount FROM paid_song_orders WHERE sender_id=? AND status IN ('reserved','processing','partial','uncertain')").get(String(senderId)).amount);
    const credited = Number(database.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM credit_ledger WHERE sender_id=? AND status='verified'").get(String(senderId)).amount);
    if (credited - outstanding < price) { database.exec('COMMIT'); return { ok: false, reason: 'insufficient-credit' }; }
    const orderId = createHash('sha256').update(`${senderId}\0${chatKey}\0${query}\0${now}\0${Math.random()}`).digest('hex');
    database.prepare(`INSERT INTO paid_song_orders(order_id,sender_id,chat_key,query,kind,price_cents,status,created_at,updated_at,process_pid)
      VALUES(?,?,?,?,?,?,'reserved',?,?,?)`).run(orderId, String(senderId), String(chatKey), String(query).trim(), kind, price, now, now, Number(processPid));
    database.exec('COMMIT');
    return { ok: true, orderId, priceCents: price };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function listPaidSongSegments(orderId) {
  return db().prepare('SELECT order_id,segment_index,start_seconds,seconds,cache_path,status,updated_at FROM paid_song_segments WHERE order_id=? ORDER BY segment_index')
    .all(String(orderId));
}

export function getPaidSongOrder(orderId) {
  return db().prepare(`SELECT order_id,sender_id,chat_key,query,kind,price_cents,status,source_identity,title,voice_variant,
    segment_count,confirmed_segments,output_path FROM paid_song_orders WHERE order_id=?`).get(String(orderId)) ?? null;
}

export function savePaidSongSegments(orderId, { sourceIdentity, title, voiceVariant = '', segments, now = Date.now() }) {
  if (!Array.isArray(segments) || !segments.length || segments.some((item, index) => item.segmentIndex !== index || !item.cachePath)) return false;
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = database.prepare("SELECT * FROM paid_song_orders WHERE order_id=? AND status IN ('reserved','processing','partial')").get(String(orderId));
    if (!order) { database.exec('COMMIT'); return false; }
    if (order.source_identity && order.source_identity !== String(sourceIdentity)) { database.exec('COMMIT'); return false; }
    const existing = database.prepare('SELECT segment_index,start_seconds,seconds,cache_path FROM paid_song_segments WHERE order_id=? ORDER BY segment_index').all(String(orderId));
    if (existing.length && (existing.length !== segments.length || existing.some((row, i) =>
      row.segment_index !== segments[i].segmentIndex || row.start_seconds !== segments[i].startSeconds
      || row.seconds !== segments[i].seconds || row.cache_path !== segments[i].cachePath))) { database.exec('COMMIT'); return false; }
    if (!existing.length) {
      const insert = database.prepare(`INSERT INTO paid_song_segments(order_id,segment_index,start_seconds,seconds,cache_path,status,updated_at)
        VALUES(?,?,?,?,?,'ready',?)`);
      for (const item of segments) insert.run(String(orderId), item.segmentIndex, item.startSeconds, item.seconds, item.cachePath, now);
    }
    database.prepare(`UPDATE paid_song_orders SET source_identity=?,title=?,voice_variant=?,segment_count=?,output_path=?,status='processing',updated_at=? WHERE order_id=?`)
      .run(String(sourceIdentity), String(title).slice(0, 160), String(voiceVariant), segments.length, segments[0].cachePath, now, String(orderId));
    database.exec('COMMIT'); return true;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function updatePaidSongSegment(orderId, segmentIndex, status, { now = Date.now() } = {}) {
  if (!['ready','sending','sent','uncertain'].includes(status)) throw new Error('invalid paid segment state');
  const result = db().prepare(`UPDATE paid_song_segments SET status=?,updated_at=? WHERE order_id=? AND segment_index=?
    AND status IN ('ready','sending','uncertain')`).run(status, now, String(orderId), segmentIndex);
  return result.changes === 1;
}

export function updatePaidSongOrder(orderId, { status, confirmedSegments, segmentCount, sourceIdentity, title, outputPath, now = Date.now() }) {
  if (!['processing','partial','uncertain','failed','completed'].includes(status)) throw new Error('invalid paid order state');
  const database = db();
  if (status === 'completed') {
    database.exec('BEGIN IMMEDIATE');
    try {
      const order = database.prepare("SELECT * FROM paid_song_orders WHERE order_id=? AND status IN ('reserved','processing','partial')").get(String(orderId));
      if (!order) { database.exec('COMMIT'); return false; }
      if (order.kind === 'full' && Number(confirmedSegments ?? order.confirmed_segments) !== Number(segmentCount ?? order.segment_count)) {
        database.exec('COMMIT'); return false;
      }
      if (order.kind === 'full') {
        const total = Number(order.segment_count);
        if (!Number.isInteger(total) || total <= 0 || Number(segmentCount ?? total) !== total
          || !order.source_identity || !order.title || !order.output_path) { database.exec('COMMIT'); return false; }
        const recorded = Number(database.prepare('SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=?').get(String(orderId)).n);
        const sent = Number(database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status='sent'").get(String(orderId)).n);
        if (recorded !== total || sent !== total) { database.exec('COMMIT'); return false; }
      } else {
        const segment = database.prepare("SELECT status,cache_path FROM paid_song_segments WHERE order_id=? AND segment_index=0").get(String(orderId));
        if (Number(order.segment_count) !== 1 || Number(confirmedSegments ?? 1) !== 1
          || !order.source_identity || !order.title || !order.output_path || !segment
          || segment.status !== 'sent' || !segment.cache_path) { database.exec('COMMIT'); return false; }
      }
      database.prepare(`INSERT INTO credit_ledger(entry_id,sender_id,amount_cents,kind,receipt_id,created_at,status)
        VALUES(?,?,?,'paid_song',?,?,'verified')`).run(createHash('sha256').update(`paid_song\0${orderId}`).digest('hex'),
          order.sender_id, -Number(order.price_cents), String(orderId), now);
      database.prepare("UPDATE paid_song_orders SET status='completed',confirmed_segments=?,segment_count=?,source_identity=?,title=?,output_path=?,updated_at=? WHERE order_id=?")
        .run(Number(confirmedSegments ?? order.confirmed_segments), Number(segmentCount ?? order.segment_count),
          String(sourceIdentity ?? order.source_identity), String(title ?? order.title), String(outputPath ?? order.output_path), now, String(orderId));
      database.exec('COMMIT'); return true;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  return database.prepare(`UPDATE paid_song_orders SET status=?,confirmed_segments=COALESCE(?,confirmed_segments),
    segment_count=COALESCE(?,segment_count),source_identity=COALESCE(?,source_identity),title=COALESCE(?,title),
    output_path=COALESCE(?,output_path),updated_at=?
    WHERE order_id=? AND status IN ('reserved','processing','partial','uncertain')`)
    .run(status, confirmedSegments ?? null, segmentCount ?? null, sourceIdentity ?? null, title ?? null, outputPath ?? null, now, String(orderId)).changes === 1;
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function recoverAbandonedPaidSongOrders({ now, isProcessAlive }) {
  const database = db();
  const candidates = database.prepare("SELECT * FROM paid_song_orders WHERE status IN ('reserved','processing')").all();
  let recovered = 0;
  for (const candidate of candidates) {
    if (isProcessAlive(candidate.process_pid)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      const order = database.prepare("SELECT * FROM paid_song_orders WHERE order_id=? AND status IN ('reserved','processing')")
        .get(candidate.order_id);
      if (!order || isProcessAlive(order.process_pid)) { database.exec('COMMIT'); continue; }
      database.prepare("UPDATE paid_song_segments SET status='uncertain',updated_at=? WHERE order_id=? AND status='sending'")
        .run(now, order.order_id);
      const sent = Number(database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status='sent'").get(order.order_id).n);
      const uncertain = Number(database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status='uncertain'").get(order.order_id).n);
      const recorded = Number(database.prepare('SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=?').get(order.order_id).n);
      if (order.kind === 'preview' && sent === 1 && uncertain === 0 && recorded === 1
        && order.source_identity && order.title && order.output_path && Number(order.segment_count) === 1) {
        database.prepare(`INSERT OR IGNORE INTO credit_ledger(entry_id,sender_id,amount_cents,kind,receipt_id,created_at,status)
          VALUES(?,?,?,'paid_song',?,?,'verified')`).run(createHash('sha256').update(`paid_song\0${order.order_id}`).digest('hex'),
            order.sender_id, -Number(order.price_cents), order.order_id, now);
        database.prepare("UPDATE paid_song_orders SET status='completed',confirmed_segments=1,segment_count=1,updated_at=? WHERE order_id=?")
          .run(now, order.order_id);
      } else {
        const nextStatus = uncertain ? 'uncertain' : order.kind === 'full' && sent ? 'partial' : 'failed';
        database.prepare('UPDATE paid_song_orders SET status=?,confirmed_segments=?,updated_at=? WHERE order_id=?')
          .run(nextStatus, sent, now, order.order_id);
      }
      database.exec('COMMIT');
      recovered++;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  return recovered;
}

export function listUncertainPaidSongOrders({ limit = 20, now = Date.now(), isProcessAlive = defaultProcessAlive } = {}) {
  recoverAbandonedPaidSongOrders({ now, isProcessAlive });
  const database = db();
  return database.prepare(`SELECT order_id,sender_id,chat_key,query,kind,price_cents,status,
    segment_count,source_identity,title,output_path,created_at,
    COALESCE((SELECT COUNT(*) FROM paid_song_segments WHERE order_id=paid_song_orders.order_id AND status='sent'),confirmed_segments) AS confirmed_segments,
    (SELECT MIN(segment_index) FROM paid_song_segments WHERE order_id=paid_song_orders.order_id AND status='uncertain') AS uncertain_segment_index
    FROM paid_song_orders WHERE status='uncertain'
    ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(100, Math.trunc(limit))));
}

export function resolvePaidSongOrder(orderId, outcome, { segmentIndex = null, now = Date.now() } = {}) {
  if (!['sent','not_sent'].includes(outcome)) throw new Error('invalid paid order resolution');
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = database.prepare("SELECT * FROM paid_song_orders WHERE order_id=? AND status='uncertain'").get(String(orderId));
    if (!order) { database.exec('COMMIT'); return false; }
    if (order.kind === 'full') {
      if (segmentIndex == null && outcome === 'not_sent' && Number(order.confirmed_segments) === 0) {
        const attempted = database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status IN ('sending','uncertain','sent')").get(String(orderId)).n;
        if (Number(attempted) === 0) {
          database.prepare("UPDATE paid_song_orders SET status='failed',updated_at=? WHERE order_id=? AND status='uncertain'")
            .run(now, String(orderId));
          database.exec('COMMIT'); return true;
        }
      }
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= Number(order.segment_count)) { database.exec('COMMIT'); return false; }
      const segment = database.prepare("SELECT status FROM paid_song_segments WHERE order_id=? AND segment_index=?").get(String(orderId), segmentIndex);
      if (!segment || segment.status !== 'uncertain' || !order.title || !order.source_identity) { database.exec('COMMIT'); return false; }
      database.prepare('UPDATE paid_song_segments SET status=?,updated_at=? WHERE order_id=? AND segment_index=? AND status=\'uncertain\'')
        .run(outcome === 'sent' ? 'sent' : 'ready', now, String(orderId), segmentIndex);
      const sent = Number(database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status='sent'").get(String(orderId)).n);
      const uncertain = Number(database.prepare("SELECT COUNT(*) AS n FROM paid_song_segments WHERE order_id=? AND status='uncertain'").get(String(orderId)).n);
      if (sent === Number(order.segment_count)) {
        database.prepare(`INSERT INTO credit_ledger(entry_id,sender_id,amount_cents,kind,receipt_id,created_at,status)
          VALUES(?,?,?,'paid_song',?,?,'verified')`).run(createHash('sha256').update(`paid_song\0${orderId}`).digest('hex'),
            order.sender_id, -Number(order.price_cents), String(orderId), now);
        database.prepare("UPDATE paid_song_orders SET status='completed',confirmed_segments=?,updated_at=? WHERE order_id=? AND status='uncertain'")
          .run(sent, now, String(orderId));
      } else {
        database.prepare("UPDATE paid_song_orders SET status=?,confirmed_segments=?,updated_at=? WHERE order_id=? AND status='uncertain'")
          .run(uncertain > 0 ? 'uncertain' : 'partial', sent, now, String(orderId));
      }
      database.exec('COMMIT');
      if (sent === Number(order.segment_count) && order.output_path) {
        try { registerSongOutput({ file: order.output_path, title: order.title, query: order.query, mode: 'ai', startSeconds: 0, seconds: 30 }); }
        catch (error) { console.error(`[paid-song] reconciled catalog registration failed order=${orderId}:`, error?.message ?? error); }
      }
      return true;
    }
    if (outcome === 'not_sent') {
      database.prepare("UPDATE paid_song_segments SET status='ready',updated_at=? WHERE order_id=? AND status='uncertain'")
        .run(now, String(orderId));
      database.prepare("UPDATE paid_song_orders SET status='failed',updated_at=? WHERE order_id=? AND status='uncertain'")
        .run(now, String(orderId));
      database.exec('COMMIT'); return true;
    }
    const previewSegment = database.prepare("SELECT status,cache_path FROM paid_song_segments WHERE order_id=? AND segment_index=0").get(String(orderId));
    if (!order.title || !order.source_identity || !order.output_path || order.kind !== 'preview'
      || Number(order.segment_count) !== 1 || !previewSegment || previewSegment.status !== 'uncertain' || !previewSegment.cache_path) {
      database.exec('COMMIT'); return false;
    }
    database.prepare(`INSERT INTO credit_ledger(entry_id,sender_id,amount_cents,kind,receipt_id,created_at,status)
      VALUES(?,?,?,'paid_song',?,?,'verified')`).run(createHash('sha256').update(`paid_song\0${orderId}`).digest('hex'),
        order.sender_id, -Number(order.price_cents), String(orderId), now);
    database.prepare("UPDATE paid_song_segments SET status='sent',updated_at=? WHERE order_id=? AND status='uncertain'")
      .run(now, String(orderId));
    database.prepare("UPDATE paid_song_orders SET status='completed',confirmed_segments=1,segment_count=1,updated_at=? WHERE order_id=? AND status='uncertain'")
      .run(now, String(orderId));
    database.exec('COMMIT');
    if (order.output_path) {
      try { registerSongOutput({ file: order.output_path, title: order.title, query: order.query, mode: 'ai', startSeconds: 30, seconds: 30 }); }
      catch (error) { console.error(`[paid-song] reconciled catalog registration failed order=${orderId}:`, error?.message ?? error); }
    }
    return true;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function registerSongOutput({ file, title, query, mode, voiceVariant = '', startSeconds = 0, seconds = 30, createdAt = Date.now() }, options = {}) {
  return insertVerifiedSong({ file, title, query, mode, voiceVariant, startSeconds, expectedSeconds: seconds, createdAt }, options);
}

export function redPacketCapabilityStatus() {
  return { autoClaim: false, walletBalance: false,
    reason: '当前 OneBot/NapCat 适配器未提供经过验证的 QQ 红包领取回执或 QQ 钱包余额查询接口。' };
}

// This adapter emits the canonical QQ packet notice as plain text. It is spoofable,
// so it can only create a manual-review candidate and never verify receipt.
const QQ_PACKET_NOTICE = '[QQ红包]请使用新版手机QQ查收红包。';
export function hasRedPacketMarker(message, rawMessage = '') {
  if (Array.isArray(message) && message.some((segment) =>
    ['redbag', 'red_packet', 'qq_red_packet'].includes(String(segment?.type ?? '').toLowerCase()))) return true;
  const exactMessage = typeof message === 'string' ? message
    : Array.isArray(message) && message.length === 1 && message[0]?.type === 'text'
      ? String(message[0].data?.text ?? '') : '';
  return exactMessage === QQ_PACKET_NOTICE || String(rawMessage ?? '') === QQ_PACKET_NOTICE;
}

export function recordRedPacketCandidate({ botId, messageId, senderId, chatKey, now = Date.now() }) {
  const bot = String(botId ?? '').trim();
  const message = String(messageId ?? '').trim();
  const sender = String(senderId ?? '').trim();
  if (!bot || !message || !sender) return null;
  const candidateId = createHash('sha256').update(`${bot}\0${message}`).digest('hex');
  db().prepare(`INSERT OR IGNORE INTO red_packet_candidates
    (candidate_id,bot_id,message_id,sender_id,chat_key,created_at) VALUES(?,?,?,?,?,?)`)
    .run(candidateId, bot, message, sender, String(chatKey ?? ''), now);
  return db().prepare('SELECT * FROM red_packet_candidates WHERE candidate_id=?').get(candidateId);
}

export function listPendingRedPacketCandidates({ limit = 50 } = {}) {
  return db().prepare(`SELECT candidate_id,bot_id,message_id,sender_id,chat_key,created_at,notification_status
    FROM red_packet_candidates WHERE status='pending' ORDER BY created_at LIMIT ?`)
    .all(Math.max(1, Math.min(100, Math.trunc(limit))));
}

export function claimRedPacketCandidateNotification(candidateId, { now = Date.now(), cooldownMs = 30_000 } = {}) {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const candidate = database.prepare(`SELECT candidate_id,sender_id,chat_key,created_at FROM red_packet_candidates
      WHERE candidate_id=? AND status='pending' AND notification_status='pending'`).get(String(candidateId));
    if (!candidate) { database.exec('COMMIT'); return false; }
    const recentNotice = database.prepare(`SELECT candidate_id FROM red_packet_candidates
      WHERE sender_id=? AND chat_key=? AND candidate_id<>? AND notification_status='sent'
        AND created_at>? AND created_at<=? LIMIT 1`)
      .get(candidate.sender_id, candidate.chat_key, candidate.candidate_id, now - Math.max(0, cooldownMs), now);
    if (recentNotice) {
      database.prepare(`UPDATE red_packet_candidates SET notification_status='suppressed' WHERE candidate_id=?`)
        .run(candidate.candidate_id);
      database.exec('COMMIT');
      return false;
    }
    database.prepare(`UPDATE red_packet_candidates SET notification_status='sending' WHERE candidate_id=?`)
      .run(candidate.candidate_id);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function settleRedPacketCandidateNotification(candidateId, status) {
  if (!['sent', 'failed', 'pending'].includes(status)) throw new Error('invalid notification state');
  return db().prepare(`UPDATE red_packet_candidates SET notification_status=?
    WHERE candidate_id=? AND status='pending' AND notification_status='sending'`)
    .run(status, String(candidateId)).changes === 1;
}

export function approveRedPacketCandidate({ candidateId, amountCents, receiptRef, now = Date.now() }) {
  const id = String(candidateId ?? '').trim().toLowerCase();
  const cents = Number(amountCents);
  const ref = String(receiptRef ?? '').trim();
  if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(cents) || cents <= 0 || !ref || ref.length > 160) {
    return { ok: false, reason: 'invalid-input' };
  }
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const candidate = database.prepare("SELECT * FROM red_packet_candidates WHERE candidate_id=? AND status='pending'").get(id);
    if (!candidate) { database.exec('COMMIT'); return { ok: false, reason: 'not-pending' }; }
    const duplicateRef = database.prepare('SELECT receipt_id FROM red_packet_receipts WHERE receipt_id=?').get(ref);
    if (duplicateRef) { database.exec('COMMIT'); return { ok: false, reason: 'duplicate-reference' }; }
    database.prepare(`INSERT INTO red_packet_receipts
      (receipt_id,packet_id,sender_id,chat_key,amount_cents,receipt,received_at,status)
      VALUES(?,?,?,?,?,?,?,'owner_verified')`)
      .run(ref, id, candidate.sender_id, candidate.chat_key, cents, `owner_manual:${ref}`, now);
    database.prepare(`INSERT INTO credit_ledger
      (entry_id,sender_id,amount_cents,kind,receipt_id,created_at,status)
      VALUES(?,?,?,'red_packet',?,?,'verified')`)
      .run(createHash('sha256').update(`red_packet\0${id}`).digest('hex'), candidate.sender_id, cents, ref, now);
    database.prepare(`UPDATE red_packet_candidates SET status='approved',receipt_ref=? WHERE candidate_id=? AND status='pending'`)
      .run(ref, id);
    database.exec('COMMIT');
    return { ok: true, senderId: candidate.sender_id, amountCents: cents, receiptRef: ref };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function rejectRedPacketCandidate(candidateId) {
  return db().prepare("UPDATE red_packet_candidates SET status='rejected' WHERE candidate_id=? AND status='pending'")
    .run(String(candidateId ?? '').trim().toLowerCase()).changes === 1;
}

export function ownerLedgerSummary() {
  const database = db();
  const rows = database.prepare(`SELECT sender_id, SUM(amount_cents) AS amount_cents FROM credit_ledger
    WHERE status='verified' GROUP BY sender_id ORDER BY sender_id`).all();
  return rows.map((row) => {
    const reserved = database.prepare(`SELECT COALESCE(SUM(price_cents),0) AS amount_cents FROM paid_song_orders
      WHERE sender_id=? AND status IN ('reserved','processing','partial','uncertain')`).get(row.sender_id);
    return { ...row, amount_cents: Number(row.amount_cents) - Number(reserved?.amount_cents ?? 0) };
  });
}

export function closeSongLibraryForTests() {
  database?.close();
  database = undefined;
}
