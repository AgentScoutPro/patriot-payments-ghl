const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────
// ENV VARIABLES (set in Render dashboard)
// ─────────────────────────────────────────
const {
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  ACCEPT_BLUE_API_KEY,
  ACCEPT_BLUE_API_KEY_SANDBOX,
  API_KEY,           // Your own secret key to verify GHL→your server requests
  SSO_KEY,           // From GHL Marketplace app settings
  PORT = 3000
} = process.env;

// ─────────────────────────────────────────
// IN-MEMORY STORE (replace with DB later)
// ─────────────────────────────────────────
const locationStore = {};

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Patriot Payments GHL Integration Server Running', version: '1.0.0' });
});

// ─────────────────────────────────────────
// OAUTH CALLBACK
// Called by GHL after a user installs the app
// ─────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://services.leadconnectorhq.com/oauth/token', {
      client_id: GHL_CLIENT_ID,
      client_secret: GHL_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${process.env.BASE_URL}/oauth/callback`
    });

    const { access_token, refresh_token, locationId, companyId } = tokenResponse.data;

    // Store the token for this location
    locationStore[locationId] = {
      access_token,
      refresh_token,
      companyId,
      locationId,
      connected_at: new Date().toISOString()
    };

    console.log(`✅ OAuth complete for location: ${locationId}`);

    // Redirect to success page
    res.redirect(`https://app.gohighlevel.com/`);

  } catch (err) {
    console.error('OAuth error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'OAuth token exchange failed' });
  }
});

// ─────────────────────────────────────────
// INSTALL WEBHOOK
// Called by GHL when app is installed
// ─────────────────────────────────────────
app.post('/webhooks/install', (req, res) => {
  const { locationId, companyId } = req.body;
  console.log(`📦 App installed for location: ${locationId}`);

  if (!locationStore[locationId]) {
    locationStore[locationId] = {
      locationId,
      companyId,
      installed_at: new Date().toISOString()
    };
  }

  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────
// UNINSTALL WEBHOOK
// Called by GHL when app is uninstalled
// ─────────────────────────────────────────
app.post('/webhooks/uninstall', (req, res) => {
  const { locationId } = req.body;
  console.log(`🗑️ App uninstalled for location: ${locationId}`);

  if (locationStore[locationId]) {
    delete locationStore[locationId];
  }

  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────
// SETUP PAGE (loaded in GHL iframe)
// Where merchants enter their credentials
// ─────────────────────────────────────────
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
        input, select { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
        input:focus, select:focus { outline: none; border-color: #1B3A6B; }
        .btn { display: block; width: 100%; padding: 14px; background: #1B3A6B; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 24px; }
        .btn:hover { background: #C0392B; }
        .mode-toggle { display: flex; gap: 12px; margin-top: 16px; }
        .mode-btn { flex: 1; padding: 10px; border: 2px solid #ddd; border-radius: 8px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; color: #666; }
        .mode-btn.active { border-color: #1B3A6B; color: #1B3A6B; background: #f0f4ff; }
        .success { display: none; text-align: center; color: #27ae60; font-weight: 600; margin-top: 16px; }
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

        <label>Accept Blue Source Key</label>
        <input type="password" id="sourceKey" placeholder="Enter your source key" />

        <button class="btn" onclick="saveCredentials()">Connect Patriot Payments</button>
        <div class="success" id="successMsg">✅ Successfully connected!</div>
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

// ─────────────────────────────────────────
// SAVE MERCHANT CREDENTIALS
// ─────────────────────────────────────────
app.post('/setup/save', (req, res) => {
  const { apiKey, sourceKey, mode, ssoToken } = req.body;

  // In production: decrypt SSO token to get locationId, store credentials securely
  console.log(`💾 Credentials saved for mode: ${mode}`);

  res.json({ success: true });
});

// ─────────────────────────────────────────
// QUERY URL ENDPOINT
// GHL calls this for payment verification & refunds
// ─────────────────────────────────────────
app.post('/payments/query', async (req, res) => {
  const incomingApiKey = req.headers['x-api-key'] || req.body.apiKey;

  // Verify the request is from GHL
  if (incomingApiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, transactionId, locationId } = req.body;

  console.log(`🔍 Query request - type: ${type}, transaction: ${transactionId}`);

  try {
    // Handle different query types
    switch (type) {
      case 'verify':
        return res.json({ success: true, status: 'verified', transactionId });

      case 'refund':
        // Call Accept Blue refund API here
        return res.json({ success: true, status: 'refunded', transactionId });

      default:
        return res.json({ success: true, type, received: true });
    }
  } catch (err) {
    console.error('Query error:', err.message);
    res.status(500).json({ error: 'Query processing failed' });
  }
});

// ─────────────────────────────────────────
// PAYMENTS CHECKOUT PAGE (loaded in GHL iframe)
// ─────────────────────────────────────────
app.get('/payments/checkout', (req, res) => {
  const { amount, locationId, invoiceId } = req.query;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Patriot Payments Checkout</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
        body { background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: white; border-radius: 12px; padding: 40px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
        h2 { color: #1B3A6B; font-size: 20px; margin-bottom: 8px; }
        .amount { font-size: 32px; font-weight: 700; color: #1B3A6B; margin-bottom: 24px; }
        label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 6px; margin-top: 16px; }
        input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
        .row { display: flex; gap: 12px; }
        .row > div { flex: 1; }
        .btn { display: block; width: 100%; padding: 14px; background: #C0392B; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 24px; }
        .btn:hover { background: #1B3A6B; }
        .secure { text-align: center; font-size: 12px; color: #888; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🇺🇸 Patriot Payments</h2>
        <div class="amount">$${parseFloat(amount || 0).toFixed(2)}</div>

        <label>Card Number</label>
        <input type="text" id="cardNumber" placeholder="1234 5678 9012 3456" maxlength="19" />

        <div class="row">
          <div>
            <label>Expiry</label>
            <input type="text" id="expiry" placeholder="MM/YY" maxlength="5" />
          </div>
          <div>
            <label>CVV</label>
            <input type="text" id="cvv" placeholder="123" maxlength="4" />
          </div>
        </div>

        <label>Cardholder Name</label>
        <input type="text" id="name" placeholder="Full name on card" />

        <button class="btn" onclick="processPayment()">Pay $${parseFloat(amount || 0).toFixed(2)}</button>
        <p class="secure">🔒 Secured by Patriot Payments & Accept Blue</p>
      </div>

      <script>
        async function processPayment() {
          const payload = {
            cardNumber: document.getElementById('cardNumber').value.replace(/\s/g, ''),
            expiry: document.getElementById('expiry').value,
            cvv: document.getElementById('cvv').value,
            name: document.getElementById('name').value,
            amount: '${amount}',
            locationId: '${locationId}',
            invoiceId: '${invoiceId}'
          };

          const res = await fetch('/payments/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const data = await res.json();
          if (data.success) {
            window.parent.postMessage({ type: 'payment_success', transactionId: data.transactionId }, '*');
          } else {
            alert('Payment failed: ' + data.error);
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ─────────────────────────────────────────
// PROCESS PAYMENT
// Calls Accept Blue API to charge the card
// ─────────────────────────────────────────
app.post('/payments/process', async (req, res) => {
  const { cardNumber, expiry, cvv, name, amount, locationId } = req.body;

  try {
    const [expMonth, expYear] = expiry.split('/');
    const locationData = locationStore[locationId] || {};
    const apiKey = locationData.acceptBlueApiKey || ACCEPT_BLUE_API_KEY;

    // Call Accept Blue API
    const response = await axios.post('https://api.accept.blue/api/v2/transactions/charge', {
      amount: parseFloat(amount),
      card: {
        number: cardNumber,
        expiry_month: parseInt(expMonth),
        expiry_year: parseInt('20' + expYear),
        cvv2: cvv,
        name
      }
    }, {
      headers: {
        'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    const txn = response.data;
    console.log(`💳 Payment processed: ${txn.reference_number}`);

    res.json({ success: true, transactionId: txn.reference_number, status: txn.status });

  } catch (err) {
    console.error('Payment error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Payment processing failed' });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Patriot Payments GHL Server running on port ${PORT}`);
});
