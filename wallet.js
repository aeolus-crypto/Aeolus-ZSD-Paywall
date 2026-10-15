'use strict';

const fetch = require('node-fetch');

function getRpcUrl() {
  return process.env.WALLET_RPC_URL || 'http://127.0.0.1:17777/json_rpc';
}

async function rpc(method, params = {}) {
  const res = await fetch(getRpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

async function createAddress(label = '') {
  const result = await rpc('create_address', { account_index: 0, label });
  return { address: result.address, address_index: result.address_index };
}

async function getIncomingTransfers() {
  try {
    const result = await rpc('get_transfers', { in: true, pending: true, account_index: 0 });
    const transfers = (result.in || []).concat(result.pending || []);
    return transfers.filter(t => t.asset_type === 'ZSD');
  } catch { return []; }
}

async function testConnection() {
  try {
    await rpc('get_balance', { account_index: 0, asset_type: 'ZSD' });
    return true;
  } catch { return false; }
}

module.exports = { createAddress, getIncomingTransfers, testConnection };
