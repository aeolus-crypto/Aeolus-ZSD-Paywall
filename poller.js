'use strict';

const jwt = require('jsonwebtoken');
const { getPendingOrders, confirmOrder } = require('./db');
const { getIncomingTransfers }           = require('./wallet');

const REQUIRED_CONFIRMATIONS = parseInt(process.env.REQUIRED_CONFIRMATIONS || '3', 10);
const POLL_INTERVAL_MS       = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);

let timer = null;

async function poll() {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) return;

  const pending = getPendingOrders();
  if (pending.length === 0) return;

  let transfers;
  try { transfers = await getIncomingTransfers(); }
  catch (err) { console.error('[poller] wallet error:', err.message); return; }

  for (const order of pending) {
    const match = transfers.find(t =>
      t.subaddr_index &&
      t.subaddr_index.minor === order.subaddr_index &&
      t.amount >= order.expected_amount &&
      (t.confirmations || 0) >= REQUIRED_CONFIRMATIONS
    );
    if (match) {
      const token = jwt.sign({ orderId: order.id }, JWT_SECRET, { expiresIn: '1h' });
      confirmOrder(order.id, token);
      console.log(`[poller] ✓ confirmed order ${order.id}`);
    }
  }
}

function start() {
  console.log(`[poller] starting — every ${POLL_INTERVAL_MS}ms, need ${REQUIRED_CONFIRMATIONS} confirmations`);
  poll();
  timer = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop };
