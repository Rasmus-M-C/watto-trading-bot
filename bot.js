const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk/graphql';
const TOKEN_REFRESH = 2 * 60 * 1000;
const CONFIG_REFRESH = 8 * 60 * 60 * 1000; // 8 hours

const EMAIL    = process.env.WATTO_USER;
const PASSWORD = process.env.WATTO_PASS;

if (!EMAIL || !PASSWORD) {
  console.error('[Bot] Missing WATTO_USER or WATTO_PASS environment variables.');
  console.error('      Run: WATTO_USER=email WATTO_PASS=pass node bot.js');
  process.exit(1);
}

// ─── Bot Config ───────────────────────────────────────────────────────────────
const ITEM_TYPE_IDS = [
  'b7026116-bf27-43c0-95a6-dbbb0cc2448e',
  '81aef75f-926b-42e0-a42b-c51f8f8a30fd',
  '26debbaf-bfa5-47a8-9440-089e502b85c6',
  'a6e9fb96-e881-4745-9c7e-15a3bef32a6c',
  'ef9a6e78-ad86-44b1-af0c-4b8a3b5718c7'
];
const BUY_THRESHOLD  = 0.31;
const SELL_THRESHOLD = 1.5;

// ─── State ────────────────────────────────────────────────────────────────────
let token         = null;
let userId        = null;
let configTimer   = null;

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

// ─── Save bot config ──────────────────────────────────────────────────────────
async function saveBotConfig() {
  console.log('[Config] Saving bot configuration...');
  
  const data = await gql(
    `mutation SaveBotConfig($itemTypeIds: [String!]!, $buyThreshold: Float!, $sellThreshold: Float!) {
      saveBotConfig(
        itemTypeIds: $itemTypeIds
        buyThreshold: $buyThreshold
        sellThreshold: $sellThreshold
      ) {
        isActive
        itemTypeIds
        buyThreshold
        sellThreshold
        startedAt
        expiresAt
      }
    }`,
    {
      itemTypeIds: ITEM_TYPE_IDS,
      buyThreshold: BUY_THRESHOLD,
      sellThreshold: SELL_THRESHOLD
    }
  );

  if (data?.errors || !data?.data?.saveBotConfig) {
    console.log('[Config] Save failed:', data?.errors?.[0]?.message ?? 'unknown error');
    return false;
  }

  const config = data.data.saveBotConfig;
  console.log('[Config] Saved successfully');
  console.log(`  isActive: ${config.isActive}`);
  console.log(`  buyThreshold: ${config.buyThreshold}`);
  console.log(`  sellThreshold: ${config.sellThreshold}`);
  console.log(`  expiresAt: ${config.expiresAt}`);
  return true;
}

// ─── Start bot ─────────────────────────────────────────────────────────────────
async function startBot() {
  console.log('[Bot] Starting bot...');
  
  const data = await gql(
    `mutation StartBot {
      startBot {
        isActive
        itemTypeIds
        buyThreshold
        sellThreshold
        startedAt
        expiresAt
      }
    }`
  );

  if (data?.errors || !data?.data?.startBot) {
    console.log('[Bot] Start failed:', data?.errors?.[0]?.message ?? 'unknown error');
    return false;
  }

  const config = data.data.startBot;
  console.log('[Bot] Started successfully');
  console.log(`  isActive: ${config.isActive}`);
  console.log(`  startedAt: ${config.startedAt}`);
  console.log(`  expiresAt: ${config.expiresAt}`);
  return true;
}

// ─── Config loop: runs every 8 hours ───────────────────────────────────────────
async function runConfigCycle() {
  try {
    const saved = await saveBotConfig();
    if (!saved) return;

    const started = await startBot();
    if (!started) return;

    console.log('[Config] Cycle complete. Next refresh in 8 hours.');
  } catch (err) {
    console.error('[Config] Error during cycle:', err.message);
    await refreshBearer();
  }

  // Schedule next config refresh
  if (configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(runConfigCycle, CONFIG_REFRESH);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleTimeString()}] Bot starting...`);
  
  await login();
  setInterval(refreshBearer, TOKEN_REFRESH);
  
  // Initial config cycle
  await runConfigCycle();
}

main().catch(console.error);
