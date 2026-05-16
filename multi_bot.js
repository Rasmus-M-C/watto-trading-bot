const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ─── Config ───────────────────────────────────────────────────────────────────
const GQL_ENDPOINT  = 'https://f2026-bagende.itmindsinternal.dk/graphql';
const BUY_BELOW     = 0.80;
const SELL_ABOVE    = 1.20;
const TOKEN_REFRESH = 5 * 60 * 1000;

// Worker accounts — set via env: WORKER_1=email:password WORKER_2=email:password etc.
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
    '79b082c0-854c-4da2-97d7-562d539c98c9',  // PARTS
    '2438b62e-2a52-43f0-a5fe-ac9c33935f77',  // LEG
    '1c575d71-c080-42fa-9a3d-8ed8523311ed',  // GONK
    '0cd73b63-fc10-483f-be8c-29357860406b',  // HEAD
  ],
  'Rare Artifacts': [
    'ecbd757f-db77-4ce6-b738-ee3f30042234', //SITH
    '3751c92d-2397-4894-bb04-1feed04ccbd7', // BESKAR
    '23c9ae29-7795-4bd1-8782-6c36893a28c1', //ANCIENT
  ]
};

// ─── Shared bus ───────────────────────────────────────────────────────────────
// Workers push listing IDs here; main account drains and buys them
const bus = {
  listings: [],  // { listingId, itemId, unitPrice, quantity, postedBy }

  post(listing) {
    this.listings.push(listing);
    console.log(`  [bus] ${listing.postedBy} → listingId=${listing.listingId} qty=${listing.quantity} @ ${listing.unitPrice}`);
  },

  drain() {
    const all = [...this.listings];
    this.listings = [];
    return all;
  },
};

// ─── GQL helpers ──────────────────────────────────────────────────────────────
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

async function doRefreshToken(token) {
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

async function getItemTypes(token) {
  const data = await gqlAs(token, `query { itemTypes { id name weight } }`);
  return data?.data?.itemTypes ?? [];
}

// ─── Worker: buy cheap items and list on market, post listing ID to bus ───────
async function runWorker({ email, password, name }) {
  console.log(`[${name}] Logging in...`);
  const loginData = await loginAs(email, password);
  if (!loginData?.token) { console.error(`[${name}] Login failed`); return; }

  let token = loginData.token;
  console.log(`[${name}] Logged in as "${loginData.name}"`);

  setInterval(async () => {
    const t = await doRefreshToken(token);
    if (t) { token = t; console.log(`[${name}] Token refreshed`); }
  }, TOKEN_REFRESH);

  // Buy one item and immediately list it; post listing ID to bus
  async function buyAndList(itemId) {
    // Buy
    const buyData = await gqlAs(token,
      `mutation BuyItem($itemId: ID!) {
        buyItem(itemId: $itemId) {
          id
          purchasePrice
          item { id stock }
        }
      }`,
      { itemId }
    );

    if (buyData?.errors || !buyData?.data?.buyItem) {
      const reason = buyData?.errors?.[0]?.message ?? 'unknown';
      console.log(`  [${name}] buy failed: ${reason} - Buying the item ${itemId}`);
      return false;
    }

    const { purchasePrice, item } = buyData.data.buyItem;
    console.log(`  [${name}] bought itemId=${item.id} @ ${purchasePrice} (stock left: ${item.stock})`);

    // List on market at purchase price + 2% so main account still profits
    const unitPrice = parseFloat((purchasePrice * 1.02).toFixed(4));

    const listData = await gqlAs(token,
      `mutation CreateMarketListing($itemId: ID!, $quantity: Int!, $unitPrice: Float!) {
        createMarketListing(itemId: $itemId, quantity: $quantity, unitPrice: $unitPrice) {
          id
          unitPrice
          quantityTotal
        }
      }`,
      { itemId: item.id, quantity: 1, unitPrice }
    );

    if (listData?.errors || !listData?.data?.createMarketListing) {
      console.log(`  [${name}] listing failed:`, listData?.errors?.[0]?.message ?? 'unknown');
      return false;
    }

    const listing = listData.data.createMarketListing;
    bus.post({
      listingId: listing.id,
      itemId:    item.id,
      unitPrice: listing.unitPrice,
      quantity:  listing.quantityTotal,
      postedBy:  name,
    });

    return item.stock > 0;
  }

  // Drain all current stock for cheap categories
  async function drainAndList() {
    const itemTypes = await getItemTypes(token);

    for (const itemType of itemTypes) {
      const weight = parseFloat(itemType.weight);
      const items  = ITEMS_BY_CATEGORY[itemType.name];
      if (!items || weight >= BUY_BELOW) continue;

      console.log(`[${name}] ${itemType.name} @ ${weight} -> draining stock`);
      for (const itemId of items) {
        let stockLeft = true;
        while (stockLeft) {
          stockLeft = await buyAndList(itemId);
        }
      }
    }
  }

  // Run immediately, then sync to :11 each minute
  await drainAndList();

  const now    = new Date();
  const secs   = now.getSeconds();
  const ms     = now.getMilliseconds();
  const waitMs = secs < 11 ? (11 - secs) * 1000 - ms : (71 - secs) * 1000 - ms;
  console.log(`[${name}] Next price check in ${(waitMs / 1000).toFixed(1)}s`);
  setTimeout(async () => {
    await drainAndList();
    setInterval(drainAndList, 60 * 1000);
  }, waitMs);

  // Restock loop — try to grab 1 of each cheap item every 10s
  setInterval(async () => {
    const itemTypes = await getItemTypes(token);
    for (const itemType of itemTypes) {
      if (parseFloat(itemType.weight) >= BUY_BELOW) continue;
      const items = ITEMS_BY_CATEGORY[itemType.name];
      if (!items) continue;
      for (const itemId of items) {
        await buyAndList(itemId);
      }
    }
  }, 10 * 1000);
}

// ─── Main account: buy from bus, sell to Watto when price is high ─────────────
async function runMain() {
  console.log('[Main] Logging in...');
  const loginData = await loginAs(MAIN_EMAIL, MAIN_PASSWORD);
  if (!loginData?.token) { console.error('[Main] Login failed'); process.exit(1); }

  let token = loginData.token;
  console.log('[Main] Logged in as', loginData.name);

  setInterval(async () => {
    const t = await doRefreshToken(token);
    if (t) { token = t; console.log('[Main] Token refreshed'); }
  }, TOKEN_REFRESH);

  // Items bought from workers but not yet sold — { itemId, quantity }
  const inventory = [];

  // Every 2s: buy any listings posted by workers
  setInterval(async () => {
    const listings = bus.drain();
    if (!listings.length) return;

    for (const listing of listings) {
      console.log(`[Main] Buying listing ${listing.listingId} x${listing.quantity} @ ${listing.unitPrice}`);

      const buyData = await gqlAs(token,
        `mutation BuyMarketListing($listingId: ID!, $quantity: Int!) {
          buyMarketListing(listingId: $listingId, quantity: $quantity) {
            listingId
            totalCost
            quantityBought
            quantityRemaining
          }
        }`,
        { listingId: listing.listingId, quantity: listing.quantity }
      );

      if (buyData?.errors || !buyData?.data?.buyMarketListing) {
        console.log(`[Main] Buy failed:`, buyData?.errors?.[0]?.message ?? 'unknown');
        continue;
      }

      const result = buyData.data.buyMarketListing;
      console.log(`[Main] Bought x${result.quantityBought} total cost: ${result.totalCost}`);

      // Add to inventory
      const existing = inventory.find(i => i.itemId === listing.itemId);
      if (existing) {
        existing.quantity += result.quantityBought;
      } else {
        inventory.push({ itemId: listing.itemId, quantity: result.quantityBought });
      }
    }
  }, 2 * 1000);

  // Every 15s: check prices and sell inventory to Watto if profitable
  setInterval(async () => {
    if (!inventory.length) return;

    const itemTypes = await getItemTypes(token);

    for (const itemType of itemTypes) {
      const weight = parseFloat(itemType.weight);
      if (weight <= SELL_ABOVE) continue;

      // Find inventory items that belong to this category
      const categoryItemIds = ITEMS_BY_CATEGORY[itemType.name] ?? [];

      for (const { itemId } of inventory.filter(i => categoryItemIds.includes(i.itemId))) {
        const inv = inventory.find(i => i.itemId === itemId);
        if (!inv || inv.quantity === 0) continue;

        console.log(`[Main] ${itemType.name} @ ${weight} -> selling ${inv.quantity} to Watto`);

        while (inv.quantity > 0) {
          const sellData = await gqlAs(token,
            `mutation SellItem($itemId: ID!, $quantity: Int!, $sellTo: SellTarget!) {
              sellItem(itemId: $itemId, quantity: $quantity, sellTo: $sellTo) {
                payout
                newItemStock
              }
            }`,
            { itemId, quantity: 1, sellTo: 'WATTO' }
          );

          if (sellData?.errors || !sellData?.data?.sellItem) {
            console.log(`[Main] Sell failed:`, sellData?.errors?.[0]?.message ?? 'unknown');
            break;
          }

          inv.quantity--;
          console.log(`[Main] Sold to Watto, payout: ${sellData.data.sellItem.payout} (${inv.quantity} left in inventory)`);
        }
      }
    }
  }, 15 * 1000);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[Bot] Starting — ${WORKER_CREDENTIALS.length} worker(s) + 1 main account`);
  await Promise.all([
    runMain(),
    ...WORKER_CREDENTIALS.map(creds => runWorker(creds)),
  ]);
}

main().catch(console.error);