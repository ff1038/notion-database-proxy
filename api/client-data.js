// api/client-data.js  (CommonJS)

module.exports = async function handler(req, res) {
  console.log('=== API HANDLER START ===');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    console.log('1. Checking environment variables...');
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID  = process.env.NOTION_DATABASE_ID;

    console.log('NOTION_TOKEN exists:', !!NOTION_TOKEN);
    console.log('DATABASE_ID exists:', !!DATABASE_ID);

    if (!NOTION_TOKEN || !DATABASE_ID) {
      console.log('Missing environment variables');
      return res.status(500).json({ error: 'Server configuration error - missing environment variables' });
    }

    console.log('2. Checking request parameters...');
    const { userEmail, secureKey, timestamp } = req.query || {};
    console.log('userEmail:', userEmail);
    console.log('secureKey exists:', !!secureKey);
    console.log('timestamp:', timestamp);

    if (!userEmail || !secureKey || !timestamp) {
      console.log('Missing authentication parameters');
      return res.status(401).json({ error: 'Missing authentication parameters' });
    }

    console.log('3. Verifying secure key...');
    if (!verifySecureKey(userEmail, secureKey, timestamp)) {
      console.log('Invalid secure key');
      return res.status(401).json({ error: 'Invalid access credentials' });
    }

    console.log('4. Getting client for user...');
    const clientName = getClientForUser(userEmail);
    console.log('Client name:', clientName);

    if (!clientName) {
      console.log('No client found for user');
      return res.status(403).json({ error: 'No client access for user: ' + userEmail });
    }

    console.log('5. Making Notion API request (single page, 15 rows while testing)...');

    // --- Fetch up to 15 rows for this client (testing mode) ---
    const requestBody = {
      page_size: 15,
      filter: {
        property: 'Client',
        select: { equals: clientName }
      }
    };

    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    console.log('Notion response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notion API error:', errorText);
      return res.status(500).json({ error: `Notion API error: ${response.status}`, details: errorText });
    }

    const pageData = await response.json();
    const allResults = pageData.results || [];

    console.log('6. Total records retrieved:', allResults.length);

    // --- OPTIONAL: resolve first title for relation props (kept from your code) ---
    console.log('7. Processing relation fields...');
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
      console.log('Processed relation fields');
    }

    console.log('8. Applying column configuration...');
    const columnConfig = getUniversalColumnConfig();

    console.log('9. Sending response...');
    res.status(200).json({
      results: allResults,
      authorizedClient: clientName,
      userEmail: userEmail,
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

    console.log('=== API HANDLER SUCCESS ===');
  } catch (error) {
    console.error('=== API HANDLER ERROR ===');
    console.error('Error type:', error?.constructor?.name);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    res.status(500).json({
      error: `Server error: ${error?.message || 'unknown'}`,
      type: error?.constructor?.name,
      stack: error?.stack,
      timestamp: new Date().toISOString()
    });
  }
}; // <- IMPORTANT: closes module.exports function
