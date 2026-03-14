# Patriot Payments × GoHighLevel Integration

Backend server for the Patriot Payments GHL Marketplace app.

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Health check |
| `/oauth/callback` | GET | OAuth redirect handler |
| `/webhooks/install` | POST | GHL install webhook |
| `/webhooks/uninstall` | POST | GHL uninstall webhook |
| `/setup` | GET | Merchant setup iframe page |
| `/setup/save` | POST | Save merchant credentials |
| `/payments/query` | POST | GHL queryUrl endpoint |
| `/payments/checkout` | GET | Checkout iframe page |
| `/payments/process` | POST | Process payment via Accept Blue |

## Environment Variables (set in Render)

- `GHL_CLIENT_ID` - From GHL Marketplace app settings
- `GHL_CLIENT_SECRET` - From GHL Marketplace app settings
- `ACCEPT_BLUE_API_KEY` - Production API key
- `ACCEPT_BLUE_API_KEY_SANDBOX` - Sandbox API key
- `API_KEY` - Your secret key for GHL→server verification
- `SSO_KEY` - From GHL Marketplace app settings
- `BASE_URL` - Your Render deployment URL

## Built by C0D3.AI for Patriot Payments
