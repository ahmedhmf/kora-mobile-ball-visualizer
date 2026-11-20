// Deploy as Supabase Edge Function "kora-wall-ticket" with verify_jwt=false.
// Public interface: no login, no per-ball forms. Keep secrets only on Supabase.
// File bytes upload DIRECTLY from PWA to Storage with single-object signed ticket.
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const eventSlug = Deno.env.get('KORA_EVENT_SLUG') ?? '';
const rateSalt = Deno.env.get('KORA_RATE_SALT') ?? '';
const allowedOrigins = new Set((Deno.env.get('KORA_ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean));
if (!supabaseUrl || !serviceKey || !rateSalt || !allowedOrigins.size ||
  !/^[A-Za-z0-9_-]{1,64}$/.test(eventSlug)) {
  throw new Error('Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KORA_EVENT_SLUG, KORA_RATE_SALT and KORA_ALLOWED_ORIGINS.');
}
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const MAX_MP4 = 20 * 1024 * 1024;
const encoder = new TextEncoder();
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
async function hash(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
function respond(status: number, data: object, origin: string | null): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin'
  } });
}

// Strict ISO BMFF box parser (checks structure, AVC codec, video dimensions,
// movie duration and faststart). It cannot decode frames or moderate content.
type Box = { offset: number; end: number; type: string; header: number };
function boxes(view: DataView, start: number, end: number): Box[] {
  const result: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos);
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + pos + 4, 4));
    // Large-size and open-ended boxes are rejected to avoid ambiguous parsing.
    if (size < 8 || pos + size > end) throw new Error('Invalid MP4 box boundaries');
    result.push({ offset: pos, end: pos + size, type, header: 8 });
    pos += size;
  }
  if (pos !== end) throw new Error('Trailing invalid MP4 bytes');
  return result;
}
function getBox(parent: Box[], type: string): Box {
  const b = parent.find(x => x.type === type);
  if (!b) throw new Error('Missing MP4 ' + type + ' box');
  return b;
}
function children(view: DataView, parent: Box): Box[] {
  return boxes(view, parent.offset + parent.header, parent.end);
}
function readString(view: DataView, at: number, length: number): string {
  if (at < 0 || at + length > view.byteLength) throw new Error('Truncated MP4 box');
  return String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(at + i)));
}
function validMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 1000 || bytes.length > MAX_MP4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(view, 0, bytes.byteLength);
  const ftyp = getBox(top, 'ftyp');
  const moov = getBox(top, 'moov');
  const mdat = getBox(top, 'mdat');
  if (ftyp.offset !== 0 || moov.offset > mdat.offset || ftyp.end > 200) return false;
  const movie = children(view, moov);
  const mvhd = getBox(movie, 'mvhd');
  const mvhdData = mvhd.offset + 8;
  const version = view.getUint8(mvhdData);
  let seconds: number;
  if (version === 0 && mvhd.end >= mvhdData + 20) {
    seconds = view.getUint32(mvhdData + 16) / view.getUint32(mvhdData + 12);
  } else if (version === 1 && mvhd.end >= mvhdData + 32) {
    seconds = Number(view.getBigUint64(mvhdData + 24)) / view.getUint32(mvhdData + 20);
  } else return false;
  if (!Number.isFinite(seconds) || seconds < 6 || seconds > 12.3) return false;

  const tracks = movie.filter(b => b.type === 'trak');
  if (tracks.length !== 1) return false; // KORA exporter has one video stream, no audio.
  const mdia = children(view, getBox(children(view, tracks[0]), 'mdia'));
  const hdlr = getBox(mdia, 'hdlr');
  if (readString(view, hdlr.offset + 16, 4) !== 'vide') return false;
  const minf = children(view, getBox(mdia, 'minf'));
  const stbl = children(view, getBox(minf, 'stbl'));
  const stsd = getBox(stbl, 'stsd');
  const entryCount = view.getUint32(stsd.offset + 12);
  if (entryCount !== 1) return false;
  const entryOffset = stsd.offset + 16;
  if (entryOffset + 36 > stsd.end) return false;
  const entrySize = view.getUint32(entryOffset);
  if (entrySize < 86 || entryOffset + entrySize > stsd.end ||
      readString(view, entryOffset + 4, 4) !== 'avc1') return false;
  const width = view.getUint16(entryOffset + 32);
  const height = view.getUint16(entryOffset + 34);
  if (width !== 720 || height !== 1280) return false;
  const codecBoxes = boxes(view, entryOffset + 86, entryOffset + entrySize);
  const avcC = getBox(codecBoxes, 'avcC');
  // Baseline profile uses 4:2:0 by specification, matching the app encoder.
  if (view.getUint8(avcC.offset + 9) !== 66) return false;
  return true;
}

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return respond(204, {}, origin);
  if (request.method !== 'POST') return respond(405, { error: 'POST required' }, origin);
  if (!origin || !allowedOrigins.has(origin)) return respond(403, { error: 'Origin not allowed' }, origin);
  if (Number(request.headers.get('content-length') ?? 0) > 2048) return respond(413, { error: 'Request too large' }, origin);
  let payload: Record<string, unknown>;
  try { payload = await request.json(); }
  catch { return respond(400, { error: 'Invalid JSON' }, origin); }

  try {
    if (payload.action === 'ticket') {
      // Prefer proxy-issued client IP. Deploy gateway/WAF with reliable IP
      // normalization; forwarded headers alone are not caller authentication.
      const ip = request.headers.get('cf-connecting-ip') ??
        request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
      if (!ip) return respond(403, { error: 'Cannot establish network identity' }, origin);
      const ipHash = await hash(rateSalt + '/' + ip);
      const ticketId = crypto.randomUUID();
      const ticketSecret = hex(crypto.getRandomValues(new Uint8Array(32)));
      const path = 'balls/' + eventSlug + '/' + crypto.randomUUID() + '.mp4';
      const { error: quotaError } = await admin.rpc('kora_reserve_wall_upload', {
        p_id: ticketId, p_path: path, p_ip_hash: ipHash,
        p_secret_hash: await hash(ticketSecret)
      });
      if (quotaError) {
        if (quotaError.code === 'P0001') return respond(429, { error: 'Upload quota reached' }, origin);
        throw quotaError;
      }
      const { data, error } = await admin.storage.from('kora-wall-media')
        .createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) throw error ?? Error('Could not sign upload');
      return respond(200, {
        ticketId, ticketSecret, storagePath: path, uploadToken: data.token
      }, origin);
    }

    if (payload.action === 'complete') {
      const id = payload.ticketId;
      const proof = payload.ticketSecret;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
        typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) {
        return respond(400, { error: 'Invalid upload receipt' }, origin);
      }

      // Query the ticket path ONLY after checking its secret, never trusting
      // the caller to choose an arbitrary Storage object.
      const secretHash = await hash(proof);
      const { data: ticket, error: lookupError } = await admin.rpc('kora_lookup_wall_upload', {
        p_id: id, p_secret_hash: secretHash
      });
      if (lookupError || typeof ticket !== 'string') return respond(403, { error: 'Upload ticket expired' }, origin);
      const { data: file, error: downloadError } = await admin.storage
        .from('kora-wall-media').download(ticket);
      if (downloadError || !file || file.size > MAX_MP4) {
        return respond(422, { error: 'MP4 not found or over size limit' }, origin);
      }
      const valid = await file.arrayBuffer().then(x => validMp4(new Uint8Array(x))).catch(() => false);
      if (!valid) return respond(422, { error: 'MP4 failed automatic format checks' }, origin);

      const { error } = await admin.rpc('kora_complete_wall_upload', {
        p_id: id, p_secret_hash: secretHash
      });
      if (error) return respond(422, { error: 'Could not register MP4 on event wall' }, origin);
      return respond(200, { status: 'published' }, origin);
    }
    return respond(400, { error: 'Unknown action' }, origin);
  } catch (error) {
    console.error('KORA upload error:', error instanceof Error ? error.message : String(error));
    return respond(503, { error: 'Event media service unavailable' }, origin);
  }
});
