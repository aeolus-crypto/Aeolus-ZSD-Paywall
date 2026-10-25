'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

const PORT          = parseInt(process.env.PORT || '3000', 10);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const VIEWS         = path.join(__dirname, 'views');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function render(res, tpl, vars = {}) {
  fs.readFile(path.join(VIEWS, tpl + '.html'), 'utf8', (err, content) => {
    if (err) return res.status(500).send('Template error: ' + tpl);
    const html = content.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      vars[k] !== undefined ? String(vars[k]) : ''
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

app.use((req, res, next) => { res.render = (t, v) => render(res, t, v); next(); });

function isConfigured() {
  return !!(
    process.env.PRODUCT_NAME &&
    process.env.PRODUCT_FILE &&
    process.env.PRODUCT_PRICE_ZSD &&
    process.env.JWT_SECRET
  );
}

app.get('/setup', (req, res) => {
  res.render('setup', { errorBlock: '' });
});

app.post('/setup', async (req, res) => {
  const { product_name, product_desc, product_file, product_price, wallet_rpc } = req.body;

  if (!product_name || !product_file || !product_price) {
    const errorBlock = `<div class="error">Product name, file, and price are required.</div>`;
    return res.render('setup', { errorBlock });
  }

  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const rpcUrl    = wallet_rpc || 'http://127.0.0.1:17777/json_rpc';

  const envContent = [
    `PRODUCT_NAME=${product_name}`,
    `PRODUCT_DESC=${product_desc || ''}`,
    `PRODUCT_FILE=${product_file}`,
    `PRODUCT_PRICE_ZSD=${product_price}`,
    `WALLET_RPC_URL=${rpcUrl}`,
    `JWT_SECRET=${jwtSecret}`,
    `REQUIRED_CONFIRMATIONS=3`,
    `POLL_INTERVAL_MS=30000`,
    `PORT=${PORT}`,
  ].join('\n');

  fs.writeFileSync(ENV_PATH, envContent);

  require('dotenv').config({ path: ENV_PATH, override: true });

  const poller = require('./poller');
  poller.start();

  res.redirect('/');
});

app.get('/api/test-wallet', async (req, res) => {
  try {
    const { rpcUrl } = req.query;
    if (rpcUrl) process.env.WALLET_RPC_URL = rpcUrl;
    const { testConnection } = require('./wallet');
    const ok = await testConnection();
    res.json({ ok });
  } catch { res.json({ ok: false }); }
});

app.use((req, res, next) => {
  if (!isConfigured() && !req.path.startsWith('/setup') && !req.path.startsWith('/api')) {
    return res.redirect('/setup');
  }
  next();
});

function getDb() { return require('./db'); }

app.get('/', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');

  const price = parseFloat(process.env.PRODUCT_PRICE_ZSD || '0');
  res.render('index', {
    productName: esc(process.env.PRODUCT_NAME || ''),
    productDesc: esc(process.env.PRODUCT_DESC || ''),
    priceZsd:    price.toFixed(2),
  });
});

app.post('/pay', async (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');

  const { createAddress } = require('./wallet');
  const { createOrder }   = getDb();
  const price = Math.round(parseFloat(process.env.PRODUCT_PRICE_ZSD) * 1e12);

  let address, address_index;
  try {
    ({ address, address_index } = await createAddress(`order-${uuidv4()}`));
  } catch (err) {
    console.error('[server] createAddress failed:', err.message);
    return res.render('error', { message: 'Wallet unavailable — make sure wallet RPC is running.' });
  }

  const orderId = uuidv4();
  createOrder({ id: orderId, subaddress: address, subaddr_index: address_index, expected_amount: price });
  res.redirect(`/order/${orderId}`);
});

app.get('/order/:orderId', (req, res) => {
  const { getOrder } = getDb();
  const order = getOrder(req.params.orderId);
  if (!order) return res.render('error', { message: 'Order not found.' });

  res.render('payment', {
    orderId:     order.id,
    productName: esc(process.env.PRODUCT_NAME || ''),
    subaddress:  order.subaddress,
    zsdAmount:   (order.expected_amount / 1e12).toFixed(2),
  });
});

app.get('/api/order/:orderId/status', (req, res) => {
  const { getOrder } = getDb();
  const order = getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    status:         order.status,
    download_token: order.status === 'confirmed' ? order.download_token : null,
  });
});

app.get('/download', (req, res) => {
  const { token } = req.query;
  if (!token) return res.render('error', { message: 'Missing download token.' });

  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.render('error', { message: 'Download link is invalid or expired.' }); }

  const { getOrderByToken, markTokenUsed } = getDb();
  const order = getOrderByToken(token);
  if (!order)           return res.render('error', { message: 'Order not found.' });
  if (order.token_used) return res.render('error', { message: 'This download link has already been used.' });
  if (order.status !== 'confirmed') return res.render('error', { message: 'Payment not confirmed.' });

  const filename = process.env.PRODUCT_FILE;
  const filePath = path.resolve(DOWNLOADS_DIR, path.basename(filename));
  if (!filePath.startsWith(DOWNLOADS_DIR))
    return res.render('error', { message: 'Invalid file path.' });
  if (!fs.existsSync(filePath))
    return res.render('error', { message: 'File not found on server — contact support.' });

  markTokenUsed(order.id);
  res.download(filePath, filename, err => {
    if (err) console.error('[server] download error:', err.message);
  });
});

app.listen(PORT, () => {
  console.log(`\n  ZSD Paywall → http://localhost:${PORT}\n`);
  if (!isConfigured()) {
    console.log('  ⚠  Not configured yet.');
    console.log(`  → Open http://localhost:${PORT}/setup to get started\n`);
  } else {
    const poller = require('./poller');
    poller.start();
  }
});

process.on('SIGTERM', () => { try { require('./poller').stop(); } catch {} process.exit(0); });
process.on('SIGINT',  () => { try { require('./poller').stop(); } catch {} process.exit(0); });
