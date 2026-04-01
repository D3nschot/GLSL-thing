const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;

const FFMPEG = resolveFfmpegPath();

const tmpRoot = path.join(os.tmpdir(), 'vfx-node-export');
fs.mkdirSync(tmpRoot, { recursive: true });

// In-memory registry of uploaded temp files (auto-cleaned on mux completion)
const uploads = new Map(); // id -> { path, createdAt, kind, name }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API routes
    if (url.pathname === '/api/ping') {
      const available = isRunnableFfmpeg(FFMPEG);
      return sendJson(res, available ? 200 : 500, {
        ok: available,
        ffmpeg: FFMPEG,
        error: available ? null : buildMissingFfmpegMessage(),
      });
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const kind = url.searchParams.get('kind') || 'file';
      const ext = guessExt(req.headers['content-type']);
      const originalName = sanitizeName(req.headers['x-filename'] || `${kind}${ext}`);
      const id = crypto.randomUUID();
      const filePath = path.join(tmpRoot, `${Date.now()}_${id}_${originalName}`);
      await streamToFile(req, filePath);
      uploads.set(id, { path: filePath, createdAt: Date.now(), kind, name: originalName });
      return sendJson(res, 200, { ok: true, id });
    }

    if (url.pathname === '/api/mux' && req.method === 'POST') {
      const videoId = url.searchParams.get('videoId');
      const sourceId = url.searchParams.get('sourceId');
      const video = videoId ? uploads.get(videoId) : null;
      const source = sourceId ? uploads.get(sourceId) : null;
      if (!video || !source) {
        return sendJson(res, 400, { ok: false, error: 'Missing or invalid videoId/sourceId.' });
      }

      const outPath = path.join(tmpRoot, `${Date.now()}_${crypto.randomUUID()}_processed.mp4`);

      const args = [
        '-y',
        '-i', video.path,
        '-i', source.path,
        '-map', '0:v:0',
        '-map', '1:a:0?',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        outPath,
      ];

      let stderr = '';
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      let responded = false;
      let cleanedUp = false;
      const cleanupOnce = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanupUpload(videoId);
        cleanupUpload(sourceId);
        cleanupFile(outPath);
      };

      const abort = () => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch {}
        }
        cleanupOnce();
        if (!responded && !res.headersSent && !res.writableEnded) {
          responded = true;
          res.statusCode = 499; // client closed request
          res.end();
        }
      };

      req.on('aborted', abort);
      res.on('close', abort);

      const safeSendJson = (status, obj) => {
        if (responded || res.headersSent || res.writableEnded) {
          cleanupOnce();
          return;
        }
        responded = true;
        sendJson(res, status, obj);
        cleanupOnce();
      };

      proc.on('error', (err) => {
        cleanupOnce();
        const extra = err && err.code === 'ENOENT' ? ` ${buildMissingFfmpegMessage()}` : '';
        safeSendJson(500, { ok: false, error: `Failed to start ffmpeg: ${err.message}.${extra}`.trim() });
      });

      proc.on('close', (code) => {
        if (responded || res.headersSent || res.writableEnded) {
          cleanupOnce();
          return;
        }
        if (code !== 0) {
          cleanupOnce();
          return safeSendJson(500, { ok: false, error: `ffmpeg failed (code ${code}).`, details: stderr.slice(-4000) });
        }

        responded = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="processed_video.mp4"');
        const stream = fs.createReadStream(outPath);
        stream.pipe(res);
        stream.on('close', cleanupOnce);
        stream.on('error', cleanupOnce);
      });
      return;
    }

    // Static file serving
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = decodeURIComponent(url.pathname === '/' ? '/Index.html' : url.pathname);
      const filePath = safeJoin(ROOT, rel);
      if (!filePath) return sendText(res, 403, 'Forbidden');
      return serveStatic(req, res, filePath);
    }

    sendText(res, 404, 'Not found');
  } catch (err) {
    sendText(res, 500, `Server error: ${err && err.message ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`VFX server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Using ffmpeg: ${FFMPEG}`);
});

function sendJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function sendText(res, status, text) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(String(text));
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function safeJoin(root, rel) {
  if (!rel.startsWith('/')) return null;
  const resolved = path.resolve(root, '.' + rel);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return resolved;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(filePath));
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function streamToFile(req, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    req.pipe(out);
    req.on('aborted', () => {
      out.destroy();
      cleanupFile(filePath);
      reject(new Error('Upload aborted'));
    });
    out.on('finish', resolve);
    out.on('error', (err) => {
      cleanupFile(filePath);
      reject(err);
    });
  });
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 180);
}

function cleanupFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

function cleanupUpload(id) {
  const meta = uploads.get(id);
  if (!meta) return;
  uploads.delete(id);
  cleanupFile(meta.path);
}

function guessExt(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('video/mp4')) return '.mp4';
  if (ct.includes('video/webm')) return '.webm';
  if (ct.includes('application/octet-stream')) return '.bin';
  return '';
}

function resolveFfmpegPath() {
  const candidates = [];

  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  const localNames = process.platform === 'win32'
    ? ['ffmpeg.exe', path.join('bin', 'ffmpeg.exe'), path.join('ffmpeg', 'bin', 'ffmpeg.exe')]
    : ['ffmpeg', path.join('bin', 'ffmpeg')];
  for (const rel of localNames) candidates.push(path.join(ROOT, rel));

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
      path.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(programFilesX86, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'ffmpeg.exe',
      'ffmpeg'
    );
  } else {
    candidates.push('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes('WinGet\\Packages')) {
      const wingetPath = findWinGetFfmpeg(candidate);
      if (wingetPath) return wingetPath;
      continue;
    }
    if (isRunnableFfmpeg(candidate)) return candidate;
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function findWinGetFfmpeg(baseDir) {
  try {
    if (!fs.existsSync(baseDir)) return null;
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (!dir.name.toLowerCase().includes('ffmpeg')) continue;
      const full = path.join(baseDir, dir.name);
      const nested = path.join(full, 'ffmpeg.exe');
      const nestedBin = path.join(full, 'bin', 'ffmpeg.exe');
      if (isRunnableFfmpeg(nested)) return nested;
      if (isRunnableFfmpeg(nestedBin)) return nestedBin;
    }
  } catch {}
  return null;
}

function isRunnableFfmpeg(candidate) {
  try {
    execFileSync(candidate, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildMissingFfmpegMessage() {
  if (process.platform === 'win32') {
    return 'Install ffmpeg and add it to PATH, or start the server with `set FFMPEG_PATH=C:\\path\\to\\ffmpeg.exe && node server.js`.';
  }
  return 'Install ffmpeg and add it to PATH, or start the server with `FFMPEG_PATH=/path/to/ffmpeg node server.js`.';
}
