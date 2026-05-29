const express = require('express');
const UAParser = require('ua-parser-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true); // important for getting real IP behind Render's proxy

const PORT = process.env.PORT || 3000;
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.pradeep.androidintegration';

// In-memory store for now; swap to Postgres later
const clickStore = [];

// ====================== CLICK ENDPOINT ======================
app.get('/click', (req, res) => {
  const ua = new UAParser(req.headers['user-agent']);
  const clickId = crypto.randomBytes(8).toString('hex');
  
  const clickRecord = {
    click_id: clickId,
    campaign: req.query.campaign || 'unknown',
    media_source: req.query.pid || 'unknown',
    timestamp: Date.now(),
    
    // Server-side capture (Apps Script couldn't do these)
    ip: req.ip,
    user_agent: req.headers['user-agent'],
    accept_language: req.headers['accept-language'],
    referer: req.headers['referer'] || null,
    
    // Parsed UA
    os: ua.getOS().name,
    os_version: ua.getOS().version,
    device_model: ua.getDevice().model,
    device_vendor: ua.getDevice().vendor,
    browser: ua.getBrowser().name,
  };
  
  clickStore.push(clickRecord);
  console.log('CLICK:', clickRecord);
  
  const referrerParam = encodeURIComponent(`click_id=${clickId}`);
  const finalStoreUrl = `${PLAY_STORE_URL}&referrer=${referrerParam}`;
  
  // Interstitial that also captures JS fingerprint, then redirects
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redirecting...</title>
<style>body{font-family:-apple-system,sans-serif;text-align:center;padding:40px;background:#f5f5f5}
.s{width:40px;height:40px;border:4px solid #ddd;border-top-color:#4285f4;border-radius:50%;margin:20px auto;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="s"></div><p>Taking you to the Play Store...</p>
<script>
(function(){
  const CLICK_ID = ${JSON.stringify(clickId)};
  const FINAL = ${JSON.stringify(finalStoreUrl)};
  
  function canvasHash(){try{const c=document.createElement('canvas');const x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';x.fillStyle='#f60';x.fillRect(125,1,62,20);x.fillStyle='#069';x.fillText('fp-test',2,15);const d=c.toDataURL();let h=0;for(let i=0;i<d.length;i++){h=((h<<5)-h)+d.charCodeAt(i);h|=0}return String(h)}catch(e){return 'na'}}
  function webgl(){try{const c=document.createElement('canvas');const g=c.getContext('webgl');if(!g)return{v:'na',r:'na'};const d=g.getExtension('WEBGL_debug_renderer_info');return d?{v:g.getParameter(d.UNMASKED_VENDOR_WEBGL),r:g.getParameter(d.UNMASKED_RENDERER_WEBGL)}:{v:'na',r:'na'}}catch(e){return{v:'err',r:'err'}}}
  
  const w = webgl();
  const payload = {
    click_id: CLICK_ID,
    screen_w: screen.width, screen_h: screen.height, color_depth: screen.colorDepth,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tz_offset: new Date().getTimezoneOffset(),
    languages: (navigator.languages || [navigator.language]).join(','),
    platform: navigator.platform,
    hw_concurrency: navigator.hardwareConcurrency || 0,
    device_memory: navigator.deviceMemory || 0,
    max_touch_points: navigator.maxTouchPoints || 0,
    canvas_hash: canvasHash(),
    webgl_vendor: w.v, webgl_renderer: w.r
  };
  
  fetch('/click-enrich', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  setTimeout(()=>{window.location.href=FINAL},600);
})();
</script></body></html>`);
});

app.post('/click-enrich', (req, res) => {
  const record = clickStore.find(c => c.click_id === req.body.click_id);
  if (record) Object.assign(record, req.body);
  res.json({ ok: true });
});

// ====================== DEBUG ENDPOINTS ======================
app.get('/clicks', (req, res) => res.json(clickStore));
app.get('/health', (req, res) => res.json({ ok: true, clicks: clickStore.length }));

// ====================== INSTALL ENDPOINT ======================
const installStore = [];

app.post('/install', async (req, res) => {
  const install = {
    ...req.body,
    install_time: Date.now(),
    install_ip: req.ip
  };

  console.log('INSTALL RECEIVED:', install);

  let matchedClick = null;
  let matchType = 'organic';
  let confidence = 0;

  // ===== STRATEGY 1: Deterministic match via Install Referrer =====
  if (install.install_referrer) {
    const params = new URLSearchParams(install.install_referrer);
    const clickId = params.get('click_id');
    if (clickId) {
      matchedClick = clickStore.find(c => c.click_id === clickId);
      if (matchedClick) {
        matchType = 'deterministic';
        confidence = 1.0;
        console.log(`✅ Deterministic match: ${clickId}`);
      } else {
        console.log(`⚠️  click_id ${clickId} not found in store (server may have restarted)`);
      }
    }
  }

  // ===== STRATEGY 2: Probabilistic fingerprint match =====
  if (!matchedClick) {
    const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h
    const candidates = clickStore.filter(c =>
      install.install_time - c.timestamp < LOOKBACK_MS
    );

    let bestScore = 0;
    let best = null;
    for (const click of candidates) {
      const score = scoreMatch(click, install);
      if (score > bestScore) {
        bestScore = score;
        best = click;
      }
    }

    if (best && bestScore >= 0.6) {
      matchedClick = best;
      matchType = 'probabilistic';
      confidence = bestScore;
      console.log(`📊 Probabilistic match: ${best.click_id} (score: ${bestScore.toFixed(2)})`);
    } else {
      console.log(`❌ No match found (best score: ${bestScore.toFixed(2)}, candidates: ${candidates.length})`);
    }
  }

  // ===== Store the install record =====
  const installRecord = {
    ...install,
    matched_click_id: matchedClick?.click_id || null,
    match_type: matchType,
    match_confidence: confidence,
    campaign: matchedClick?.campaign || 'organic',
    media_source: matchedClick?.media_source || 'organic'
  };
  installStore.push(installRecord);

  // Fire the CleverTap postback referencing the clevertap_id
  const postbackResult = await fireCleverTapPostback(installRecord);
  installRecord.postback_result = postbackResult;

  res.json({
    matched: !!matchedClick,
    match_type: matchType,
    confidence,
    attribution: matchedClick ? {
      campaign: matchedClick.campaign,
      media_source: matchedClick.media_source,
      click_id: matchedClick.click_id
    } : null,
    clevertap_postback: postbackResult
  });
});

// Fingerprint scoring function
function scoreMatch(click, install) {
  let score = 0;
  let totalWeight = 0;

  // IP match (strongest signal) — weight 0.35
  totalWeight += 0.35;
  if (click.ip && install.install_ip && click.ip === install.install_ip) {
    score += 0.35;
  }

  // Device model — weight 0.20
  totalWeight += 0.20;
  if (click.device_model && install.device_model &&
      click.device_model.toLowerCase() === install.device_model.toLowerCase()) {
    score += 0.20;
  }

  // Screen resolution — weight 0.15
  totalWeight += 0.15;
  if (click.screen_w == install.screen_w && click.screen_h == install.screen_h) {
    score += 0.15;
  }

  // OS version — weight 0.10
  totalWeight += 0.10;
  if (click.os_version && install.os_version &&
      click.os_version === install.os_version) {
    score += 0.10;
  }

  // Timezone — weight 0.10
  totalWeight += 0.10;
  if (click.timezone && install.timezone && click.timezone === install.timezone) {
    score += 0.10;
  }

  // Language — weight 0.10
  totalWeight += 0.10;
  if (click.accept_language && install.locale) {
    const clickLang = click.accept_language.split(',')[0]?.split('-')[0]?.toLowerCase();
    const installLang = install.locale.split('_')[0]?.toLowerCase();
    if (clickLang === installLang) {
      score += 0.10;
    }
  }

  return totalWeight > 0 ? score / totalWeight : 0;
}

// Debug endpoint to see all installs
app.get('/installs', (req, res) => res.json(installStore));

// ====================== END INSTALL ENDPOINT ======================

// ====================== CLEVERTAP APPSFLYER POSTBACK ======================
const CT_ACCOUNT_ID = process.env.CT_ACCOUNT_ID;
const CT_ACCOUNT_TOKEN = process.env.CT_ACCOUNT_TOKEN;
const CT_ACCOUNT_PASSCODE = process.env.CT_ACCOUNT_PASSCODE;
const CT_APPSFLYER_ENDPOINT = process.env.CT_APPSFLYER_ENDPOINT || 'https://api.clevertap.com/appsflyer';

// Format epoch milliseconds into AppsFlyer's "YYYY-MM-DD HH:mm:ss.SSS" UTC format
function formatAfTime(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  const padMs = (n) => String(n).padStart(3, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${padMs(d.getUTCMilliseconds())}`;
}

async function fireCleverTapPostback(installRecord) {
  // Safety checks
  if (!CT_ACCOUNT_ID || !CT_ACCOUNT_TOKEN || !CT_ACCOUNT_PASSCODE) {
    console.log('⚠️  CleverTap credentials missing — set CT_ACCOUNT_ID, CT_ACCOUNT_TOKEN, CT_ACCOUNT_PASSCODE');
    return { skipped: true, reason: 'no_credentials' };
  }
  if (!installRecord.clevertap_id) {
    console.log('⚠️  No clevertap_id — cannot attach event to a profile');
    return { skipped: true, reason: 'no_clevertap_id' };
  }

  const installTimeMs = installRecord.install_time || Date.now();
  const eventTimeMs = installRecord.event_ts || installTimeMs;
  const clickTimeMs = eventTimeMs - 60000; // synthesize click 60s before event

  // Map our match_type to AppsFlyer's vocabulary
  const afMatchType = installRecord.match_type === 'deterministic' ? 'id_matching'
                    : installRecord.match_type === 'probabilistic' ? 'probabilistic'
                    : 'none';

  // Build the query params from the install record
  const params = new URLSearchParams({
    // CleverTap auth
    account_id: CT_ACCOUNT_ID,
    account_token: CT_ACCOUNT_TOKEN,
    account_passcode: CT_ACCOUNT_PASSCODE,

    // Event identity
    event_type: 'install',
    platform: (installRecord.os || 'Android').toLowerCase(),
    customer_user_id: installRecord.clevertap_id,

    // Attribution (UTM mapping: media_source→utm_source, campaign→utm_campaign, channel→utm_medium)
    media_source: installRecord.media_source || 'organic',
    campaign: installRecord.campaign || 'organic',
    channel: installRecord.channel || 'cpc',
    af_channel: installRecord.channel || 'cpc',
    adset: installRecord.adset || 'mock_adset',
    match_type: afMatchType,

    // App info
    app_id: installRecord.app_package || '',
    app_name: installRecord.app_name || 'Android Integration',
    app_version: String(installRecord.app_version || ''),
    app_build: String(installRecord.app_build || ''),

    // Device info
    os: installRecord.os || 'Android',
    os_version: String(installRecord.os_version || ''),
    sdk_int: String(installRecord.sdk_int || ''),
    device_model: installRecord.device_model || '',
    device_brand: installRecord.device_brand || '',
    device_vendor: installRecord.device_vendor || '',
    device_name: installRecord.device_name || '',
    android_id: installRecord.android_id || '',
    advertising_id: installRecord.advertising_id || '',
    screen_w: String(installRecord.screen_w || ''),
    screen_h: String(installRecord.screen_h || ''),
    screen_density: String(installRecord.screen_density || ''),

    // Locale / network
    timezone: installRecord.timezone || '',
    locale: installRecord.locale || '',
    language: installRecord.language || '',
    country_code: installRecord.country || '',
    carrier: installRecord.carrier || '',
    network: installRecord.network_type || '',
    wifi: installRecord.network_type === 'wifi' ? 'true' : 'false',

    // Timestamps
    install_time: formatAfTime(installTimeMs),
    event_time: formatAfTime(eventTimeMs),
    click_ts: formatAfTime(clickTimeMs),
    gp_install_ts: String(Math.floor(installTimeMs / 1000)),
    gp_click_ts: String(Math.floor(clickTimeMs / 1000)),
    first_install_time: String(installRecord.first_install_time || ''),

    // Custom partner params for debugging (af_sub1–5)
    af_sub1: `click_id=${installRecord.matched_click_id || ''}`,
    af_sub2: `match_type=${installRecord.match_type || 'organic'}`,
    af_sub3: `install_ip=${installRecord.install_ip || ''}`,
    af_sub4: `match_confidence=${installRecord.match_confidence ?? 0}`,

    // Misc
    is_tracking_disable: 'false',
    appsflyer_id: `${installTimeMs}-mockaf${Math.floor(Math.random() * 1e9)}`,
    sdk_version: 'v6.12.1'
  });

  const url = `${CT_APPSFLYER_ENDPOINT}?${params.toString()}`;

  try {
    console.log(`📤 Firing CleverTap postback for profile: ${installRecord.clevertap_id}`);
    console.log(`   Campaign: ${installRecord.campaign} / Source: ${installRecord.media_source} / Match: ${afMatchType}`);

    const response = await fetch(url, { method: 'GET' });
    const text = await response.text();

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    console.log(`📥 CleverTap postback response (HTTP ${response.status}):`, text);

    if (response.status === 200 && (parsed.status === 'success' || text.trim() === '1' || text.toLowerCase().includes('success'))) {
      console.log('✅ Postback accepted by CleverTap');
    } else {
      console.log('⚠️  Postback may have failed — check response above');
    }

    return { http_status: response.status, response: parsed };
  } catch (err) {
    console.error('❌ CleverTap postback request failed:', err.message);
    return { error: err.message };
  }
}
// ====================== END CLEVERTAP APPSFLYER POSTBACK ======================

app.listen(PORT, () => console.log(`Mock attribution partner on :${PORT}`));
