const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GO_BACKEND = process.env.GO_BACKEND || 'https://localhost:9443';

// serve static UI
app.use(express.static(path.join(__dirname, 'static')));

// proxy API calls to Go backend (preserves SSE)
app.use('/api', createProxyMiddleware({
  target: GO_BACKEND,
  changeOrigin: true,
  secure: false,
  proxyTimeout: 60000,
  onProxyReq: (proxyReq, req, res) => {
    // no-op
  }
}));

// proxy sse endpoints as well
app.use('/sse', createProxyMiddleware({
  target: GO_BACKEND,
  changeOrigin: true,
  secure: false,
  ws: false,
  proxyTimeout: 0,
}));

const certDir = path.join(__dirname, '..', 'certs');
const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');

// allow forcing HTTP (useful for local Playwright tests that cannot trust self-signed certs)
if (process.env.FORCE_HTTP === '1') {
  app.listen(PORT, () => console.log(`Frontend HTTP server listening on http://localhost:${PORT} (FORCED)`));
} else if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`Frontend HTTPS server listening on https://localhost:${PORT}`);
    console.log(`Proxying API/SSE to ${GO_BACKEND}`);
  });
} else {
  app.listen(PORT, () => console.log(`Frontend HTTP server listening on http://localhost:${PORT}`));
}
