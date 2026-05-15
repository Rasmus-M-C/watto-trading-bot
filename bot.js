const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk//graphql';
const BUY_BELOW     = 0.93;
const SELL_ABOVE    = 1.23;
const TICK_INTERVAL = 1 * 60 * 1000;  // check every 1 minute
const WAIT_DELAY = 50;
const EMAIL    = process.env.WATTO_USER;
const PASSWORD = process.env.WATTO_PASS;

if (!EMAIL || !PASSWORD) {
  console.error('[Bot] Missing WATTO_USER or WATTO_PASS environment variables.');
  console.error('      Run: WATTO_USER=email WATTO_PASS=pass node bot.js');
  process.exit(1);
}

// ─── Item registry ────────────────────────────────────────────────────────────
// Maps itemType name -> list of individual item IDs we can buy/sell
const ITEMS_BY_CATEGORY = {
  'Navigation & Electronics': [
    '51931257-a8ce-4504-9dbc-b3ea7911bdda',  // HOLOGRAPHIC NAV
    'ce665896-47b1-45ad-a0ca-ed81f1b8c11a',  // NAV NAV
  ],
  'Podracer Parts': [
    '35b70839-b24d-4985-b719-463fe281e053',  // IGNITION POD
    'cb4f4ffb-d24f-44ed-b23f-b0c88f944e38',  // IGNITION POD
    '4fd24482-26ff-49cc-ae9c-ecf9e18b33f4',  // IGNITION POD

  ],
  'Misc Junk': [
    'ad9906f8-6e4f-4210-9288-0bb5edb6d4ff',  // HELMET
    '54a19bae-d195-4395-be0f-b881a7e3eedd',  // INT-CHAIR
  ],
  'Droids': [
    'd06e0479-bc0e-4615-9918-96f41fe61a18',  // PARTS
    '5d426e2e-f908-4a79-855f-023a123e24fd',  // LEG
    '1c575d71-c080-42fa-9a3d-8ed8523311ed',  // GONK
    '52f60276-2f8a-4701-a7b7-88e494d6534d',  // HEAD
  ],
  'Rare Artifacts': [
    'ecbd757f-db77-4ce6-b738-ee3f30042234', //SITH
    '3751c92d-2397-4894-bb04-1feed04ccbd7', // BESKAR
    '23c9ae29-7795-4bd1-8782-6c36893a28c1', //ANCIENT
  ]
};

// ─── State ────────────────────────────────────────────────────────────────────
let token = null;

// ─── GraphQL helper ───────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  return res.json();
}
async function refreshBearer() {
  console.log('[Auth] Refreshing token...');
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie':       `refresh_token=${token}`,
    },
    body: JSON.stringify({ query: 'mutation { refreshToken }' }),
  });
 
  const data = await res.json();
  const newToken = data?.data?.refreshToken;
 
  if (newToken) {
    token = newToken;
    console.log('[Auth] Token refreshed');
  } else {
    console.warn('[Auth] Refresh failed, re-logging in...', JSON.stringify(data?.errors ?? data));
    await login();
  }
}
// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  console.log('[Auth] Logging in as', EMAIL);
  const data = await gql(
    `mutation Login($email: String!, $password: String!) {
      login(email: $email, password: $password) {
        id
        email
        token
        name
      }
    }`,
    { email: EMAIL, password: PASSWORD }
  );

  const t = data?.data?.login?.token;
  if (!t) {
    console.error('[Auth] Login failed:', JSON.stringify(data?.errors ?? data));
    process.exit(1);
  }

  token = t;
  console.log('[Auth] Logged in as', data.data.login.name, '✓');
}
async function refreshToken() {
  console.log('[Auth] Refreshing token for', EMAIL);
  const data = await gql(
    `mutation  {
      refreshToken
    }`,
  );

  const t = data?.data?.login?.token;
  if (!t) {
    console.error('[Auth] Login failed:', JSON.stringify(data?.errors ?? data));
    process.exit(1);
  }

  token = t;
  console.log('[Auth] Logged in as', data.data.login.name, '✓');
}
// ─── Get item type weights ────────────────────────────────────────────────────
async function getItemTypes() {
  const data = await gql(`
    query ItemTypes {
      itemTypes {
        id
        name
        weight
      }
    }
  `);
  return data?.data?.itemTypes ?? [];
}

// ─── Buy one item repeatedly until error ─────────────────────────────────────
async function buyUntilEmpty(itemId, itemName) {
  let count = 0;
  while (true) {
    const data = await gql(
      `mutation BuyItem($itemId: ID!) {
        buyItem(itemId: $itemId) {
          id
          purchasePrice
          item { id stock currentPrice }
        }
      }`,
      { itemId }
    );

    if (data?.errors || !data?.data?.buyItem) {
      const reason = data?.errors?.[0]?.message ?? 'unknown error';
      console.log(`    stopped buying ${itemName} after ${count}: ${reason}`);
      break;
    }

    count++;
    const { purchasePrice, item } = data.data.buyItem;
    console.log(`    bought ${itemName} #${count} @ ${purchasePrice} (stock left: ${item.stock})`);
    await new Promise(resolve => setTimeout(resolve, WAIT_DELAY));

    // Stop if stock hits 0
    if (item.stock === 0) {
      console.log(`    ${itemName} out of stock`);
      break;
    }
  }
}

// ─── Sell one item repeatedly until error ─────────────────────────────────────
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
      console.log(`    stopped selling ${itemName} after ${count}: ${reason}`);
      if (reason.includes('Not authorized')) {
        login().then(() => console.log('    re-logged in, will retry selling next tick'));
      }
      break;
    }

    count++;
    const { payout, newItemStock } = data.data.sellItem;
    console.log(`    sold ${itemName} #${count} payout: ${payout} (stock left: ${newItemStock})`);


    await new Promise(resolve => setTimeout(resolve, WAIT_DELAY));

  }
}

// ─── Main trading tick ────────────────────────────────────────────────────────
async function tick() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Fetching item weights...`);
  
  let itemTypes;
  try {
    itemTypes = await getItemTypes();
    await refreshBearer();  // Refresh token after each successful fetch to stay logged in
  } catch (err) {
    console.log('  Failed to fetch items:', err.message, '— re-logging in...');
    await login();
    return;
  }

  for (const itemType of itemTypes) {
    const weight = parseFloat(itemType.weight);
    const items  = ITEMS_BY_CATEGORY[itemType.name];

    if (!items) {
      console.log(`  ${itemType.name}: ${weight} (no items configured, skipping)`);
      continue;
    }

    if (weight < BUY_BELOW) {
      console.log(`  ${itemType.name}: ${weight} -> BUYING (below ${BUY_BELOW})`);
      for (const itemId of items) {
        await buyUntilEmpty(itemId, itemType.name);
      }
    } else if (weight > SELL_ABOVE) {
      console.log(`  ${itemType.name}: ${weight} -> SELLING (above ${SELL_ABOVE})`);
      for (const itemId of items) {
        await sellUntilEmpty(itemId, itemType.name);
      }
    } else {
      console.log(`  ${itemType.name}: ${weight} (hold)`);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await login();
  await tick();
  setInterval(tick, TICK_INTERVAL);
}

main().catch(console.error);