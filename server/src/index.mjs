import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'KORA_EVENT_SLUGS', 'ALLOWED_ORIGINS'];
for (const key of required) if (!process.env[key]) throw new Error('Missing required server configuration: ' + key);

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const allowedEvents = new Set(process.env.KORA_EVENT_SLUGS.split(',').map(x => x.trim()).filter(Boolean));
const allowedOrigins = new Set(process.env.ALLOWED_ORIGINS.split(',').map(x => x.trim()).filter(Boolean));
const maxBytes = 100 * 1024 * 1024;
const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin (e.g. internal health checks) are not implicitly authorized:
    // bearer authentication is still mandatory for uploads.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error('Origin not allowed'));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use('/api/wall/balls', rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false
})); // Single instance limiter: replace with shared Redis store if horizontally scaled.

async function requireOperator(req, res, next) {
  const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return res.status(401).json({ error: 'Sign-in required' });
  try {
    const { data, error } = await admin.auth.getUser(token);
    // Only server-trusted, administrator-set metadata authorizes uploading.
    if (error || !data?.user || data.user.app_metadata?.kora_wall_operator !== true) {
      return res.status(403).json({ error: 'Operator authorization required' });
    }
    // Verify operator access to this event using administrator-controlled claims.
    // Prevent a staff member for Event A from publishing to Event B.
    req.authorizedEvents = new Set(Array.isArray(data.user.app_metadata?.kora_wall_events)
      ? data.user.app_metadata.kora_wall_events : []);
    next();
  } catch { res.status(401).json({ error: 'Authentication failed' }); }
}
const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: maxBytes, files: 1, fields: 2, fieldSize: 1024 },
  fileFilter(_req, file, cb) {
    cb(null, file.fieldname === 'video' && file.mimetype === 'video/mp4');
  }
});
let active = 0;
function runBinary(binary, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let completed = false;
    const timer = setTimeout(() => process.kill('SIGKILL'), timeoutMs);
    process.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 65536) process.kill('SIGKILL'); });
    process.stderr.on('data', chunk => { stderr += chunk.toString().slice(-2000); });
    process.on('error', error => { if (!completed) { completed = true; clearTimeout(timer); reject(error); } });
    process.on('close', code => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(binary + ' failed validation/transcoding'));
    });
  });
}
async function checkVideo(path) {
  const handle = await fs.open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4 container');
  } finally { await handle.close(); }
  const raw = await runBinary('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,format_name:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate',
    '-of', 'json', path], 30000);
  const info = JSON.parse(raw);
  const streams = info.streams || [];
  const video = streams.filter(s => s.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!info.format?.format_name?.includes('mp4') && !info.format?.format_name?.includes('mov')) {
    throw new Error('Expected a genuine MP4 container');
  }
  if (video.length !== 1 || video[0].codec_name !== 'h264' || video[0].width !== 720 || video[0].height !== 1280) {
    throw new Error('MP4 must contain one H.264 portrait 720 × 1280 video stream');
  }
  const [n, d] = String(video[0].r_frame_rate).split('/').map(Number);
  const fps = n / (d || 1);
  if (!(duration >= 6 && duration <= 12.15 && fps >= 24 && fps <= 30.1)) {
    throw new Error('MP4 duration or frame rate is outside allowed limits');
  }
  if (video[0].pix_fmt !== 'yuv420p') throw new Error('MP4 pixel format must be yuv420p');
}
app.post('/api/wall/balls', requireOperator, (req, res, next) => {
  if (active >= 2) return res.status(503).json({ error: 'Upload capacity reached' });
  active++;
  upload.single('video')(req, res, err => {
    if (err) { active--; return next(err); }
    handleUpload(req, res).finally(() => { active--; }).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    });
  });
});

async function handleUpload(req, res) {
  const input = req.file?.path;
  let temporaryDirectory;
  let storagePath;
  try {
    const slug = req.body?.eventSlug;
    if (!req.file || req.file.mimetype !== 'video/mp4') return res.status(400).json({ error: 'MP4 file required' });
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(slug) || !allowedEvents.has(slug) || !req.authorizedEvents?.has(slug)) {
      return res.status(400).json({ error: 'Unknown event' });
    }

    await checkVideo(input);
    temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'kora-normalized-'));
    const output = join(temporaryDirectory, 'ready.mp4');
    // Do not trust browser metadata: make a streamable H.264/yuv420p MP4 on the trusted host.
    await runBinary('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input,
      '-map', '0:v:0', '-an', '-vf', 'format=yuv420p', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-movflags', '+faststart', '-t', '12', '-y', output]);
    await checkVideo(output);
    const result = await fs.readFile(output);
    if (result.length > maxBytes) return res.status(413).json({ error: 'Video is too large' });

    storagePath = 'balls/' + slug + '/' + randomUUID() + '.mp4';
    const { error: uploadError } = await admin.storage.from('kora-wall-media').upload(storagePath, result, {
      contentType: 'video/mp4', upsert: false
    });
    if (uploadError) throw new Error('Private storage upload failed');
    // Moderation is intentionally NOT controlled by the client or by this endpoint.
    // This endpoint only accepts staff-authorized non-live promotional clips.
    // For this workflow the server sets event_screen_consent=true, never the browser.
    // Moderation remains separate and approved stays false.
    const { error: insertError } = await admin.from('kora_wall_ball_videos').insert({
      storage_path: storagePath,
      event_screen_consent: true,
      approved: false
    });
    if (insertError) {
      const { error: cleanupError } = await admin.storage.from('kora-wall-media').remove([storagePath]);
      if (cleanupError) console.error('Orphan cleanup failed: operator cleanup required');
      throw new Error('Video metadata registration failed');
    }
    return res.status(202).json({ status: 'pending_approval' });
  } catch (error) {
    console.error('Wall upload rejected:', error instanceof Error ? error.message : 'Unknown error');
    if (!res.headersSent) return res.status(422).json({ error: 'Video upload could not be validated or registered' });
  } finally {
    if (input) await fs.rm(input, { force: true }).catch(() => {});
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Video too large' });
  res.status(400).json({ error: 'Invalid upload request' });
});
app.listen(Number(process.env.PORT || 8787), () => console.log('Protected KORA wall uploader listening'));
