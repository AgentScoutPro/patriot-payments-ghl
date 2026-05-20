const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
  PORT = 3000
} = process.env;

const BASE_URL = (process.env.BASE_URL || 'https://patriot-payments-ghl.onrender.com').replace(/\/$/, '');

// ─── PERSISTENT LOCATION STORE ────────────────────────────────────────────────
const STORE_PATH = path.join('/tmp', 'location_store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
  }
  return {};
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to save store:', e.message);
  }
}

let locationStore = loadStore();

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Patriot Payments GHL Integration Server Running',
    version: '2.2.0',
    locations_connected: Object.keys(locationStore).length,
    base_url: BASE_URL
  });
});

// ─── OAUTH CALLBACK ───────────────────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  const redirectUri = `${BASE_URL}/oauth/callback`;
  console.log('=== OAuth callback received ===');
  console.log('code: present');
  console.log('redirect_uri:', redirectUri);
  console.log('client_id:', GHL_CLIENT_ID);

  try {
    const params = new URLSearchParams();
    params.append('client_id', GHL_CLIENT_ID);
    params.append('client_secret', GHL_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', redirectUri);

    console.log('Sending token exchange...');

    const tokenResponse = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    // LOG FULL RESPONSE — this shows us exactly what GHL sends back
    console.log('=== FULL TOKEN RESPONSE ===');
    console.log(JSON.stringify(tokenResponse.data, null, 2));
    console.log('===========================');

    const access_token = tokenResponse.data.access_token;
    const refresh_token = tokenResponse.data.refresh_token;
    const companyId = tokenResponse.data.companyId;

    // Extract locationId — try every possible field GHL might use
    const locationId =
      tokenResponse.data.locationId ||
      tokenResponse.data.location_id ||
      tokenResponse.data.installedLocations?.[0] ||
      tokenResponse.data.resourceOwnerId ||
      null;

    console.log('Extracted locationId:', locationId);
    console.log('companyId:', companyId);
    console.log('userType:', tokenResponse.data.userType);

    if (!locationId) {
      console.error('WARNING: locationId is null/undefined — provider config will fail');
    }

    // Store tokens using locationId OR companyId as fallback key
    const storeKey = locationId || companyId || 'unknown';
    locationStore[storeKey] = {
      access_token,
      refresh_token,
      companyId,
      locationId,
      connected_at: new Date().toISOString()
    };
    saveStore(locationStore);
    console.log('Tokens stored under key:', storeKey);

    // Create provider config
    try {
      const providerResult = await createProviderConfig(locationId, companyId, access_token);
      console.log('Provider config SUCCESS:', JSON.stringify(providerResult));
    } catch (providerErr) {
      const errDetail = providerErr?.response?.data || providerErr.message;
      console.error('Provider config FAILED:', JSON.stringify(errDetail));
      console.error('Provider error status:', providerErr?.response?.status);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Patriot Payments Connected</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
          body { background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
          .card { background: white; border-radius: 12px; padding: 48px 40px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 420px; width: 90%; }
          .check { font-size: 64px; margin-bottom: 16px; }
          h1 { color: #1B3A6B; font-size: 24px; margin-bottom: 12px; }
          p { color: #555; font-size: 15px; line-height: 1.6; }
          .btn { display: inline-block; margin-top: 24px; padding: 12px 28px; background: #1B3A6B; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="check">✅</div>
          <h1>Patriot Payments Connected!</h1>
          <p>Your GoHighLevel account has been successfully connected to Patriot Payments. You can now process payments through your account.</p>
          <a class="btn" href="https://app.gohighlevel.com">Return to GoHighLevel</a>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    const errData = err?.response?.data || err.message;
    console.error('=== OAuth FAILED ===');
    console.error(JSON.stringify(errData));
    console.error('Status:', err?.response?.status);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connection Error</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
          body { background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
          .card { background: white; border-radius: 12px; padding: 48px 40px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 420px; width: 90%; }
          h1 { color: #C0392B; font-size: 24px; margin-bottom: 12px; }
          p { color: #555; font-size: 14px; }
          .err { background: #fff5f5; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 12px; color: #C0392B; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Connection Error</h1>
          <p>There was an issue connecting your account. Please try again or contact support.</p>
          <div class="err">${err?.response?.data?.message || err.message}</div>
          <p style="margin-top:16px;font-size:13px;">Support: patriotspayments.com | (941) 367-5076</p>
        </div>
      </body>
      </html>
    `);
  }
});

// ─── CREATE PROVIDER CONFIG ───────────────────────────────────────────────────
async function createProviderConfig(locationId, companyId, accessToken) {
  const providerPayload = {
    name: 'Patriot Payments',
    description: 'Accept credit cards, debit cards, and ACH payments powered by Accept Blue. No contracts. Transparent pricing.',
    paymentsUrl: `${BASE_URL}/payments/checkout`,
    queryUrl: `${BASE_URL}/payments/query`,
    imageUrl: 'https://patriot-payments-ghl.onrender.com/assets/patriot-logo.png',
    liveMode: {
      apiKey: API_KEY
    },
    testMode: {
      apiKey: API_KEY
    }
  };

  // GHL requires locationId in the URL for location-scoped tokens
  // Fall back to company-level endpoint if no locationId
  const endpoint = locationId
    ? `https://services.leadconnectorhq.com/payments/custom-provider/provider?locationId=${locationId}`
    : `https://services.leadconnectorhq.com/payments/custom-provider/provider`;

  console.log('Provider config endpoint:', endpoint);
  console.log('Provider payload:', JSON.stringify(providerPayload));

  const response = await axios.post(endpoint, providerPayload, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });

  if (locationStore[locationId || companyId]) {
    locationStore[locationId || companyId].providerId = response.data?.id || response.data?._id;
    saveStore(locationStore);
  }

  return response.data;
}

// ─── INSTALL WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhooks/install', (req, res) => {
  const { locationId, companyId } = req.body;
  console.log(`App installed for location: ${locationId}`);
  if (!locationStore[locationId]) {
    locationStore[locationId] = { locationId, companyId, installed_at: new Date().toISOString() };
    saveStore(locationStore);
  }
  res.status(200).json({ success: true });
});

// ─── UNINSTALL WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhooks/uninstall', (req, res) => {
  const { locationId } = req.body;
  console.log(`App uninstalled for location: ${locationId}`);
  if (locationStore[locationId]) {
    delete locationStore[locationId];
    saveStore(locationStore);
  }
  res.status(200).json({ success: true });
});

app.post('/webhooks', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body));
  res.status(200).json({ success: true });
});

// ─── SETUP PAGE ───────────────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  const { sso_token } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Patriot Payments Setup</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
        body { background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
        .logo { text-align: center; margin-bottom: 24px; }
        .logo h1 { color: #1B3A6B; font-size: 22px; font-weight: 700; }
        .logo p { color: #666; font-size: 14px; margin-top: 4px; }
        label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 6px; margin-top: 16px; }
        input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
        input:focus { outline: none; border-color: #1B3A6B; }
        .btn { display: block; width: 100%; padding: 14px; background: #1B3A6B; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 24px; }
        .btn:hover { background: #C0392B; }
        .mode-toggle { display: flex; gap: 12px; margin-top: 16px; }
        .mode-btn { flex: 1; padding: 10px; border: 2px solid #ddd; border-radius: 8px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; color: #666; }
        .mode-btn.active { border-color: #1B3A6B; color: #1B3A6B; background: #f0f4ff; }
        .success { display: none; text-align: center; color: #27ae60; font-weight: 600; margin-top: 16px; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">
          <h1>🇺🇸 Patriot Payments</h1>
          <p>Connect your merchant account to GoHighLevel</p>
        </div>
        <div class="mode-toggle">
          <button class="mode-btn active" onclick="setMode('test', this)">🧪 Test Mode</button>
          <button class="mode-btn" onclick="setMode('live', this)">🚀 Live Mode</button>
        </div>
        <input type="hidden" id="mode" value="test" />
        <label>Accept Blue API Key</label>
        <input type="password" id="apiKey" placeholder="Enter your Accept Blue API key" />
        <label>Accept Blue Source Key / PIN</label>
        <input type="password" id="sourceKey" placeholder="Enter your source key or PIN" />
        <button class="btn" onclick="saveCredentials()">Connect Patriot Payments</button>
        <div class="success" id="successMsg">✅ Successfully connected! You can close this window.</div>
      </div>
      <script>
        function setMode(mode, btn) {
          document.getElementById('mode').value = mode;
          document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
        async function saveCredentials() {
          const apiKey = document.getElementById('apiKey').value;
          const sourceKey = document.getElementById('sourceKey').value;
          const mode = document.getElementById('mode').value;
          const ssoToken = '${sso_token}';
          if (!apiKey || !sourceKey) {
            alert('Please enter both your API Key and Source Key');
            return;
          }
          const res = await fetch('/setup/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, sourceKey, mode, ssoToken })
          });
          if (res.ok) {
            document.getElementById('successMsg').style.display = 'block';
          } else {
            alert('Error saving credentials. Please try again.');
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/setup/save', (req, res) => {
  const { apiKey, sourceKey, mode, ssoToken } = req.body;
  let locationId = null;
  try {
    if (ssoToken && SSO_KEY) {
      const decrypted = decryptSSOToken(ssoToken);
      locationId = decrypted?.activeLocation;
    }
  } catch (e) {
    console.error('SSO decrypt error:', e.message);
  }
  if (locationId && locationStore[locationId]) {
    locationStore[locationId].acceptBlueApiKey = apiKey;
    locationStore[locationId].acceptBlueSourceKey = sourceKey;
    locationStore[locationId].mode = mode;
    saveStore(locationStore);
    console.log(`Credentials saved for location: ${locationId}, mode: ${mode}`);
  } else {
    console.log(`Credentials saved (no location context), mode: ${mode}`);
  }
  res.json({ success: true });
});

function decryptSSOToken(token) {
  try {
    const key = crypto.createHash('sha256').update(SSO_KEY).digest();
    const encryptedBuffer = Buffer.from(token, 'base64');
    const iv = encryptedBuffer.slice(0, 16);
    const encrypted = encryptedBuffer.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (e) {
    console.error('SSO decrypt failed:', e.message);
    return null;
  }
}

app.get('/getting-started', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Patriot Payments — Getting Started</title>
    <style>* { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
    body { background: #f5f7fa; padding: 24px; color: #333; }
    .header { background: #1B3A6B; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px; }
    .header h1 { color: white; font-size: 22px; margin-bottom: 6px; }
    .header p { color: #AACCE8; font-size: 14px; }
    .step { display: flex; gap: 16px; background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); align-items: flex-start; }
    .step-num { background: #1B3A6B; color: white; font-size: 20px; font-weight: 700; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .step-content h3 { color: #1B3A6B; font-size: 16px; margin-bottom: 6px; }
    .step-content p { color: #555; font-size: 14px; line-height: 1.6; }
    .contact { background: #1B3A6B; border-radius: 12px; padding: 24px; text-align: center; }
    .contact h3 { color: white; font-size: 16px; margin-bottom: 12px; }
    .contact p { color: #AACCE8; font-size: 14px; margin-bottom: 6px; }</style></head>
    <body>
    <div class="header"><h1>🇺🇸 Patriot Payments × GoHighLevel</h1><p>Get connected and start accepting payments in 3 simple steps</p></div>
    <div class="step"><div class="step-num">1</div><div class="step-content"><h3>Install the Patriot Payments App</h3><p>Go to the GoHighLevel App Marketplace, find Patriot Payments, and click Install.</p></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-content"><h3>Connect Your Merchant Credentials</h3><p>Enter your Accept Blue API Key and Source Key. Select Test or Live mode.</p></div></div>
    <div class="step"><div class="step-num">3</div><div class="step-content"><h3>Start Accepting Payments</h3><p>Patriot Payments now appears under Payments > Integrations in your GHL account.</p></div></div>
    <br/><div class="contact"><h3>Need Help?</h3><p>📞 (941) 367-5076</p><p>🌐 patriotspayments.com</p></div>
    </body></html>`);
});

app.post('/payments/query', async (req, res) => {
  const incomingApiKey = req.headers['x-api-key'] || req.body.apiKey;
  if (incomingApiKey !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { type, transactionId } = req.body;
  console.log(`Query - type: ${type}, transaction: ${transactionId}`);
  switch (type) {
    case 'verify': return res.json({ success: true, status: 'verified', transactionId });
    case 'refund': return res.json({ success: true, status: 'refunded', transactionId });
    default: return res.json({ success: true, type, received: true });
  }
});

app.get('/payments/checkout', (req, res) => {
  const { amount, locationId, invoiceId } = req.query;
  res.send(`<!DOCTYPE html><html><head><title>Patriot Payments Checkout</title>
    <style>* { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
    body { background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    h2 { color: #1B3A6B; font-size: 20px; margin-bottom: 8px; }
    .amount { font-size: 32px; font-weight: 700; color: #1B3A6B; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 6px; margin-top: 16px; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .row { display: flex; gap: 12px; } .row > div { flex: 1; }
    .btn { display: block; width: 100%; padding: 14px; background: #C0392B; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 24px; }
    .secure { text-align: center; font-size: 12px; color: #888; margin-top: 12px; }</style></head>
    <body><div class="card">
    <h2>🇺🇸 Patriot Payments</h2>
    <div class="amount">$${parseFloat(amount || 0).toFixed(2)}</div>
    <label>Card Number</label><input type="text" id="cardNumber" placeholder="1234 5678 9012 3456" maxlength="19" />
    <div class="row"><div><label>Expiry</label><input type="text" id="expiry" placeholder="MM/YY" maxlength="5" /></div>
    <div><label>CVV</label><input type="text" id="cvv" placeholder="123" maxlength="4" /></div></div>
    <label>Cardholder Name</label><input type="text" id="name" placeholder="Full name on card" />
    <button class="btn" onclick="processPayment()">Pay $${parseFloat(amount || 0).toFixed(2)}</button>
    <p class="secure">🔒 Secured by Patriot Payments & Accept Blue</p></div>
    <script>
    async function processPayment() {
      const payload = { cardNumber: document.getElementById('cardNumber').value.replace(/\s/g,''),
        expiry: document.getElementById('expiry').value, cvv: document.getElementById('cvv').value,
        name: document.getElementById('name').value, amount: '${amount}',
        locationId: '${locationId}', invoiceId: '${invoiceId}' };
      const res = await fetch('/payments/process', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data.success) { window.parent.postMessage({ type: 'payment_success', transactionId: data.transactionId }, '*'); }
      else { alert('Payment failed: ' + data.error); }
    }</script></body></html>`);
});

app.post('/payments/process', async (req, res) => {
  const { cardNumber, expiry, cvv, name, amount, locationId } = req.body;
  try {
    const [expMonth, expYear] = expiry.split('/');
    const locationData = locationStore[locationId] || {};
    const apiKey = locationData.acceptBlueApiKey || ACCEPT_BLUE_API_KEY;
    const baseUrl = ACCEPT_BLUE_BASE_URL || 'https://api.accept.blue/api/v2';
    const response = await axios.post(`${baseUrl}/transactions/charge`, {
      amount: parseFloat(amount),
      card: { number: cardNumber, expiry_month: parseInt(expMonth), expiry_year: parseInt('20' + expYear), cvv2: cvv, name }
    }, { headers: { 'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`, 'Content-Type': 'application/json' } });
    const txn = response.data;
    res.json({ success: true, transactionId: txn.reference_number, status: txn.status });
  } catch (err) {
    console.error('Payment error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Payment processing failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Patriot Payments GHL Server v2.2 running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
