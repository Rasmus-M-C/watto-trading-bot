const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk/graphql';
const BUY_BELOW     = 0.80;
const SELL_ABOVE    = 1.20;
const TOKEN_REFRESH = 20 * 60 * 1000;

// Worker accounts — add as many as you like via env vars
// WORKER_1=email:password WORKER_2=email:password etc.
const WORKER_CREDENTIALS = [];
for (let i = 1; i <= 10; i++) {
  const val = process.env[`WORKER_${i}`];
  if (val) {
    const [email, ...rest] = val.split(':');
    WORKER_CREDENTIALS.push({ email, password: rest.join(':'), name: `Worker${i}` });
  }
}

const MAIN_EMAIL    = process.env.WATTO_USER;
const MAIN_PASSWORD = process.env.WATTO_PASS;

if (!MAIN_EMAIL || !MAIN_PASSWORD) {
  console.error('Missing WATTO_USER or WATTO_PASS');
  process.exit(1);
}
if (!WORKER_CREDENTIALS.length) {
  console.error('No worker accounts found. Set WORKER_1=email:password etc.');
  process.exit(1);
}

// ─── Item registry ────────────────────────────────────────────────────────────
const ITEMS_BY_CATEGORY = {
  'Navigation & Electronics': [
    '51931257-a8ce-4504-9dbc-b3ea7911bdda',
    'ce665896-47b1-45ad-a0ca-ed81f1b8c11a',
  ],
  'Podracer Parts': [
    '35b70839-b24d-4985-b719-463fe281e053',
  ],
  'Misc Junk': [
    'ad9906f8-6e4f-4210-9288-0bb5edb6d4ff',
    '54a19bae-d195-4395-be0f-b881a7e3eedd',
  ],
  'Droids': [
    'd06e0479-bc0e-4615-9918-96f41fe61a18',
    '5d426e2e-f908-4a79-855f-023a123e24fd',
    '1c575d71-c080-42fa-9a3d-8ed8523311ed',
    '52f60276-2f8a-4701-a7b7-88e494d6534d',
  ],
};

// ─── Shared message bus ───────────────────────────────────────────────────────
// Workers post market listings here; main account reads and buys them
const marketBus = {
  listings: [],   // { itemId, marketListingId, price, postedBy }

  post(listing) {
    this.listings.push(listing);
    console.log(`[Bus] ${listing.postedBy} listed ${listing.itemId} @ ${listing.price} (listingId: ${listing.marketListingId})`);
  },

  drain() {
    const all = [...this.listings];
    this.listings = [];
    return all;
  },
};

// ─── GQL helpers ─────────────────────────────────────────────────────────────
async function gqlAs(token, query, variables = {}) {
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

async function refreshToken(token) {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie':       `refresh_token=${token}`,
    },
    body: JSON.stringify({ query: 'mutation { refreshToken }' }),
  });
  const data = await res.json();
  return data?.data?.refreshToken ?? null;
}

async function loginAs(email, password) {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation Login($email: String!, $password: String!) {
        login(email: $email, password: $password) { token name }
      }`,
      variables: { email, password },
    }),
  });
  const data = await res.json();
  return data?.data?.login ?? null;
}

// ─── Worker account ───────────────────────────────────────────────────────────
async function runWorker({ email, password, name }) {
  console.log(`[${name}] Logging in...`);
  const loginData = await loginAs(email, password);
  if (!loginData?.token) {
    console.error(`[${name}] Login failed`);
    return;
  }

  let token = loginData.token;
  console.log(`[${name}] Logged in as ${loginData.name}`);

  // Refresh token periodically
  setInterval(async () => {
    const newToken = await refreshToken(token);
    if (newToken) { token = newToken; console.log(`[${name}] Token refreshed`); }
  }, TOKEN_REFRESH);

  // Worker tick — buy cheap items and list them on the market
  async function workerTick() {
    const data = await gqlAs(token, `query { itemTypes { id name weight } }`);
    const itemTypes = data?.data?.itemTypes ?? [];

    for (const itemType of itemTypes) {
      const weight = parseFloat(itemType.weight);
      const items  = ITEMS_BY_CATEGORY[itemType.name];
      if (!items || weight >= BUY_BELOW) continue;

      console.log(`[${name}] ${itemType.name}: ${weight} -> buying + listing on market`);

      for (const itemId of items) {
        // Buy as many as possible
        while (true) {
          const buyData = await gqlAs(token,
            `mutation BuyItem($itemId: ID!) {
              buyItem(itemId: $itemId) {
                id purchasePrice item { id stock }
              }
            }`,
            { itemId }
          );

          if (buyData?.errors || !buyData?.data?.buyItem) break;

          const { purchasePrice, item } = buyData.data.buyItem;
          console.log(`  [${name}] bought @ ${purchasePrice}`);

          // Immediately list on market at a price the main account will buy
          // Price slightly above purchase so worker profits too
          const listPrice = (purchasePrice * 1.05).toFixed(4);
          const listData = await gqlAs(token,
            `mutation ListItem($itemId: ID!, $price: Float!) {
              listItemOnMarket(itemId: $itemId, price: $price) {
                id
                price
              }
            }`,
            { itemId: item.id, price: parseFloat(listPrice) }
          );

          if (listData?.data?.listItemOnMarket) {
            const listing = listData.data.listItemOnMarket;
            marketBus.post({
              itemId:          item.id,
              marketListingId: listing.id,
              price:           listing.price,
              postedBy:        name,
            });
          }

          if (item.stock === 0) break;
        }
      }
    }
  }

  // Run immediately, then at :11 each minute
  await workerTick();

  function scheduleWorker() {
    const now     = new Date();
    const seconds = now.getSeconds();
    const ms      = now.getMilliseconds();
    const waitMs  = seconds < 11
      ? (11 - seconds) * 1000 - ms
      : (71 - seconds) * 1000 - ms;

    setTimeout(async () => {
      await workerTick();
      setInterval(workerTick, 60 * 1000);
    }, waitMs);
  }

  scheduleWorker();

  // Restock loop — try to buy 1 of each cheap item every 10s
  setInterval(async () => {
    const data = await gqlAs(token, `query { itemTypes { id name weight } }`);
    const itemTypes = data?.data?.itemTypes ?? [];

    for (const itemType of itemTypes) {
      if (parseFloat(itemType.weight) >= BUY_BELOW) continue;
      const items = ITEMS_BY_CATEGORY[itemType.name];
      if (!items) continue;

      for (const itemId of items) {
        const buyData = await gqlAs(token,
          `mutation BuyItem($itemId: ID!) {
            buyItem(itemId: $itemId) { id purchasePrice item { id stock } }
          }`,
          { itemId }
        );
        if (!buyData?.data?.buyItem) continue;

        const { purchasePrice, item } = buyData.data.buyItem;
        const listPrice = (purchasePrice * 1.05).toFixed(4);
        const listData = await gqlAs(token,
          `mutation ListItem($itemId: ID!, $price: Float!) {
            listItemOnMarket(itemId: $itemId, price: $price) { id price }
          }`,
          { itemId: item.id, price: parseFloat(listPrice) }
        );

        if (listData?.data?.listItemOnMarket) {
          const listing = listData.data.listItemOnMarket;
          marketBus.post({ itemId: item.id, marketListingId: listing.id, price: listing.price, postedBy: name });
        }
      }
    }
  }, 10 * 1000);
}

// ─── Main account ─────────────────────────────────────────────────────────────
async function runMain() {
  console.log('[Main] Logging in...');
  const loginData = await loginAs(MAIN_EMAIL, MAIN_PASSWORD);
  if (!loginData?.token) { console.error('[Main] Login failed'); process.exit(1); }

  let token = loginData.token;
  console.log('[Main] Logged in as', loginData.name);

  setInterval(async () => {
    const newToken = await refreshToken(token);
    if (newToken) { token = newToken; console.log('[Main] Token refreshed'); }
  }, TOKEN_REFRESH);

  // Every 5 seconds: drain the bus, buy worker listings, then sell to Watto when price is high
  setInterval(async () => {
    const listings = marketBus.drain();
    if (!listings.length) return;

    console.log(`[Main] ${listings.length} listing(s) on bus — buying from workers...`);

    for (const listing of listings) {
      // Buy the listing from the market
      const buyData = await gqlAs(token,
        `mutation BuyListing($marketListingId: ID!) {
          buyMarketListing(marketListingId: $marketListingId) {
            id purchasePrice item { id currentPrice }
          }
        }`,
        { marketListingId: listing.marketListingId }
      );

      if (buyData?.errors || !buyData?.data?.buyMarketListing) {
        console.log(`[Main] Failed to buy listing ${listing.marketListingId}:`, buyData?.errors?.[0]?.message);
        continue;
      }

      const { purchasePrice, item } = buyData.data.buyMarketListing;
      console.log(`[Main] Bought from market @ ${purchasePrice}, current price: ${item.currentPrice}`);

      // If current price is above sell threshold, sell to Watto immediately
      if (parseFloat(item.currentPrice) > SELL_ABOVE) {
        const sellData = await gqlAs(token,
          `mutation SellItem($itemId: ID!, $quantity: Int!, $sellTo: SellTarget!) {
            sellItem(itemId: $itemId, quantity: $quantity, sellTo: $sellTo) {
              payout newItemStock
            }
          }`,
          { itemId: item.id, quantity: 1, sellTo: 'WATTO' }
        );

        if (sellData?.data?.sellItem) {
          console.log(`[Main] Sold to Watto, payout: ${sellData.data.sellItem.payout}`);
        }
      }
    }
  }, 5 * 1000);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[Bot] Starting with ${WORKER_CREDENTIALS.length} worker(s) + 1 main account`);

  // Start main account and all workers in parallel
  await Promise.all([
    runMain(),
    ...WORKER_CREDENTIALS.map(creds => runWorker(creds)),
  ]);
}

main().catch(console.error);