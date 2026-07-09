const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
// Main Supabase credentials — used only by the server-side /api/db-status route.
// Browser config (including these values) lives exclusively in js/config.js.
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';


const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

// ── Supabase REST helper (server-side) ───────────────────────────────────────
function supabaseGet(table, params) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return reject(new Error('Supabase credentials not configured'));
    }
    const query = params ? '?' + params : '';
    const urlStr = `${SUPABASE_URL}/rest/v1/${table}${query}`;
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'return=representation',
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── /api/db-status — diagnose Supabase connection & tables ───────────────────
async function handleDbStatus(res) {
  const report = {
    supabase_url_set: !!SUPABASE_URL,
    supabase_key_set: !!SUPABASE_ANON_KEY,
    supabase_url_preview: SUPABASE_URL ? SUPABASE_URL.substring(0, 40) + '...' : 'NOT SET',
    tables: {}
  };

  const tables = ['stories', 'episodes', 'slides', 'likes', 'library', 'comments', 'notifications', 'profiles'];
  for (const table of tables) {
    try {
      const r = await supabaseGet(table, 'limit=1');
      if (r.status === 200) {
        report.tables[table] = { exists: true, status: 200 };
      } else if (r.status === 404 || (r.data && r.data.code === 'PGRST205')) {
        report.tables[table] = { exists: false, status: r.status, error: r.data && r.data.message };
      } else {
        report.tables[table] = { exists: false, status: r.status, error: r.data && r.data.message };
      }
    } catch (e) {
      report.tables[table] = { exists: false, error: e.message };
    }
  }

  // Count stories
  try {
    const r = await supabaseGet('stories', 'select=count&limit=1');
    if (r.status === 200 && Array.isArray(r.data)) {
      report.stories_count = r.data.length;
    }
    const r2 = await supabaseGet('stories', 'select=id,title,category&limit=20&order=id.asc');
    if (r2.status === 200 && Array.isArray(r2.data)) {
      report.stories_sample = r2.data;
    }
  } catch (e) {}

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(report, null, 2));
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // API Routes
  if (urlPath === '/api/db-status') {
    await handleDbStatus(res);
    return;
  }

  let filePath = urlPath;
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(404); res.end('Not found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
        });
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Emperor FM server running on port ${PORT}`);
  console.log(`Supabase URL: ${SUPABASE_URL ? SUPABASE_URL.substring(0, 40) + '...' : 'NOT SET'}`);
  console.log(`Supabase Key: ${SUPABASE_ANON_KEY ? 'SET (' + SUPABASE_ANON_KEY.length + ' chars)' : 'NOT SET'}`);
});
