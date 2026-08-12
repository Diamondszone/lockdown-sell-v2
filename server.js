// server.js
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_URL =
  process.env.SOURCE_URL ||
  "";

const CORS_PROXY =
  process.env.CORS_PROXY ||
  "";

// Store results dengan kategori terpisah
let urlDatabase = {
  all: [],           // Semua URL yang pernah diproses
  success: new Set(), // URL sukses (baik direct maupun proxy)
  failed: new Set(),  // URL gagal total
  pending: new Set()  // URL dalam antrian
};

// Detail sukses untuk membedakan direct/proxy
let successDetails = new Map(); // Map<url, {method: 'direct'|'proxy', timestamp, responseSize}>

// Response details untuk domain utama (TANPA CACHE)
let domainResponseDetails = new Map(); // Map<domain, {status, method, responsePreview, timestamp}>

let processingHistory = [];
const MAX_HISTORY = 1000;

// Statistik lengkap
let stats = {
  totalProcessed: 0,
  success: 0,
  failed: 0,
  directSuccess: 0,
  proxySuccess: 0,
  uniqueUrls: 0,
  startTime: new Date(),
  lastProcessed: null,
  successRate: 0
};

// ────────────── PARSER ──────────────
function parseList(txt) {
  return (txt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Fungsi untuk extract domain dari URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol + '//' + urlObj.hostname;
  } catch {
    return null;
  }
}

// PERBAIKAN 1: Fungsi isJson yang lebih toleran
function isJson(body) {
  if (!body || typeof body !== 'string') return false;
  
  let cleanBody = body.trim();
  if (cleanBody.charCodeAt(0) === 0xFEFF) {
    cleanBody = cleanBody.slice(1);
  }
  
  try {
    JSON.parse(cleanBody);
    return true;
  } catch {
    return false;
  }
}

// PERBAIKAN 2: Fungsi isCaptcha yang lebih akurat
function isCaptcha(body) {
  if (!body || typeof body !== 'string') return false;
  
  const t = body.toLowerCase();
  return (
    t.includes("captcha") && 
    (t.includes("please") || t.includes("verify") || t.includes("human") || t.includes("robot"))
  );
}

// PERBAIKAN 3: Bersihkan response sebelum diproses
const fetchText = async (url) => {
  try {
    const resp = await axios.get(url, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      },
      timeout: 30000,
      validateStatus: () => true,
      responseType: "text",
    });

    let responseText = typeof resp.data === "string"
      ? resp.data
      : JSON.stringify(resp.data);
    
    responseText = responseText.trim();
    if (responseText.charCodeAt(0) === 0xFEFF) {
      responseText = responseText.slice(1);
    }

    return {
      ok: resp.status === 200,
      status: resp.status,
      text: responseText,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// PERBAIKAN 4: Build proxy URL dengan format yang benar
const buildProxyUrl = (u) => {
  const baseUrl = CORS_PROXY.endsWith('/') ? CORS_PROXY.slice(0, -1) : CORS_PROXY;
  return `${baseUrl}/${u}`;
};

// ────────────── FUNGSI CEK DOMAIN UTAMA (TANPA CACHE - SELALU REALTIME) ──────────────
async function checkDomain(url) {
  const domain = extractDomain(url);
  if (!domain) return null;
  
  // 🟢 TANPA CACHE - SELALU REQUEST REALTIME
  console.log(`🌐 Checking domain: ${domain}`);
  
  let domainStatus = {
    domain,
    status: 'error',
    ok: false,
    timestamp: new Date().toISOString(),
    method: 'none',
    responsePreview: null
  };
  
  // LANGKAH 1: Coba Direct
  console.log(`  → Direct: ${domain}`);
  try {
    const directResult = await fetchText(domain);
    
    if (directResult.ok) {
      domainStatus = {
        domain,
        status: directResult.status || 'ok',
        ok: true,
        timestamp: new Date().toISOString(),
        method: 'direct',
        responsePreview: directResult.text ? directResult.text.substring(0, 200) : null
      };
      domainResponseDetails.set(domain, domainStatus);
      console.log(`  ✅ Domain ${domain} - Direct: ${directResult.status}`);
      return domainStatus;
    } else {
      console.log(`  ❌ Domain ${domain} - Direct: ${directResult.status}`);
    }
  } catch (error) {
    console.log(`  ❌ Domain ${domain} - Direct error: ${error.message}`);
  }
  
  // LANGKAH 2: Jika Direct Gagal, Coba Proxy
  console.log(`  → Proxy: ${domain}`);
  try {
    const proxyUrl = buildProxyUrl(domain);
    const proxyResult = await fetchText(proxyUrl);
    
    domainStatus = {
      domain,
      status: proxyResult.status || 'error',
      ok: proxyResult.ok || false,
      timestamp: new Date().toISOString(),
      method: 'proxy',
      responsePreview: proxyResult.text ? proxyResult.text.substring(0, 200) : null
    };
    domainResponseDetails.set(domain, domainStatus);
    console.log(`  ✅ Domain ${domain} - Proxy: ${proxyResult.status}`);
    return domainStatus;
  } catch (error) {
    console.log(`  ❌ Domain ${domain} - Proxy error: ${error.message}`);
  }
  
  // GAGAL TOTAL
  domainStatus = {
    domain,
    status: 'error',
    ok: false,
    timestamp: new Date().toISOString(),
    method: 'failed',
    responsePreview: null,
    error: 'Both direct and proxy failed'
  };
  domainResponseDetails.set(domain, domainStatus);
  console.log(`  ❌ Domain ${domain} - GAGAL TOTAL`);
  return domainStatus;
}

// ────────────── LOGIKA BERTINGKAT ──────────────
async function checkUrl(url) {
  // Tandai sebagai pending
  urlDatabase.pending.add(url);
  
  // AMBIL RESPONSE DARI DOMAIN UTAMA (REALTIME - TANPA CACHE)
  const domainStatus = await checkDomain(url);
  
  const result = {
    url,
    direct: null,
    proxy: null,
    finalStatus: null,
    method: null,
    timestamp: new Date().toISOString(),
    domainStatus: domainStatus
  };

  // LANGKAH 1: Coba Direct
  console.log(`🔄 Mencoba DIRECT: ${url.substring(0, 80)}...`);
  const direct = await fetchText(url);
  
  const directIsValid = direct.ok && isJson(direct.text) && !isCaptcha(direct.text);
  
  result.direct = {
    ok: directIsValid,
    status: direct.status,
    error: direct.error,
    responsePreview: direct.text ? direct.text.substring(0, 100) : null
  };

  if (directIsValid) {
    console.log(`✅ DIRECT SUKSES: ${url.substring(0, 80)}...`);
    result.finalStatus = 'success';
    result.method = 'direct';
    addToDatabase(url, 'success', 'direct', {
      responseSize: direct.text.length,
      directStatus: direct.status
    });
    return result;
  }

  // LANGKAH 2: Coba Proxy
  const proxyUrl = buildProxyUrl(url);
  console.log(`🔄 Mencoba PROXY: ${proxyUrl.substring(0, 80)}...`);
  
  const proxied = await fetchText(proxyUrl);
  const proxyIsValid = proxied.ok && isJson(proxied.text) && !isCaptcha(proxied.text);

  result.proxy = {
    ok: proxyIsValid,
    status: proxied.status,
    error: proxied.error,
    responsePreview: proxied.text ? proxied.text.substring(0, 100) : null
  };

  if (proxyIsValid) {
    console.log(`✅ PROXY SUKSES: ${url.substring(0, 80)}...`);
    result.finalStatus = 'success';
    result.method = 'proxy';
    addToDatabase(url, 'success', 'proxy', {
      responseSize: proxied.text.length,
      directStatus: direct.status,
      proxyStatus: proxied.status
    });
    return result;
  }

  // GAGAL TOTAL
  console.log(`❌ GAGAL TOTAL: ${url.substring(0, 80)}...`);
  result.finalStatus = 'failed';
  
  addToDatabase(url, 'failed', null, {
    directStatus: direct.status,
    proxyStatus: proxied.status,
    directPreview: direct.text?.substring(0, 200),
    proxyPreview: proxied.text?.substring(0, 200)
  });
  
  return result;
}

// ────────────── DATABASE MANAGEMENT ──────────────
function addToDatabase(url, status, method = null, details = {}) {
  const timestamp = new Date().toISOString();
  
  if (!urlDatabase.all.includes(url)) {
    urlDatabase.all.push(url);
    stats.uniqueUrls = urlDatabase.all.length;
  }
  
  urlDatabase.pending.delete(url);
  
  if (status === 'success') {
    urlDatabase.success.add(url);
    urlDatabase.failed.delete(url);
    
    successDetails.set(url, {
      method,
      timestamp,
      ...details
    });
    
    if (method === 'direct') {
      stats.directSuccess++;
    } else if (method === 'proxy') {
      stats.proxySuccess++;
    }
    stats.success++;
    
  } else if (status === 'failed') {
    urlDatabase.failed.add(url);
    urlDatabase.success.delete(url);
    successDetails.delete(url);
    stats.failed++;
  }
  
  processingHistory.unshift({
    url,
    status,
    method,
    timestamp,
    details
  });
  
  if (processingHistory.length > MAX_HISTORY) {
    processingHistory = processingHistory.slice(0, MAX_HISTORY);
  }
  
  stats.totalProcessed++;
  stats.lastProcessed = timestamp;
  const totalAttempts = stats.success + stats.failed;
  stats.successRate = totalAttempts > 0 ? ((stats.success / totalAttempts) * 100).toFixed(2) : 0;
}

// Export database dengan metode terpisah
function exportDatabase(format = 'json') {
  const directUrls = [];
  const proxyUrls = [];
  
  for (const url of urlDatabase.success) {
    const details = successDetails.get(url);
    if (details && details.method === 'direct') {
      directUrls.push(url);
    } else if (details && details.method === 'proxy') {
      proxyUrls.push(url);
    }
  }
  
  if (format === 'txt') {
    let domainSection = '\n## DOMAIN RESPONSES\n';
    const domainEntries = Array.from(domainResponseDetails.entries());
    if (domainEntries.length > 0) {
      domainEntries.forEach(([domain, info]) => {
        const methodText = info.method === 'direct' ? 'Direct' : (info.method === 'proxy' ? 'Proxy' : 'Failed');
        domainSection += `# ${domain} - Status: ${info.status} (${methodText}) - ${info.timestamp}\n`;
      });
    } else {
      domainSection += '# No domain responses recorded\n';
    }
    
    return {
      success: Array.from(urlDatabase.success).join('\n'),
      direct: directUrls.join('\n'),
      proxy: proxyUrls.join('\n'),
      failed: Array.from(urlDatabase.failed).join('\n'),
      all: urlDatabase.all.join('\n'),
      domains: domainSection
    };
  }
  
  return {
    stats,
    counts: {
      total: urlDatabase.all.length,
      success: urlDatabase.success.size,
      failed: urlDatabase.failed.size,
      pending: urlDatabase.pending.size,
      direct: directUrls.length,
      proxy: proxyUrls.length
    },
    urls: {
      success: Array.from(urlDatabase.success),
      direct: directUrls,
      proxy: proxyUrls,
      failed: Array.from(urlDatabase.failed),
      pending: Array.from(urlDatabase.pending)
    },
    successDetails: Object.fromEntries(successDetails),
    domainResponseDetails: Object.fromEntries(domainResponseDetails),
    history: processingHistory.slice(0, 100)
  };
}

// Reset database
function resetDatabase() {
  urlDatabase = {
    all: [],
    success: new Set(),
    failed: new Set(),
    pending: new Set()
  };
  
  successDetails.clear();
  domainResponseDetails.clear();
  processingHistory = [];
  
  stats = {
    totalProcessed: 0,
    success: 0,
    failed: 0,
    directSuccess: 0,
    proxySuccess: 0,
    uniqueUrls: 0,
    startTime: new Date(),
    lastProcessed: null,
    successRate: 0
  };
}

// ────────────── HIT URL (MAIN FUNCTION) ──────────────
async function hitUrl(url) {
  return await checkUrl(url);
}

// ────────────── PARALLEL WORKER ──────────────
async function mainLoop() {
  const WORKERS = 10;

  while (true) {
    try {
      const listResp = await fetchText(SOURCE_URL);
      const urls = listResp.ok ? parseList(listResp.text) : [];

      if (urls.length === 0) {
        console.log("❌ SOURCE kosong, ulangi…");
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      console.log(`📌 Memuat ${urls.length} URL…`);
      console.log(`📊 Statistik: Total=${stats.totalProcessed}, Success=${stats.success}, Failed=${stats.failed} (Direct=${stats.directSuccess}, Proxy=${stats.proxySuccess})`);
      console.log(`🔧 Menggunakan proxy: ${CORS_PROXY}`);

      let current = 0;

      async function worker() {
        while (true) {
          let u = urls[current++];
          if (!u) break;
          await hitUrl(u);
        }
      }

      const pool = [];
      for (let i = 0; i < WORKERS; i++) {
        pool.push(worker());
      }

      await Promise.all(pool);
      
      console.log(`⏸️ Selesai satu siklus, istirahat 5 detik...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (err) {
      console.log("❌ ERROR LOOP:", err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// ────────────── HTTP ENDPOINTS ──────────────
const app = express();

app.use(express.static('public'));

app.get("/api/stats", (req, res) => {
  let directCount = 0;
  let proxyCount = 0;
  
  for (const [_, details] of successDetails) {
    if (details.method === 'direct') directCount++;
    else if (details.method === 'proxy') proxyCount++;
  }
  
  res.json({
    stats,
    counts: {
      success: urlDatabase.success.size,
      failed: urlDatabase.failed.size,
      pending: urlDatabase.pending.size,
      total: urlDatabase.all.length,
      direct: directCount,
      proxy: proxyCount
    }
  });
});

app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const status = req.query.status;
  
  let history = processingHistory;
  if (status) {
    history = history.filter(h => h.status === status);
  }
  
  res.json(history.slice(0, limit));
});

app.get("/api/urls/:category", (req, res) => {
  const category = req.params.category;
  const format = req.query.format || 'json';
  
  let urls;
  switch(category) {
    case 'success':
      urls = Array.from(urlDatabase.success);
      break;
    case 'direct':
      urls = [];
      for (const url of urlDatabase.success) {
        const details = successDetails.get(url);
        if (details && details.method === 'direct') {
          urls.push(url);
        }
      }
      break;
    case 'proxy':
      urls = [];
      for (const url of urlDatabase.success) {
        const details = successDetails.get(url);
        if (details && details.method === 'proxy') {
          urls.push(url);
        }
      }
      break;
    case 'failed':
      urls = Array.from(urlDatabase.failed);
      break;
    case 'pending':
      urls = Array.from(urlDatabase.pending);
      break;
    case 'all':
      urls = urlDatabase.all;
      break;
    default:
      return res.status(400).json({ error: 'Invalid category' });
  }
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    res.send(urls.join('\n'));
  } else {
    res.json({ 
      category, 
      count: urls.length, 
      urls,
      details: category === 'success' ? Object.fromEntries(
        urls.map(url => [url, successDetails.get(url)])
      ) : null
    });
  }
});

// API endpoint untuk domain responses
app.get("/api/domain-responses", (req, res) => {
  const entries = Array.from(domainResponseDetails.entries());
  const sorted = entries.sort((a, b) => {
    const timeA = new Date(a[1].timestamp);
    const timeB = new Date(b[1].timestamp);
    return timeB - timeA;
  });
  
  res.json({
    total: sorted.length,
    domains: Object.fromEntries(sorted)
  });
});

app.get("/api/url/:url", (req, res) => {
  const url = decodeURIComponent(req.params.url);
  
  const details = successDetails.get(url);
  const isSuccess = urlDatabase.success.has(url);
  const isFailed = urlDatabase.failed.has(url);
  const isPending = urlDatabase.pending.has(url);
  const domain = extractDomain(url);
  const domainResponse = domain ? domainResponseDetails.get(domain) : null;
  
  res.json({
    url,
    exists: urlDatabase.all.includes(url),
    status: isSuccess ? 'success' : (isFailed ? 'failed' : (isPending ? 'pending' : 'unknown')),
    method: details ? details.method : null,
    details: details || null,
    domainResponse: domainResponse || null
  });
});

app.get("/api/export/:format?", (req, res) => {
  const format = req.params.format || 'json';
  const data = exportDatabase(format);
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    const directCount = data.direct.split('\n').filter(Boolean).length;
    const proxyCount = data.proxy.split('\n').filter(Boolean).length;
    const failedCount = data.failed.split('\n').filter(Boolean).length;
    const successCount = data.success.split('\n').filter(Boolean).length;
    
    res.send(`
# URL DATABASE EXPORT - ${timestamp}
# =================================================

## STATISTIK
# Total Success: ${successCount} (Direct: ${directCount}, Proxy: ${proxyCount})
# Total Failed: ${failedCount}
# Total All: ${data.all.split('\n').filter(Boolean).length}

## DIRECT SUCCESS (${directCount} URLs)
${data.direct}

## PROXY SUCCESS (${proxyCount} URLs)
${data.proxy}

## FAILED (${failedCount} URLs)
${data.failed}

## ALL URLS (${data.all.split('\n').filter(Boolean).length} URLs)
${data.all}
${data.domains}
    `);
  } else {
    res.json(data);
  }
});

app.post("/api/reset", (req, res) => {
  resetDatabase();
  res.json({ message: 'Database reset successfully', stats });
});

app.get("/api/config", (req, res) => {
  res.json({
    sourceUrl: SOURCE_URL,
    corsProxy: CORS_PROXY,
    workers: 10,
    maxHistory: MAX_HISTORY,
    uptime: process.uptime()
  });
});

app.get("/api/debug-proxy", async (req, res) => {
  const testUrl = req.query.url || "";
  
  if (!testUrl) {
    return res.json({ error: "No URL provided. Use ?url=YOUR_URL" });
  }
  
  const results = {
    proxy_base: CORS_PROXY,
    test_url: testUrl,
    built_url: buildProxyUrl(testUrl),
    direct: null,
    proxy: null
  };
  
  try {
    const direct = await axios.get(testUrl, { 
      timeout: 15000,
      headers: { 
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });
    results.direct = { 
      status: direct.status, 
      data_preview: JSON.stringify(direct.data).substring(0, 200) 
    };
  } catch(e) {
    results.direct = { error: e.message };
  }
  
  const proxyFullUrl = buildProxyUrl(testUrl);
  try {
    const proxied = await axios.get(proxyFullUrl, { 
      timeout: 15000,
      headers: { 
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });
    results.proxy = { 
      status: proxied.status, 
      data_preview: JSON.stringify(proxied.data).substring(0, 200),
      isJson: isJson(JSON.stringify(proxied.data))
    };
  } catch(e) {
    results.proxy = { error: e.message };
  }
  
  res.json(results);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Web server OK on port ${PORT}`)
);

mainLoop();
