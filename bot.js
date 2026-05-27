const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── CLI args ─────────────────────────────────────────────────────────────────
// Usage: node bot.js --offset 11
const args          = process.argv.slice(2);
const offsetFlag    = args.indexOf('--offset');
const SECOND_OFFSET = offsetFlag !== -1 ? parseInt(args[offsetFlag + 1], 10) : 11;

if (isNaN(SECOND_OFFSET) || SECOND_OFFSET < 0 || SECOND_OFFSET > 59) {
  console.error('Invalid --offset value. Must be 0-59.');
  process.exit(1);
}

console.log(`[Config] Price check offset: :${String(SECOND_OFFSET).padStart(2, '0')} past each minute`);

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk/graphql';
const BUY_BELOW     = 0.85;
const SELL_ABOVE    = 1.45;
const TOKEN_REFRESH = 2 * 60 * 1000;

const EMAIL    = process.env.WATTO_USER;
const PASSWORD = process.env.WATTO_PASS;

if (!EMAIL || !PASSWORD) {
  console.error('[Bot] Missing WATTO_USER or WATTO_PASS environment variables.');
  console.error('      Run: WATTO_USER=email WATTO_PASS=pass node bot.js [--offset N]');
  process.exit(1);
}

// ─── Skip list — item IDs to never buy ───────────────────────────────────────
const SKIP_ITEM_IDS = new Set([
  '695e6e0d-03b4-4812-94b5-411e88a81a22'
]);

// ─── State ────────────────────────────────────────────────────────────────────
let token        = null;
let userId       = null;
let restockTimer = null;
let restockItems = [];

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
  const login = data?.data?.login;
  if (!login?.token) {
    console.error('[Auth] Login failed:', JSON.stringify(data?.errors ?? data));
    process.exit(1);
  }
  token  = login.token;
  userId = login.id;
  console.log(`[Auth] Logged in as ${login.name} (userId: ${userId})`);
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

// ─── Fetch all shop items ─────────────────────────────────────────────────────
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
        }
      }
    }
  `);
  return data?.data?.items ?? [];
}

// ─── Fetch item type weights ──────────────────────────────────────────────
async function getItemTypeWeights() {
  const data = await gql(`
    query ItemTypes {
      itemTypes {
        id
        name
        weight
      }
    }
  `);
  
  const weights = {};
  for (const type of data?.data?.itemTypes ?? []) {
    weights[type.id] = type.weight;
  }
  return weights;
}

// ─── Fetch inventory and return a map of { itemId -> quantity owned } ─────────
async function getInventoryQuantities() {
  const data = await gql(
    `query userInventory($userId: String!) {
      userItems(userId: $userId) {
        itemId
        item {
          type { name }
        }
      }
    }`,
    { userId }
  );

  const counts = {};
  for (const entry of data?.data?.userItems ?? []) {
    counts[entry.itemId] = (counts[entry.itemId] ?? 0) + 1;
  }
  return counts;
}

// ─── Buy one unit of an item ──────────────────────────────────────────────────
async function buyOne(itemId, itemName) {
  if (SKIP_ITEM_IDS.has(itemId)) {
    console.log(`    [buy] ${itemName}: skipped`);
    return false;
  }

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
  if (SKIP_ITEM_IDS.has(item.id)) {
    console.log(`    [buy] ${item.name}: skipped`);
    return;
  }
  if (item.stock === 0) { console.log(`    [buy] ${item.name}: no stock`); return; }

  console.log(`    [buy] ${item.name}: buying ${item.stock} unit(s)`);
  for (let i = 0; i < item.stock; i++) {
    const ok = await buyOne(item.id, item.name);
    if (!ok) break;
  }
}

// ─── Sell exact quantity from inventory ───────────────────────────────────────
async function sellFromInventory(itemId, itemName, quantity) {
  if (!quantity || quantity === 0) {
    console.log(`    [sell] ${itemName}: nothing in inventory`);
    return;
  }

  console.log(`    [sell] ${itemName}: selling ${quantity} from inventory`);

  const data = await gql(
    `mutation SellItem($itemId: ID!, $quantity: Int!, $sellTo: SellTarget!) {
      sellItem(itemId: $itemId, quantity: $quantity, sellTo: $sellTo) {
        payout
        soldIds
        newItemStock
        marketListingId
      }
    }`,
    { itemId, quantity, sellTo: 'WATTO' }
  );

  if (data?.errors || !data?.data?.sellItem) {
    console.log(`    [sell] ${itemName} failed: ${data?.errors?.[0]?.message ?? 'unknown'}`);
    return;
  }

  console.log(`    [sell] ${itemName} payout: ${data.data.sellItem.payout}`);
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

  let itemTypeWeights;
  try {
    itemTypeWeights = await getItemTypeWeights();
  } catch (err) {
    console.log('  Failed to fetch item type weights:', err.message);
    await refreshBearer();
    return;
  }

  // Group by category
  const byCategory = {};
  for (const item of items) {
    const cat = item.type.name;
    if (!byCategory[cat]) byCategory[cat] = { typeId: item.type.id, items: [] };
    byCategory[cat].items.push(item);
  }

  const newRestockItems = [];

  for (const [catName, { typeId, items: catItems }] of Object.entries(byCategory)) {
    const weight = itemTypeWeights[typeId] ?? 1.0;
    console.log(`\n  ${catName}: weight=${weight}`);

    if (weight < BUY_BELOW) {
      console.log(`    -> BUY all stock (below ${BUY_BELOW})`);
      for (const item of catItems) {
        await buyAllStock(item);
        newRestockItems.push(item);
      }
    } else if (weight > SELL_ABOVE) {
      console.log(`    -> SELL (above ${SELL_ABOVE})`);
      const inventory = await getInventoryQuantities();
      for (const item of catItems) {
        const qty = inventory[item.id] ?? 0;
        if (qty > 0) {
          await sellFromInventory(item.id, item.name, qty);
        }
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
  await tick();
  scheduleNextTick();
}

main().catch(console.error);