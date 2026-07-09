const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  ACCEPT_BLUE_API_KEY,
  ACCEPT_BLUE_API_KEY_SANDBOX,
  ACCEPT_BLUE_BASE_URL,
  API_KEY,
  SSO_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 3000
} = process.env;

const BASE_URL = (process.env.BASE_URL || 'https://patriot-payments-ghl.onrender.com').replace(/\/$/, '');
const APP_ID = GHL_CLIENT_ID ? GHL_CLIENT_ID.split('-').slice(0, -1).join('-') : '';

// ─── PERSISTENT STORE (Supabase) ───────────────────────────────────────────────
// Replaces the old location_store.json file, which lived on Render's ephemeral
// build filesystem and was wiped on every deploy — silently disconnecting every
// installed merchant. This now persists in Postgres and survives deploys.
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('WARNING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — location store will not persist!');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function loadStore() {
  try {
    const { data, error } = await supabase.from('location_store').select('key, value');
    if (error) throw error;
    const store = {};
    (data || []).forEach(row => { store[row.key] = row.value; });
    return store;
  } catch (e) {
    console.error('Failed to load store from Supabase:', e.message);
    return {};
  }
}

// Full-replace sync: deletes all rows then re-inserts the current in-memory
// store. The store is small (one row per merchant location), so this is cheap
// and avoids ever leaving stale/deleted keys behind in the DB.
async function saveStore(store) {
  try {
    const rows = Object.entries(store).map(([key, value]) => ({ key, value }));
    const { error: delErr } = await supabase.from('location_store').delete().neq('key', '');
    if (delErr) throw delErr;
    if (rows.length) {
      const { error: insErr } = await supabase.from('location_store').insert(rows);
      if (insErr) throw insErr;
    }
  } catch (e) {
    console.error('Failed to save store to Supabase:', e.message);
  }
}

let locationStore = {};

// ─── BUILD HEADERS ────────────────────────────────────────────────────────────
function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Version': '2021-07-28'
  };
}

// ─── CREATE PROVIDER CONFIG ───────────────────────────────────────────────────
// FIX v3.8: Correct endpoint, locationId as query param, all required body fields
// Endpoint: POST /payments/custom-provider/provider?locationId=xxx
// Token type: Sub-Account Token (location-scoped OAuth token)
async function createProviderConfigWithToken(locationId, token) {
  const headers = buildHeaders(token);

  // Step 1: Create provider — locationId in query string, full body per GHL spec
  const integrationPayload = {
    name: 'Patriot Payments',
    description: 'Transparent, no contract payment processing built for small businesses powered by Accept Blue.',
    paymentsUrl: `${BASE_URL}/payments/checkout`,
    queryUrl: `${BASE_URL}/payments/query`,
    imageUrl: `${BASE_URL}/assets/patriot-logo.png`,
    supportsSubscriptionSchedule: false
  };

  console.log(`Step 1: Creating provider for locationId: ${locationId}`);
  console.log('Endpoint: POST /payments/custom-provider/provider?locationId=' + locationId);
  console.log('Payload:', JSON.stringify(integrationPayload));

  const integrationResponse = await axios.post(
    `https://services.leadconnectorhq.com/payments/custom-provider/provider?locationId=${locationId}`,
    integrationPayload,
    { headers }
  );
  console.log('Step 1 SUCCESS:', JSON.stringify(integrationResponse.data));

  const providerId = integrationResponse.data?._id || integrationResponse.data?.id;
  console.log(`Provider ID: ${providerId}`);

  // Step 2: POST /payments/custom-provider/connect?locationId=xxx
  // Body: { live: { apiKey, publishableKey }, test: { apiKey, publishableKey } }
  const configPayload = {
    live: { apiKey: API_KEY, publishableKey: API_KEY },
    test: {
      apiKey: ACCEPT_BLUE_API_KEY_SANDBOX || API_KEY,
      publishableKey: ACCEPT_BLUE_API_KEY_SANDBOX || API_KEY
    }
  };

  console.log('Step 2: Connecting provider config');
  try {
    const configResponse = await axios.post(
      `https://services.leadconnectorhq.com/payments/custom-provider/connect?locationId=${locationId}`,
      configPayload,
      { headers }
    );
    console.log('Step 2 SUCCESS:', JSON.stringify(configResponse.data));
  } catch (configErr) {
    console.log('Step 2 status:', configErr?.response?.status, JSON.stringify(configErr?.response?.data));
  }

  return integrationResponse.data;
}

// ─── GET LOCATION TOKEN ───────────────────────────────────────────────────────
async function getLocationToken(companyToken, locationId) {
  console.log(`Exchanging company token for location token. locationId: ${locationId}`);
  try {
    const companyId = locationStore[`company_${locationId}`]?.companyId
      || locationStore[locationId]?.companyId
      || null;
    const response = await axios.post(
      'https://services.leadconnectorhq.com/oauth/locationToken',
      { companyId, locationId },
      { headers: buildHeaders(companyToken) }
    );
    const locationToken = response.data?.access_token;
    if (!locationToken) throw new Error('No access_token in locationToken response');
    console.log(`✅ Location token obtained for ${locationId}`);
    return locationToken;
  } catch (err) {
    console.error('getLocationToken FAILED:', JSON.stringify(err?.response?.data || err.message));
    console.error('Status:', err?.response?.status);
    console.warn('⚠️ Falling back to company token');
    return companyToken;
  }
}

// ─── CREATE PROVIDER CONFIG (with token exchange for webhook path) ────────────
async function createProviderConfig(locationId, companyToken) {
  const authToken = await getLocationToken(companyToken, locationId);
  return createProviderConfigWithToken(locationId, authToken);
}

// ─── FIND COMPANY TOKEN ───────────────────────────────────────────────────────
function findCompanyToken(companyId) {
  if (locationStore[`company_${companyId}`]?.access_token) {
    return locationStore[`company_${companyId}`].access_token;
  }
  for (const key of Object.keys(locationStore)) {
    if (locationStore[key]?.companyId === companyId && locationStore[key]?.access_token) {
      console.log(`Found company token via location entry: ${key}`);
      return locationStore[key].access_token;
    }
  }
  console.error(`No company token found for companyId: ${companyId}`);
  console.log('Available store keys:', Object.keys(locationStore));
  return null;
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Patriot Payments GHL Integration Server Running',
    version: '4.6.0',
    locations_connected: Object.keys(locationStore).filter(k => !k.startsWith('company_')).length,
    store_backend: 'supabase',
    base_url: BASE_URL
  });
});

// ─── OAUTH CALLBACK ───────────────────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  const redirectUri = `${BASE_URL}/oauth/callback`;
  console.log('=== OAuth callback received ===');
  console.log('redirect_uri:', redirectUri, 'client_id:', GHL_CLIENT_ID);

  try {
    const params = new URLSearchParams();
    params.append('client_id', GHL_CLIENT_ID);
    params.append('client_secret', GHL_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', redirectUri);

    const tokenResponse = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' } }
    );

    console.log('=== TOKEN RESPONSE ===');
    console.log(JSON.stringify(tokenResponse.data, null, 2));

    const accessToken = tokenResponse.data.access_token;
    const companyId = tokenResponse.data.companyId;
    const isBulk = tokenResponse.data.isBulkInstallation;
    const userType = tokenResponse.data.userType;
    const locationId = tokenResponse.data.locationId;

    console.log(`userType: ${userType}, isBulkInstallation: ${isBulk}, companyId: ${companyId}, locationId: ${locationId}`);

    const entry = {
      access_token: accessToken,
      refresh_token: tokenResponse.data.refresh_token,
      companyId,
      connected_at: new Date().toISOString()
    };
    locationStore[`company_${companyId}`] = entry;
    if (locationId) {
      locationStore[locationId] = { ...entry, locationId };
      locationStore[`company_${locationId}`] = { ...entry, companyId };
    }
    await saveStore(locationStore);
    console.log(`Token stored for companyId: ${companyId}${locationId ? `, locationId: ${locationId}` : ''}`);

    if (isBulk || userType === 'Company') {
      console.log(`Bulk/Company install for companyId: ${companyId} — deferred to install webhook`);

    } else if (locationId) {
      // Location install — OAuth token is already location-scoped (Sub-Account Token)
      // Use it directly per GHL spec
      console.log(`Direct location install. locationId: ${locationId}`);
      try {
        const providerResult = await createProviderConfigWithToken(locationId, accessToken);
        console.log('✅ Provider config complete:', JSON.stringify(providerResult));
        locationStore[locationId].providerId = providerResult?._id || providerResult?.id;
        await saveStore(locationStore);
      } catch (provErr) {
        console.error('Provider config FAILED:', JSON.stringify(provErr?.response?.data || provErr.message));
        console.error('Status:', provErr?.response?.status);
      }

    } else {
      console.log('No locationId — provider config deferred to install webhook');
    }

    res.send(`<!DOCTYPE html><html><head><title>Patriot Payments Connected</title>
      <style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}
      body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;}
      .card{background:white;border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:90%;}
      .check{font-size:64px;margin-bottom:16px;}
      h1{color:#1B3A6B;font-size:24px;margin-bottom:12px;}
      p{color:#555;font-size:15px;line-height:1.6;}
      .btn{display:inline-block;margin-top:24px;padding:12px 28px;background:#1B3A6B;color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;}</style>
      </head><body><div class="card">
      <div class="check">✅</div>
      <h1>Patriot Payments Connected!</h1>
      <p>Your GoHighLevel account has been successfully connected to Patriot Payments. You can now process payments through your account.</p>
      <a class="btn" href="https://app.gohighlevel.com">Return to GoHighLevel</a>
      </div></body></html>`);

  } catch (err) {
    console.error('=== OAuth FAILED ===', JSON.stringify(err?.response?.data || err.message));
    res.status(500).send(`<!DOCTYPE html><html><head><title>Connection Error</title>
      <style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}
      body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;}
      .card{background:white;border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;width:90%;}
      h1{color:#C0392B;font-size:24px;margin-bottom:12px;}p{color:#555;font-size:14px;}
      .err{background:#fff5f5;border-radius:8px;padding:12px;margin-top:16px;font-size:12px;color:#C0392B;font-family:monospace;}</style>
      </head><body><div class="card">
      <h1>Connection Error</h1>
      <p>There was an issue connecting your account. Please try again or contact support.</p>
      <div class="err">${err?.response?.data?.message || err.message}</div>
      <p style="margin-top:16px;font-size:13px;">Support: patriotspayments.com | (941) 367-5076</p>
      </div></body></html>`);
  }
});

// ─── INSTALL WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhooks/install', async (req, res) => {
  res.status(200).json({ success: true });
  const { locationId, companyId } = req.body;
  console.log('=== INSTALL WEBHOOK ===', JSON.stringify(req.body, null, 2));
  if (!locationId || !companyId) { console.log('Missing locationId or companyId'); return; }

  const companyToken = findCompanyToken(companyId);
  if (!companyToken) { console.error(`No company token for companyId: ${companyId}`); return; }

  if (!locationStore[locationId]) {
    locationStore[locationId] = { access_token: companyToken, companyId, locationId };
  }
  locationStore[`company_${locationId}`] = { access_token: companyToken, companyId };
  await saveStore(locationStore);

  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    const providerResult = await createProviderConfig(locationId, companyToken);
    locationStore[locationId] = {
      access_token: companyToken, companyId, locationId,
      providerId: providerResult?._id || providerResult?.id,
      installed_at: new Date().toISOString()
    };
    await saveStore(locationStore);
    console.log(`✅ Provider config complete for locationId: ${locationId}`);
  } catch (e) {
    console.error(`Webhook install FAILED for ${locationId}:`, JSON.stringify(e?.response?.data || e.message), 'Status:', e?.response?.status);
  }
});

// ─── UNINSTALL WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhooks/uninstall', async (req, res) => {
  const { locationId, companyId } = req.body;
  console.log(`=== UNINSTALL WEBHOOK === locationId: ${locationId}, companyId: ${companyId}`);
  if (locationId && locationStore[locationId]) { delete locationStore[locationId]; }
  if (locationId && locationStore[`company_${locationId}`]) { delete locationStore[`company_${locationId}`]; }
  await saveStore(locationStore);
  res.status(200).json({ success: true });
});

// ─── GENERIC WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhooks', async (req, res) => {
  const body = req.body;
  console.log('=== Generic Webhook ===', JSON.stringify(body));

  if (body.type === 'INSTALL' && body.locationId) {
    res.status(200).json({ success: true });
    const { locationId, companyId } = body;
    const companyToken = findCompanyToken(companyId);
    if (!companyToken) { console.error(`No company token for ${companyId}`); return; }

    if (!locationStore[locationId]) {
      locationStore[locationId] = { access_token: companyToken, companyId, locationId };
    }
    locationStore[`company_${locationId}`] = { access_token: companyToken, companyId };
    await saveStore(locationStore);

    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const result = await createProviderConfig(locationId, companyToken);
      locationStore[locationId] = {
        access_token: companyToken, companyId, locationId,
        providerId: result?._id || result?.id,
        installed_at: new Date().toISOString()
      };
      await saveStore(locationStore);
      console.log(`✅ Provider config via generic webhook for ${locationId}`);
    } catch (e) {
      console.error(`Generic webhook install failed:`, JSON.stringify(e?.response?.data || e.message));
    }
    return;
  }

  res.status(200).json({ success: true });
});

// ─── ADMIN REGISTER (temporary — remove after approval) ──────────────────────
app.post('/admin/register', async (req, res) => {
  const { locationId, secret } = req.body;
  if (secret !== 'pp2026') return res.status(401).json({ error: 'unauthorized' });
  const locationToken = locationStore[locationId]?.access_token
    || locationStore['company_oWY1LzuHYhbViH7xCOQl']?.access_token;
  if (!locationToken) return res.status(404).json({ error: 'no token found — reinstall app first' });
  locationStore[locationId] = locationStore[locationId] || { access_token: locationToken, companyId: 'oWY1LzuHYhbViH7xCOQl', locationId };
  locationStore[`company_${locationId}`] = { access_token: locationToken, companyId: 'oWY1LzuHYhbViH7xCOQl' };
  await saveStore(locationStore);
  console.log(`=== ADMIN REGISTER triggered for locationId: ${locationId} ===`);
  try {
    const result = await createProviderConfigWithToken(locationId, locationToken);
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message, status: e?.response?.status });
  }
});

// ─── SETUP PAGE ───────────────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  const { sso_token } = req.query;
  res.send(`<!DOCTYPE html><html><head><title>Patriot Payments Setup</title>
    <style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}
    body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;}
    .card{background:white;border-radius:12px;padding:40px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);}
    .logo{text-align:center;margin-bottom:24px;}
    .logo h1{color:#1B3A6B;font-size:22px;font-weight:700;}
    .logo p{color:#666;font-size:14px;margin-top:4px;}
    label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:6px;margin-top:16px;}
    input{width:100%;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;}
    .btn{display:block;width:100%;padding:14px;background:#1B3A6B;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:24px;}
    .mode-toggle{display:flex;gap:12px;margin-top:16px;}
    .mode-btn{flex:1;padding:10px;border:2px solid #ddd;border-radius:8px;background:white;cursor:pointer;font-size:13px;font-weight:600;color:#666;}
    .mode-btn.active{border-color:#1B3A6B;color:#1B3A6B;background:#f0f4ff;}
    .success{display:none;text-align:center;color:#27ae60;font-weight:600;margin-top:16px;}</style>
    </head><body><div class="card">
    <div class="logo"><h1>🇺🇸 Patriot Payments</h1><p>Connect your merchant account to GoHighLevel</p></div>
    <div class="mode-toggle">
      <button class="mode-btn active" onclick="setMode('test',this)">🧪 Test Mode</button>
      <button class="mode-btn" onclick="setMode('live',this)">🚀 Live Mode</button>
    </div>
    <input type="hidden" id="mode" value="test"/>
    <label>Accept Blue API Key</label>
    <input type="password" id="apiKey" placeholder="Enter your Accept Blue API key"/>
    <label>Accept Blue Source Key / PIN</label>
    <input type="password" id="sourceKey" placeholder="Enter your source key or PIN"/>
    <button class="btn" onclick="saveCredentials()">Connect Patriot Payments</button>
    <div class="success" id="successMsg">✅ Successfully connected! You can close this window.</div>
    </div>
    <script>
    function setMode(mode,btn){document.getElementById('mode').value=mode;document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');}
    async function saveCredentials(){
      const apiKey=document.getElementById('apiKey').value;
      const sourceKey=document.getElementById('sourceKey').value;
      const mode=document.getElementById('mode').value;
      if(!apiKey||!sourceKey){alert('Please enter both keys');return;}
      const res=await fetch('/setup/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey,sourceKey,mode,ssoToken:'${sso_token}'})});
      if(res.ok){document.getElementById('successMsg').style.display='block';}
      else{alert('Error saving. Please try again.');}
    }
    </script></body></html>`);
});

// ─── SAVE CREDENTIALS ─────────────────────────────────────────────────────────
app.post('/setup/save', async (req, res) => {
  const { apiKey, sourceKey, mode, ssoToken } = req.body;
  let locationId = null;
  try {
    if (ssoToken && SSO_KEY) { const d = decryptSSOToken(ssoToken); locationId = d?.activeLocation; }
  } catch (e) { console.error('SSO error:', e.message); }
  if (locationId && locationStore[locationId]) {
    locationStore[locationId].acceptBlueApiKey = apiKey;
    locationStore[locationId].acceptBlueSourceKey = sourceKey;
    locationStore[locationId].mode = mode;
    await saveStore(locationStore);
    console.log(`Credentials saved for ${locationId}`);
  }
  res.json({ success: true });
});

// ─── SSO DECRYPT ──────────────────────────────────────────────────────────────
function decryptSSOToken(token) {
  try {
    const key = crypto.createHash('sha256').update(SSO_KEY).digest();
    const buf = Buffer.from(token, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, buf.slice(0, 16));
    let d = decipher.update(buf.slice(16), undefined, 'utf8');
    d += decipher.final('utf8');
    return JSON.parse(d);
  } catch (e) { console.error('SSO decrypt failed:', e.message); return null; }
}

// ─── GETTING STARTED ──────────────────────────────────────────────────────────
app.get('/getting-started', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Getting Started</title>
    <style>body{font-family:Arial,sans-serif;background:#f5f7fa;padding:24px;}
    .header{background:#1B3A6B;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px;}
    .header h1{color:white;font-size:22px;}.header p{color:#AACCE8;font-size:14px;}
    .step{display:flex;gap:16px;background:white;border-radius:10px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.06);}
    .num{background:#1B3A6B;color:white;font-size:20px;font-weight:700;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    h3{color:#1B3A6B;font-size:16px;margin-bottom:6px;}p{color:#555;font-size:14px;line-height:1.6;}
    .contact{background:#1B3A6B;border-radius:12px;padding:24px;text-align:center;}
    .contact h3{color:white;}.contact p{color:#AACCE8;font-size:14px;margin-bottom:6px;}</style></head>
    <body>
    <div class="header"><h1>🇺🇸 Patriot Payments × GoHighLevel</h1><p>3 simple steps to start accepting payments</p></div>
    <div class="step"><div class="num">1</div><div><h3>Install the App</h3><p>Find Patriot Payments in the GHL Marketplace and click Install.</p></div></div>
    <div class="step"><div class="num">2</div><div><h3>Connect Credentials</h3><p>Enter your Accept Blue API Key and Source Key.</p></div></div>
    <div class="step"><div class="num">3</div><div><h3>Start Processing</h3><p>Patriot Payments appears under Payments > Integrations in your GHL account.</p></div></div>
    <br/><div class="contact"><h3>Need Help?</h3><p>📞 (941) 367-5076</p><p>🌐 patriotspayments.com</p></div>
    </body></html>`);
});

// ─── QUERY URL ────────────────────────────────────────────────────────────────
app.post('/payments/query', (req, res) => {
  const key = req.headers['x-api-key'] || req.body.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { type, transactionId } = req.body;
  console.log(`Query - type: ${type}, transaction: ${transactionId}`);
  switch (type) {
    case 'verify': return res.json({ success: true, status: 'verified', transactionId });
    case 'refund': return res.json({ success: true, status: 'refunded', transactionId });
    default: return res.json({ success: true, type, received: true });
  }
});

// ─── CHECKOUT PAGE ────────────────────────────────────────────────────────────
// GHL loads this in an iframe and does NOT pass the amount via query string.
// Flow per GHL spec: iframe posts 'custom_provider_ready' -> GHL posts back
// 'payment_initiate_props' with the real amount/currency/contact/transactionId ->
// iframe processes the charge -> iframe posts 'custom_element_success_response'
// (or 'custom_element_error_response' / 'custom_element_close_response').
app.get('/payments/checkout', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.send(`<!DOCTYPE html><html><head><title>Patriot Payments Checkout</title>
    <style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}
    body{background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;}
    .card{background:white;border-radius:12px;padding:40px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);}
    h2{color:#1B3A6B;font-size:20px;margin-bottom:8px;}
    .amount{font-size:32px;font-weight:700;color:#1B3A6B;margin-bottom:24px;}
    label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:6px;margin-top:16px;}
    input{width:100%;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;}
    input:disabled{background:#f0f0f0;}
    .row{display:flex;gap:12px;}.row>div{flex:1;}
    .btn{display:block;width:100%;padding:14px;background:#C0392B;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:24px;}
    .btn:disabled{background:#ccc;cursor:not-allowed;}
    .secure{text-align:center;font-size:12px;color:#888;margin-top:12px;}
    .err{color:#C0392B;font-size:13px;margin-top:10px;text-align:center;}</style></head>
    <body><div class="card">
    <h2>🇺🇸 Patriot Payments</h2>
    <div class="amount" id="amountDisplay">Loading…</div>
    <label>Card Number</label><input type="text" id="cn" placeholder="1234 5678 9012 3456" maxlength="19" disabled/>
    <div class="row">
      <div><label>Expiry</label><input type="text" id="exp" placeholder="MM/YY" maxlength="5" disabled/></div>
      <div><label>CVV</label><input type="text" id="cvv" placeholder="123" maxlength="4" disabled/></div>
    </div>
    <label>Name on Card</label><input type="text" id="name" placeholder="Full name" disabled/>
    <label>Billing Address</label><input type="text" id="street" placeholder="123 Main St" disabled/>
    <div class="row">
      <div><label>City</label><input type="text" id="city" placeholder="City" disabled/></div>
      <div><label>State</label><input type="text" id="state" placeholder="AZ" maxlength="2" style="text-transform:uppercase" disabled/></div>
      <div><label>ZIP</label><input type="text" id="zip" placeholder="85234" maxlength="10" disabled/></div>
    </div>
    <button class="btn" id="payBtn" onclick="pay()" disabled>Loading…</button>
    <p class="err" id="errMsg"></p>
    <p style="text-align:center;font-size:10px;color:#bbb;margin-top:8px;word-break:break-all;" id="debugLine"></p>
    <p class="secure">🔒 Secured by Patriot Payments & Accept Blue</p></div>
    <script>
    let paymentProps = null;
    let resolvedFromMessage = false;

    const debugEl = document.getElementById('debugLine');
    function updateDebug(status){
      const inIframe = window.self !== window.top;
      debugEl.textContent = 'v4.6 | ' + status + ' | inIframe=' + inIframe + ' | query="' + window.location.search + '"';
    }
    updateDebug('booting');

    function setInputsEnabled(enabled){
      ['cn','exp','cvv','name','street','city','state','zip','payBtn'].forEach(id=>{
        document.getElementById(id).disabled = !enabled;
      });
    }

    function applyPaymentProps(props){
      paymentProps = props;
      const amt = Number(props.amount || 0).toFixed(2);
      document.getElementById('amountDisplay').textContent = '$' + amt;
      document.getElementById('payBtn').textContent = 'Pay $' + amt;
      setInputsEnabled(true);
    }

    // GHL only sends payment_initiate_props AFTER it sees this ready event —
    // but only when this page is actually embedded in a GHL iframe. GHL's own
    // listener may not be attached the instant our script runs, so a single
    // one-shot postMessage can get missed (race condition). Poll instead:
    // keep re-sending custom_provider_ready until GHL responds, or we give up.
    let readyInterval = setInterval(function(){
      window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
    }, 500);
    window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
    updateDebug('sent custom_provider_ready, waiting');

    window.addEventListener('message', function(event){
      let data = event.data;
      // GHL's own listener expects JSON strings (that's what broke our
      // outgoing messages), so their responses are likely also stringified
      // rather than raw objects. Handle both to be safe.
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return; }
      }
      updateDebug('received message: ' + JSON.stringify(data).slice(0, 80));
      if(!data || !data.type) return;

      if(data.type === 'payment_initiate_props'){
        resolvedFromMessage = true;
        clearInterval(readyInterval);
        applyPaymentProps(data);
        updateDebug('resolved from postMessage');
      }
    });

    // Fallback: if no postMessage arrives after repeated tries (top-level
    // navigation case, or a non-responding parent), fall back to reading
    // params directly from the URL instead of leaving the page stuck on
    // "Loading…" forever.
    setTimeout(function(){
      if (resolvedFromMessage) return;
      clearInterval(readyInterval);
      const params = new URLSearchParams(window.location.search);
      const amount = params.get('amount');
      if (amount) {
        applyPaymentProps({
          amount: amount,
          locationId: params.get('locationId'),
          transactionId: params.get('transactionId') || params.get('invoiceId'),
          orderId: params.get('orderId')
        });
        updateDebug('resolved from URL fallback, amount=' + amount);
      } else {
        document.getElementById('amountDisplay').textContent = 'Unable to load';
        document.getElementById('errMsg').textContent = 'We could not load your payment details. Please reopen this payment link from your invoice, or contact the merchant.';
        updateDebug('fallback fired, no amount in URL either');
      }
    }, 8000);

    async function pay(){
      const errEl = document.getElementById('errMsg');
      errEl.textContent = '';

      if(!paymentProps || !paymentProps.amount){
        errEl.textContent = 'Payment details not received yet. Please wait a moment and try again.';
        return;
      }

      const street = document.getElementById('street').value.trim();
      const zip = document.getElementById('zip').value.trim();
      if(!street || !zip){
        errEl.textContent = 'Billing address and ZIP are required.';
        return;
      }

      setInputsEnabled(false);
      document.getElementById('payBtn').textContent = 'Processing…';

      try {
        const r = await fetch('/payments/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardNumber: document.getElementById('cn').value.replace(/\\s/g, ''),
            expiry: document.getElementById('exp').value,
            cvv: document.getElementById('cvv').value,
            name: document.getElementById('name').value,
            street: street,
            city: document.getElementById('city').value.trim(),
            state: document.getElementById('state').value.trim(),
            zip: zip,
            amount: paymentProps.amount,
            locationId: paymentProps.locationId,
            transactionId: paymentProps.transactionId,
            orderId: paymentProps.orderId
          })
        });
        const d = await r.json();

        if(d.success){
          window.parent.postMessage(JSON.stringify({ type: 'custom_element_success_response', chargeId: d.transactionId }), '*');
        } else {
          errEl.textContent = 'Payment failed: ' + (d.error || 'Please try again.');
          window.parent.postMessage(JSON.stringify({ type: 'custom_element_error_response', error: { description: d.error || 'Payment failed' } }), '*');
          setInputsEnabled(true);
          document.getElementById('payBtn').textContent = 'Pay $' + Number(paymentProps.amount).toFixed(2);
        }
      } catch (e) {
        errEl.textContent = 'Payment failed: ' + e.message;
        window.parent.postMessage(JSON.stringify({ type: 'custom_element_error_response', error: { description: e.message } }), '*');
        setInputsEnabled(true);
        document.getElementById('payBtn').textContent = 'Pay $' + Number(paymentProps.amount).toFixed(2);
      }
    }
    </script></body></html>`);
});

// ─── PROCESS PAYMENT ──────────────────────────────────────────────────────────
app.post('/payments/process', async (req, res) => {
  const { cardNumber, expiry, cvv, name, street, city, state, zip, amount, locationId, transactionId, orderId } = req.body;
  console.log(`Processing charge - amount: ${amount}, locationId: ${locationId}, ghlTransactionId: ${transactionId}, orderId: ${orderId}`);
  try {
    const [m, y] = expiry.split('/');
    const locData = locationStore[locationId] || {};
    const apiKey = locData.acceptBlueApiKey || ACCEPT_BLUE_API_KEY;
    const baseUrl = ACCEPT_BLUE_BASE_URL || 'https://api.accept.blue/api/v2';
    const nameParts = (name || '').trim().split(/\s+/);
    const first_name = nameParts[0] || '';
    const last_name = nameParts.slice(1).join(' ') || first_name;
    const r = await axios.post(
      `${baseUrl}/transactions/charge`,
      {
        amount: parseFloat(amount),
        card: { number: cardNumber, expiry_month: parseInt(m), expiry_year: parseInt('20'+y), cvv2: cvv, name },
        // AVS: matches billing address against the card issuer's records to
        // help qualify the transaction for lower interchange rates and to
        // strengthen chargeback defense (proof the billing address was
        // collected and verified at time of sale).
        billing_info: { first_name, last_name, street, city, state, zip, country: 'US' }
      },
      { headers: { 'Authorization': `Basic ${Buffer.from(apiKey+':').toString('base64')}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, transactionId: r.data.reference_number, status: r.data.status });
  } catch (err) {
    console.error('Payment error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Payment processing failed' });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
(async () => {
  locationStore = await loadStore();
  console.log(`Loaded ${Object.keys(locationStore).length} store entries from Supabase`);

  app.listen(PORT, () => {
    console.log(`Patriot Payments GHL Server v4.6 running on port ${PORT}`);
    console.log(`BASE_URL: ${BASE_URL}`);
    console.log(`APP_ID: ${APP_ID}`);
    console.log(`Store backend: Supabase`);
  });
})();
