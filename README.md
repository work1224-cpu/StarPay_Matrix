# Mutual Fund TER Portal

Express/EJS portal for AMFI mutual-fund TER and NAV data, brokerage and commission management, launch dates, and AMC documents.

## Quick start

```powershell
npm install
npm start
```

Open the URL printed by the server. Development mode uses Nodemon:

```powershell
npm run dev
```

Run tests:

```powershell
npm test
```

## Documentation

See [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md) for setup, configuration, architecture, data flow, roles, API endpoints, persistence, uploads, security, troubleshooting, and the source map.

## Runtime requirements

- Node.js `>=22.5.0`
- npm
- AMFI network access for live refreshes

The default port is `3000`; the server automatically tries subsequent ports when the configured port is busy. Production deployments must set `SESSION_SECRET` and should use HTTPS with a valid certificate.
