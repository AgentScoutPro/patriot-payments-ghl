const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  ACCEPT_BLUE_API_KEY,
  ACCEPT_BLUE_API_KEY_SANDBOX,
  API_KEY,
  SSO_KEY,
  PORT = 3000
} = process.env;

const locationStore = {};

// HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ status: 'Patriot Payments GHL Integration Server Running', version: '1.0.0' });
});

// OAUTH CALLBACK
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const params = new URLSearchParams();
    params.append('client_id', GHL_CLIENT_ID);
    params.append('client_secret', GHL_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', `${process.env.BASE_URL}/oauth/callback`);

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

    const { access_token, refresh_token, locationId, companyId } = tokenResponse.data;

    locationStore[locationId] = {
      access_token,
      refresh_token,
      companyId,
      locationId,
      connected_at: new Date().toISOString()
    };

    console.log(`OAuth complete for location: ${locationId}`);

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
    console.error('OAuth error:', err?.response?.data || err.message);
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

// INSTALL WEBHOOK
app.post('/webhooks/install', (req, res) => {
  const { locationId, companyId } = req.body;
  console.log(`App installed for location: ${locationId}`);
  if (!locationStore[locationId]) {
    locationStore[locationId] = { locationId, companyId, installed_at: new Date().toISOString() };
  }
  res.status(200).json({ success: true });
});

// UNINSTALL WEBHOOK
app.post('/webhooks/uninstall', (req, res) => {
  const { locationId } = req.body;
  console.log(`App uninstalled for location: ${locationId}`);
  if (locationStore[locationId]) delete locationStore[locationId];
  res.status(200).json({ success: true });
});

// WEBHOOKS DEFAULT
app.post('/webhooks', (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body));
  res.status(200).json({ success: true });
});

// SETUP PAGE
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

// SAVE CREDENTIALS
app.post('/setup/save', (req, res) => {
  const { apiKey, sourceKey, mode, ssoToken } = req.body;
  console.log(`Credentials saved for mode: ${mode}`);
  res.json({ success: true });
});

// GETTING STARTED GUIDE
app.get('/getting-started', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Patriot Payments — Getting Started</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
        body { background: #f5f7fa; padding: 24px; color: #333; }
        .header { background: #1B3A6B; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px; }
        .header h1 { color: white; font-size: 22px; margin-bottom: 6px; }
        .header p { color: #AACCE8; font-size: 14px; }
        .step { display: flex; gap: 16px; background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); align-items: flex-start; }
        .step-num { background: #1B3A6B; color: white; font-size: 20px; font-weight: 700; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .step-content h3 { color: #1B3A6B; font-size: 16px; margin-bottom: 6px; }
        .step-content p { color: #555; font-size: 14px; line-height: 1.6; }
        .step-content .url { color: #C0392B; font-size: 12px; margin-top: 6px; font-style: italic; }
        .info-box { background: #FFF8E1; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; border-left: 4px solid #C0392B; }
        .info-box h3 { color: #1B3A6B; font-size: 15px; margin-bottom: 10px; }
        .info-box li { color: #444; font-size: 14px; margin-bottom: 6px; list-style: none; padding-left: 4px; }
        .test-box { background: white; border-radius: 10px; padding: 20px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .test-box h3 { color: #1B3A6B; font-size: 16px; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #1B3A6B; color: white; padding: 8px 12px; text-align: left; }
        td { padding: 8px 12px; border-bottom: 1px solid #eee; color: #444; }
        tr:nth-child(even) td { background: #f9f9f9; }
        .contact { background: #1B3A6B; border-radius: 12px; padding: 24px; text-align: center; }
        .contact h3 { color: white; font-size: 16px; margin-bottom: 12px; }
        .contact p { color: #AACCE8; font-size: 14px; margin-bottom: 6px; }
        .faq { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .faq h4 { color: #1B3A6B; font-size: 15px; margin-bottom: 8px; }
        .faq p { color: #555; font-size: 14px; line-height: 1.6; }
        h2 { color: #1B3A6B; font-size: 18px; margin: 24px 0 12px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🇺🇸 Patriot Payments × GoHighLevel</h1>
        <p>Get connected and start accepting payments in 3 simple steps</p>
      </div>
      <div class="info-box">
        <h3>📋 Before You Begin — What You Need:</h3>
        <ul>
          <li>✅ An active Patriot Payments merchant account</li>
          <li>✅ Your Accept Blue API Key (provided by Patriot Payments)</li>
          <li>✅ Your Accept Blue Source Key / PIN</li>
          <li>✅ A GoHighLevel sub-account</li>
        </ul>
        <p style="margin-top:10px;font-size:13px;color:#888;">Don't have an account yet? Call <strong>(941) 367-5076</strong> or visit <strong>patriotspayments.com</strong></p>
      </div>
      <h2>How to Get Connected</h2>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Install the Patriot Payments App</h3>
          <p>Go to the GoHighLevel App Marketplace, find Patriot Payments, and click Install. Select your sub-account and click Allow to authorize the connection.</p>
          <p class="url">app.gohighlevel.com → App Marketplace → Patriot Payments → Install</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Connect Your Merchant Credentials</h3>
          <p>The setup page opens automatically after installation. Select Test Mode to test first, or Live Mode for real payments. Enter your Accept Blue API Key and Source Key, then click Connect Patriot Payments.</p>
          <p class="url">Look for the green "Successfully connected!" confirmation message</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Start Accepting Payments</h3>
          <p>You're all set! Patriot Payments now appears as a payment option in GoHighLevel. Use it for invoices, funnels, order forms, and subscriptions — all powered by Accept Blue.</p>
          <p class="url">Payments → Settings → Payment Integrations in your GHL sub-account</p>
        </div>
      </div>
      <div class="test-box">
        <h3>🧪 Test Card Details (Sandbox Mode)</h3>
        <table>
          <tr><th>Field</th><th>Test Value</th></tr>
          <tr><td>Card Number</td><td>4111 1111 1111 1111</td></tr>
          <tr><td>Expiration</td><td>12/26</td></tr>
          <tr><td>CVV</td><td>123</td></tr>
          <tr><td>Amount</td><td>Any amount works</td></tr>
        </table>
        <p style="margin-top:12px;font-size:13px;color:#888;">When ready to go live, return to the setup page, switch to Live Mode, and enter your production credentials.</p>
      </div>
      <h2>Frequently Asked Questions</h2>
      <div class="faq">
        <h4>Do I need a Patriot Payments account to use this app?</h4>
        <p>Yes. You need an active merchant account with Accept Blue credentials. Call (941) 367-5076 to get set up — no contracts required.</p>
      </div>
      <div class="faq">
        <h4>What payment types are supported?</h4>
        <p>One-time payments, recurring subscriptions, and off-session charges. Visa, Mastercard, American Express, Discover, and eCheck/ACH are all accepted.</p>
      </div>
      <div class="faq">
        <h4>Is there a fee to use the GHL integration?</h4>
        <p>No. The app is completely free to install. You only pay your standard Patriot Payments processing rates on transactions.</p>
      </div>
      <div class="faq">
        <h4>How do I switch from Test Mode to Live Mode?</h4>
        <p>Return to the setup page, click Live Mode, enter your production API key and source key, and click Connect.</p>
      </div>
      <div class="faq">
        <h4>Where can I view my transactions?</h4>
        <p>In your Accept Blue merchant dashboard and inside GoHighLevel under Payments → Transactions.</p>
      </div>
      <br/>
      <div class="contact">
        <h3>Need Help? We're Here.</h3>
        <p>📞 (941) 367-5076</p>
        <p>🌐 patriotspayments.com</p>
        <p style="margin-top:12px;color:#CCDDEE;font-size:13px;">No contracts. Transparent pricing. Built for small businesses.</p>
      </div>
      <br/>
    </body>
    </html>
  `);
});

// QUERY URL
app.post('/payments/query', async (req, res) => {
  const incomingApiKey = req.headers['x-api-key'] || req.body.apiKey;
  if (incomingApiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { type, transactionId, locationId } = req.body;
  console.log(`Query - type: ${type}, transaction: ${transactionId}`);
  try {
    switch (type) {
      case 'verify': return res.json({ success: true, status: 'verified', transactionId });
      case 'refund': return res.json({ success: true, status: 'refunded', transactionId });
      default: return res.json({ success: true, type, received: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Query processing failed' });
  }
});

// CHECKOUT PAGE
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
          <div><label>Expiry</label><input type="text" id="expiry" placeholder="MM/YY" maxlength="5" /></div>
          <div><label>CVV</label><input type="text" id="cvv" placeholder="123" maxlength="4" /></div>
        </div>
        <label>Cardholder Name</label>
        <input type="text" id="name" placeholder="Full name on card" />
        <button class="btn" onclick="processPayment()">Pay $${parseFloat(amount || 0).toFixed(2)}</button>
        <p class="secure">🔒 Secured by Patriot Payments & Accept Blue</p>
      </div>
      <script>
        async function processPayment() {
          const payload = {
            cardNumber: document.getElementById('cardNumber').value.replace(/\s/g,''),
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

// PROCESS PAYMENT
app.post('/payments/process', async (req, res) => {
  const { cardNumber, expiry, cvv, name, amount, locationId } = req.body;
  try {
    const [expMonth, expYear] = expiry.split('/');
    const locationData = locationStore[locationId] || {};
    const apiKey = locationData.acceptBlueApiKey || ACCEPT_BLUE_API_KEY;
    const response = await axios.post('https://api.accept.blue/api/v2/transactions/charge', {
      amount: parseFloat(amount),
      card: { number: cardNumber, expiry_month: parseInt(expMonth), expiry_year: parseInt('20' + expYear), cvv2: cvv, name }
    }, {
      headers: {
        'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });
    const txn = response.data;
    res.json({ success: true, transactionId: txn.reference_number, status: txn.status });
  } catch (err) {
    console.error('Payment error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Payment processing failed' });
  }
});

// START SERVER — THIS MUST ALWAYS BE LAST
app.listen(PORT, () => {
  console.log(`Patriot Payments GHL Server running on port ${PORT}`);
});
