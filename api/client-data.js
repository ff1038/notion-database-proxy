// api/client-data.js  (CommonJS)

module.exports = async function handler(req, res) {
  console.log('=== API HANDLER START ===');

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID  = process.env.NOTION_DATABASE_ID;
    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: 'Server configuration error - missing environment variables' });
    }

    // --- Request params
    const { userEmail, secureKey, timestamp, client: clientParam, resolveRelations } = req.query || {};
    if (!userEmail || !secureKey || !timestamp) {
      return res.status(401).json({ error: 'Missing authentication parameters' });
    }

    // --- Verify key (returns { ok, isAdmin, clientFromKey })
    const { ok, isAdmin, clientFromKey } = verifySecureKey(userEmail, secureKey, timestamp);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid access credentials' });
    }

    // --- Resolve which client’s data to show
    let clientName = null;
    const userMappedClient = getClientForUser(userEmail); // null for admin; defined for members
    const clean = s => (s || '').trim();

    if (clean(clientParam)) {
      if (isAdmin) {
        clientName = clean(clientParam);
      } else {
        if (clean(clientParam) !== userMappedClient) {
          return res.status(403).json({ error: 'Client access denied for user' });
        }
        clientName = userMappedClient;
      }
    } else if (clientFromKey) {
      clientName = clientFromKey;
      if (!isAdmin && userMappedClient && clientName !== userMappedClient) {
        return res.status(403).json({ error: 'Client access denied for user' });
      }
    } else {
      if (!isAdmin) {
        if (!userMappedClient) return res.status(403).json({ error: 'No client access for user' });
        clientName = userMappedClient;
      } else {
        return res.status(400).json({ error: 'Admin access requires client context (add ?client=...)' });
      }
    }

    console.log('Resolved -> isAdmin:', isAdmin, '| clientName:', clientName);

    // --- Notion query with pagination (always filtered to clientName)
    const baseRequestBody = {
      page_size: 100, // larger page size (fast mode)
      filter: {
        property: 'Client',
        select: { equals: clientName }
      }
    };

    let allResults = [];
    let hasMore = true;
    let nextCursor = null;
    let pageCount = 0;

    while (hasMore && pageCount < 10) { // safety: up to 1,000 rows
      pageCount++;
      const requestBody = { ...baseRequestBody };
      if (nextCursor) requestBody.start_cursor = nextCursor;

      // Per-page timeout to avoid hanging
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 25_000);

      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      }).finally(() => clearTimeout(to));

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return res.status(500).json({
          error: `Notion API error on page ${pageCount}: ${response.status}`,
          details: errorText
        });
      }

      const pageData = await response.json();
      allResults = allResults.concat(pageData.results || []);
      hasMore = !!pageData.has_more;
      nextCursor = pageData.next_cursor || null;
    }

    // --- FAST MODE: skip relation resolution by default (use rollups instead)
    const SHOULD_RESOLVE_RELATIONS = resolveRelations === '1';
    if (SHOULD_RESOLVE_RELATIONS && allResults.length > 0) {
      console.log('Relation resolution enabled via ?resolveRelations=1 (slow)');
      let count = 0;
      for (let i = 0; i < allResults.length; i++) {
        const record = allResults[i];
        for (const [key, property] of Object.entries(record.properties || {})) {
          if (property.type === 'relation' && Array.isArray(property.relation) && property.relation.length > 0) {
            try {
              count++;
              const firstRelation = property.relation[0];

              // per-request timeout as well
              const controller = new AbortController();
              const to = setTimeout(() => controller.abort(), 10_000);

              const pageResp = await fetch(`https://api.notion.com/v1/pages/${firstRelation.id}`, {
                headers: {
                  'Authorization': `Bearer ${NOTION_TOKEN}',
                  'Notion-Version': '2022-06-28'
                },
                signal: controller.signal
              }).finally(() => clearTimeout(to));

              if (pageResp.ok) {
                const relPage = await pageResp.json();
                const titleProp = Object.values(relPage.properties).find(p => p.type === 'title');
                if (titleProp?.title?.length) {
                  property.relation_titles = titleProp.title[0].plain_text;
                }
              }
              if (count % 5 === 0) await new Promise(r => setTimeout(r, 50));
            } catch (e) {
              console.error(`Relation fetch error for ${key}:`, e?.message || e);
            }
          }
        }
      }
    }

    const columnConfig = getUniversalColumnConfig();

    // --- Build metadata (robust currency detection)
    const incomeTypes = new Set();
    const currencies  = new Set();
    for (const r of allResults) {
      const it = r.properties?.['Income Type']?.select?.name;
      if (it) incomeTypes.add(it);

      const c =
        r.properties?.['Currency (Inv/Stmt)']?.select?.name ||
        r.properties?.['Currency']?.select?.name;
      if (c) currencies.add(c);
    }

    return res.status(200).json({
      results: allResults,
      authorizedClient: clientName,
      userEmail: userEmail,
      isAdmin,
      columnOrder: columnConfig.columns,
      columnHeaders: columnConfig.columnHeaders,
      debug: {
        recordCount: allResults.length,
        resolvedRelations: SHOULD_RESOLVE_RELATIONS,
        timestamp: new Date().toISOString()
      },
      metadata: {
        incomeTypes: [...incomeTypes],
        currencies:  [...currencies]
      }
    });

  } catch (error) {
    console.error('=== API HANDLER ERROR ===', error);
    return res.status(500).json({
      error: `Server error: ${error?.message || 'unknown'}`,
      type: error?.constructor?.name,
      stack: error?.stack,
      timestamp: new Date().toISOString()
    });
  }
};

/* ----------------- Helpers ----------------- */

// Column config: include optional rollup display columns if you add them in Notion.
function getUniversalColumnConfig() {
  return {
    columns: [
      'Invoice date','Inv #',
      'Vendor1',
      'Description','Income Type',
      'Net','Gross',
      'Currency (Inv/Stmt)','Currency',
      'Paid in date','Amount Received',
      'Currency (receipt)',
      'Adjustments','Net Commissionable',
      'Commission %','Mgmt Commission','Mgmt Inv #'
    ],
    columnHeaders: {
      'Invoice date':'Date (Inv/Stmt)',
      'Inv #':'Invoice #',
      'Vendor1':'Vendor',
      'Description':'Description',
      'Income Type':'Income Type',
      'Net':'Net Amount',
      'Gross':'Gross Amount',
      'Currency (Inv/Stmt)':'Currency (Inv/Stmt)',
      'Currency':'Currency (Inv/Stmt)',
      'Paid in date':'Paid In Date',
      'Amount Received':'Amount Received',
      'Currency (receipt)':'Currency (Received)',
      'Adjustments':'Adjustments',
      'Net Commissionable':'Net Commissionable',
      'Commission %':'Commission %',
      'Mgmt Commission':'Mgmt Commission',
      'Mgmt Inv #':'Mgmt Inv #'
    }
  };
}

// Non-admin fixed mapping
function getClientForUser(userEmail) {
  const userClientMap = {
    'edcarlile@me.com': 'King Ed',
    'lindenjaymusic@gmail.com': 'Linden Jay',
    'willvrocks@gmail.com': 'Will Vaughan',
    'talktotiggs@gmail.com': 'Tiggs',
    'mrkieranbeardmore@gmail.com': 'Kieran "KES" Beardmore'
  };
  return userClientMap[(userEmail || '').toLowerCase()] || null;
}

/**
 * verifySecureKey:
 *  - Non-admin: secureKey must match *their* expected key.
 *  - Admin (nick@sayshey.com): secureKey may match *any* known client key.
 * Returns { ok, isAdmin, clientFromKey } where clientFromKey is the client that the key represents.
 */
function verifySecureKey(userEmail, secureKey, timestamp) {
  try {
    const lower = (userEmail || '').toLowerCase();

    const makeKey = (prefix, seed) =>
      prefix + Buffer.from(seed).toString('base64').replace(/[^a-zA-Z0-9]/g, '');

    // Accepted keys per client (first = current, others = legacy)
    const CLIENT_KEY_DEFS = {
      'King Ed':                 { prefix: 'ke-', seeds: ['king-ed-2025'] },
      'Linden Jay':              { prefix: 'lj-', seeds: ['linden-jay-2025','client-a-2024'] },
      'Will Vaughan':            { prefix: 'wv-', seeds: ['will-vaughan-2025','client-a-2024'] },
      'Tiggs':                   { prefix: 'nf-', seeds: ['tiggs-2025','client-a-2024'] },
      'Kieran "KES" Beardmore':  { prefix: 'kb-', seeds: ['kieran-beardmore-2025','client-b-2024'] }
    };

    const clientToKeys = {};
    for (const [client, def] of Object.entries(CLIENT_KEY_DEFS)) {
      clientToKeys[client] = new Set(def.seeds.map(seed => makeKey(def.prefix, seed)));
    }

    // Which client does this secureKey belong to?
    let clientFromKey = null;
    for (const [client, keys] of Object.entries(clientToKeys)) {
      if (keys.has(secureKey)) { clientFromKey = client; break; }
    }

    // Timestamp window
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    const drift = now - requestTime;
    if (Number.isNaN(requestTime) || drift > 3600 || drift < -300) {
      return { ok: false, isAdmin: false, clientFromKey: null };
    }

    const isAdmin = lower === 'nick@sayshey.com';
    if (isAdmin) {
      const ok = !!clientFromKey; // admin must still use a valid client page key
      return { ok, isAdmin: true, clientFromKey: ok ? clientFromKey : null };
    }

    const userClient = getClientForUser(lower);
    if (!userClient) return { ok: false, isAdmin: false, clientFromKey: null };

    const ok = clientToKeys[userClient]?.has(secureKey) || false;
    return { ok, isAdmin: false, clientFromKey: ok ? userClient : null };

  } catch (err) {
    console.error('Secure key verification error:', err);
    return { ok: false, isAdmin: false, clientFromKey: null };
  }
}
