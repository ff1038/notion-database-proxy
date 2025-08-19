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
    const { userEmail, secureKey, timestamp, client: clientParam } = req.query || {};
    if (!userEmail || !secureKey || !timestamp) {
      return res.status(401).json({ error: 'Missing authentication parameters' });
    }

    // --- Verify key (returns { ok, isAdmin, clientFromKey })
    const { ok, isAdmin, clientFromKey } = verifySecureKey(userEmail, secureKey, timestamp);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid access credentials' });
    }

    // --- Resolve which client’s data to show
    // Priority:
    //  1) explicit ?client=... (allowed for admin only; for non-admin must match their mapping)
    //  2) infer from secureKey (works for admin and non-admin if mapping exists)
    //  3) fallback to user mapping (non-admin only)
    let clientName = null;

    const userMappedClient = getClientForUser(userEmail); // null for admin; defined for members
    const clean = s => (s || '').trim();

    if (clean(clientParam)) {
      if (isAdmin) {
        clientName = clean(clientParam);
      } else {
        // non-admin may only request their own client
        if (clean(clientParam) !== userMappedClient) {
          return res.status(403).json({ error: 'Client access denied for user' });
        }
        clientName = userMappedClient;
      }
    } else if (clientFromKey) {
      // Use client inferred from the secureKey mapping (works on per-page keys)
      clientName = clientFromKey;
      if (!isAdmin && userMappedClient && clientName !== userMappedClient) {
        return res.status(403).json({ error: 'Client access denied for user' });
      }
    } else {
      // last resort: non-admin’s mapping
      if (!isAdmin) {
        if (!userMappedClient) return res.status(403).json({ error: 'No client access for user' });
        clientName = userMappedClient;
      } else {
        // Admin without client hint: this page didn’t pass a client and key didn’t identify one
        return res.status(400).json({ error: 'Admin access requires client context (add ?client=...)' });
      }
    }

    console.log('Resolved -> isAdmin:', isAdmin, '| clientName:', clientName);

    // --- Notion query with pagination (always filtered to clientName)
    const baseRequestBody = {
      page_size: 50,
      filter: {
        property: 'Client',
        select: { equals: clientName }
      }
    };

    let allResults = [];
    let hasMore = true;
    let nextCursor = null;
    let pageCount = 0;

    while (hasMore && pageCount < 10) { // up to 500 rows
      pageCount++;
      const requestBody = { ...baseRequestBody };
      if (nextCursor) requestBody.start_cursor = nextCursor;

      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
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

    // --- Resolve first related page title for relation props (optional)
    if (allResults.length > 0) {
      let count = 0;
      for (let i = 0; i < allResults.length; i++) {
        const record = allResults[i];
        for (const [key, property] of Object.entries(record.properties || {})) {
          if (property.type === 'relation' && Array.isArray(property.relation) && property.relation.length > 0) {
            try {
              count++;
              const firstRelation = property.relation[0];
              const pageResp = await fetch(`https://api.notion.com/v1/pages/${firstRelation.id}`, {
                headers: {
                  'Authorization': `Bearer ${NOTION_TOKEN}`,
                  'Notion-Version': '2022-06-28'
                }
              });
              if (pageResp.ok) {
                const relPage = await pageResp.json();
                const titleProp = Object.values(relPage.properties).find(p => p.type === 'title');
                if (titleProp?.title?.length) {
                  property.relation_titles = titleProp.title[0].plain_text;
                }
              }
              if (count % 5 === 0) await new Promise(r => setTimeout(r, 100));
            } catch (e) {
              console.error(`Relation fetch error for ${key}:`, e?.message || e);
            }
          }
        }
      }
    }

    const columnConfig = getUniversalColumnConfig();

    return res.status(200).json({
      results: allResults,
      authorizedClient: clientName,
      userEmail: userEmail,
      isAdmin,
      columnOrder: columnConfig.columns,
      columnHeaders: columnConfig.columnHeaders,
      debug: {
        recordCount: allResults.length,
        timestamp: new Date().toISOString()
      },
      metadata: {
        incomeTypes: [...new Set(allResults.map(r => r.properties?.['Income Type']?.select?.name).filter(Boolean))],
        currencies:  [...new Set(allResults.map(r => r.properties?.['Currency']?.select?.name).filter(Boolean))]
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

// Column config stays the same as your version
function getUniversalColumnConfig() {
  return {
    columns: [
      'Invoice date','Inv #','Vendor1','Description','Income Type',
      'Net','Gross','Currency','Paid in date','Amount Received',
      'Currency (receipt)','Adjustments','Net Commissionable',
      'Commission %','Mgmt Commission','Mgmt Inv #'
    ],
    columnHeaders: {
      'Invoice date':'Date (Inv/Stmt)','Inv #':'Invoice #','Vendor1':'Vendor','Description':'Description',
      'Income Type':'Income Type','Net':'Net Amount','Gross':'Gross Amount','Currency':'Currency (Inv/Stmt)',
      'Paid in date':'Paid In Date','Amount Received':'Amount Received','Currency (receipt)':'Currency (Received)',
      'Adjustments':'Adjustments','Net Commissionable':'Net Commissionable','Commission %':'Commission %',
      'Mgmt Commission':'Mgmt Commission','Mgmt Inv #':'Mgmt Inv #'
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

    // Map each client to the exact key the Wix page generates for that client
    // (prefixes mirror your earlier scheme)
    const clientKeyMap = {
      'King Ed':               'ke-' + Buffer.from('king-ed-2025').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'Linden Jay':            'lj-' + Buffer.from('client-a-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'Will Vaughan':          'wv-' + Buffer.from('client-a-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'Tiggs':                 'nf-' + Buffer.from('client-a-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'Kieran "KES" Beardmore':'kb-' + Buffer.from('client-b-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, '')
    };

    // Map user → client (non-admin)
    const userClient = getClientForUser(lower);

    // Admin?
    const isAdmin = lower === 'nick@sayshey.com';

    // Validate timestamp
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    const drift = now - requestTime;
    if (Number.isNaN(requestTime) || drift > 3600 || drift < -300) {
      return { ok: false, isAdmin: false, clientFromKey: null };
    }

    // Reverse lookup: which client does this secureKey belong to?
    let clientFromKey = null;
    for (const [clientName, key] of Object.entries(clientKeyMap)) {
      if (key === secureKey) { clientFromKey = clientName; break; }
    }

    if (isAdmin) {
      // Admin key must be one of the known *client page* keys
      // (so the admin can load any client page, but not some random key)
      const ok = !!clientFromKey;
      return { ok, isAdmin: true, clientFromKey: ok ? clientFromKey : null };
    }

    // Non-admin: secureKey must match the key of their mapped client
    if (!userClient) return { ok: false, isAdmin: false, clientFromKey: null };
    const expectedKey = clientKeyMap[userClient];
    const ok = (secureKey === expectedKey);
    return { ok, isAdmin: false, clientFromKey: ok ? userClient : null };

  } catch (err) {
    console.error('Secure key verification error:', err);
    return { ok: false, isAdmin: false, clientFromKey: null };
  }
}
