const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── CLI args ─────────────────────────────────────────────────────────────────
// Usage: node bot.js --offset 11
// --offset N  : seconds past each minute to run the price check (default: 11)
const args         = process.argv.slice(2);
const offsetFlag   = args.indexOf('--offset');
const SECOND_OFFSET = offsetFlag !== -1 ? parseInt(args[offsetFlag + 1], 10) : 11;

if (isNaN(SECOND_OFFSET) || SECOND_OFFSET < 0 || SECOND_OFFSET > 59) {
  console.error('Invalid --offset value. Must be 0-59.');
  process.exit(1);
}

console.log(`[Config] Price check offset: :${String(SECOND_OFFSET).padStart(2, '0')} past each minute`);

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk/graphql';
const BUY_BELOW     = 0.80;   // buy when priceModifier is below this
const SELL_ABOVE    = 1.20;   // sell when priceModifier is above this
const TOKEN_REFRESH = 20 * 60 * 1000;

const EMAIL    = process.env.WATTO_USER;
const PASSWORD = process.env.WATTO_PASS;

if (!EMAIL || !PASSWORD) {
  console.error('[Bot] Missing WATTO_USER or WATTO_PASS environment variables.');
  console.error('      Run: WATTO_USER=email WATTO_PASS=pass node bot.js [--offset N]');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let token        = null;
let restockTimer = null;
let restockItems = [];  // items to retry buying every 10s

// ─── GQL helper ───────────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  console.log('[Auth] Logging in as', EMAIL);
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation Login($email: String!, $password: String!) {
        login(email: $email, password: $password) { id email token name }
      }`,
      variables: { email: EMAIL, password: PASSWORD },
    }),
  });
  const data = await res.json();
  const t = data?.data?.login?.token;
  if (!t) { console.error('[Auth] Login failed:', JSON.stringify(data?.errors ?? data)); process.exit(1); }
  token = t;
  console.log('[Auth] Logged in as', data.data.login.name);
}

async function refreshBearer() {
  console.log('[Auth] Refreshing token...');
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `refresh_token=${token}` },
    body: JSON.stringify({ query: 'mutation { refreshToken }' }),
  });
  const data = await res.json();
  const newToken = data?.data?.refreshToken;
  if (newToken) { token = newToken; console.log('[Auth] Token refreshed'); }
  else          { console.warn('[Auth] Refresh failed, re-logging in...'); await login(); }
}

// ─── Fetch all shop items with current prices and stock ───────────────────────
async function getShopItems() {
  const data = await gql(`
    query ShopItems {
      items {
        id
        name
        basePrice
        currentPrice
        stock
        maxStock
        type {
          id
          name
          priceModifier
        }
      }
    }
  `);
  return data?.data?.items ?? [];
}

// ─── Buy one item (single unit) ───────────────────────────────────────────────
async function buyOne(itemId, itemName) {
  const data = await gql(
    `mutation BuyItem($itemId: ID!) {
      buyItem(itemId: $itemId) {
        id
        purchasePrice
        item { id stock }
      }
    }`,
    { itemId }
  );

  if (data?.errors || !data?.data?.buyItem) {
    console.log(`    [buy] ${itemName}: ${data?.errors?.[0]?.message ?? 'unknown error'}`);
    return false;
  }

  const { purchasePrice, item } = data.data.buyItem;
  console.log(`    [buy] ${itemName} @ ${purchasePrice} (stock left: ${item.stock})`);
  return true;
}

// ─── Buy all available stock of an item ───────────────────────────────────────
async function buyAllStock(item) {
  const { id, name, stock } = item;
  if (id === "695e6e0d-03b4-4812-94b5-411e88a81a22") {
    continue;
  }
  if (stock === 0) { console.log(`    [buy] ${name}: no stock`); return; }

  console.log(`    [buy] ${name}: buying ${stock} unit(s)`);
  for (let i = 0; i < stock; i++) {
    const ok = await buyOne(id, name);
    if (!ok) break;
  }
}

// ─── Sell all of an item ──────────────────────────────────────────────────────
async function sellUntilEmpty(itemId, itemName) {
  let count = 0;
  while (true) {
    const data = await gql(
      `mutation SellItem($itemId: ID!, $quantity: Int!, $sellTo: SellTarget!) {
        sellItem(itemId: $itemId, quantity: $quantity, sellTo: $sellTo) {
          payout
          soldIds
          newItemStock
          marketListingId
        }
      }`,
      { itemId, quantity: 1, sellTo: 'WATTO' }
    );

    if (data?.errors || !data?.data?.sellItem) {
      const reason = data?.errors?.[0]?.message ?? 'unknown error';
      console.log(`    [sell] ${itemName} stopped after ${count}: ${reason}`);
      break;
    }

    count++;
    const { payout, newItemStock } = data.data.sellItem;
    console.log(`    [sell] ${itemName} #${count} payout: ${payout} (stock left: ${newItemStock})`);
  }
}

// ─── Restock loop: fires every 10s, buys 1 of each watched item ──────────────
function startRestockLoop(items) {
  if (restockTimer) { clearInterval(restockTimer); restockTimer = null; }
  if (!items.length) return;

  console.log(`\n[Restock] Watching ${items.length} item(s) — retrying every 10s`);

  restockTimer = setInterval(async () => {
    for (const item of items) {
      await buyOne(item.id, item.name);
    }
  }, 10 * 1000);
}

// ─── Main price check tick ────────────────────────────────────────────────────
async function tick() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Price check...`);

  let items;
  try {
    items = await getShopItems();
  } catch (err) {
    console.log('  Failed to fetch items:', err.message, '— refreshing token...');
    await refreshBearer();
    return;
  }

  if (!items.length) {
    console.log('  Empty response — refreshing token...');
    await refreshBearer();
    return;
  }

  // Group items by category and their modifier
  const byCategory = {};
  for (const item of items) {
    const cat = item.type.name;
    if (!byCategory[cat]) byCategory[cat] = { modifier: item.type.priceModifier, items: [] };
    byCategory[cat].items.push(item);
  }

  const newRestockItems = [];

  for (const [catName, { modifier, items: catItems }] of Object.entries(byCategory)) {
    const mod = parseFloat(modifier);
    console.log(`\n  ${catName}: priceModifier=${mod}`);

    if (mod < BUY_BELOW) {
      console.log(`    -> BUY all stock (below ${BUY_BELOW})`);
      for (const item of catItems) {
        await buyAllStock(item);
        newRestockItems.push(item);  // watch for restocks
      }
    } else if (mod > SELL_ABOVE) {
      console.log(`    -> SELL all (above ${SELL_ABOVE})`);
      for (const item of catItems) {
        await sellUntilEmpty(item.id, item.name);
      }
    } else {
      console.log(`    -> hold`);
    }
  }

  restockItems = newRestockItems;
  startRestockLoop(restockItems);
}

// ─── Scheduler — runs tick at :NN past each minute ───────────────────────────
function scheduleNextTick() {
  const now     = new Date();
  const seconds = now.getSeconds();
  const ms      = now.getMilliseconds();

  const waitMs = seconds < SECOND_OFFSET
    ? (SECOND_OFFSET - seconds) * 1000 - ms
    : (60 - seconds + SECOND_OFFSET) * 1000 - ms;

  console.log(`[Scheduler] Next price check in ${(waitMs / 1000).toFixed(1)}s (at :${String(SECOND_OFFSET).padStart(2, '0')})`);

  setTimeout(async () => {
    await tick();
    setInterval(tick, 60 * 1000);
  }, waitMs);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await login();
  setInterval(refreshBearer, TOKEN_REFRESH);
  // Run immediately on start, then align to offset
  await tick();
  scheduleNextTick();
}

main().catch(console.error);