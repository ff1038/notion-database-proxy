// api/client-data.js - Same columns for all clients
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;
  
  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  const { userEmail, secureKey, timestamp } = req.query;
  
  if (!userEmail || !secureKey || !timestamp) {
    return res.status(401).json({ error: 'Missing authentication parameters' });
  }
  
  // Verify the secure key for this user
  if (!verifySecureKey(userEmail, secureKey, timestamp)) {
    return res.status(401).json({ error: 'Invalid access credentials' });
  }
  
  // Get client for this user
  const clientName = getClientForUser(userEmail);
  if (!clientName) {
    return res.status(403).json({ error: 'No client access for user: ' + userEmail });
  }
  
  try {
    const requestBody = {
      page_size: 20,
      filter: {
        property: "Client",
        select: {
          equals: clientName
        }
      }
    };
    
    console.log(`Secure access granted: ${clientName}, user: ${userEmail}`);
    
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
      throw new Error(`Notion API error: ${response.status}`);
    }
    
    const data = await response.json();

    // Add this after fetching the main data
if (data.results) {
  // Process relation fields to get more meaningful data
  data.results = await Promise.all(data.results.map(async (record) => {
    const processedRecord = { ...record };
    
    // Process each property
    for (const [key, property] of Object.entries(record.properties)) {
      if (property.type === 'relation' && property.relation.length > 0) {
        // For relation fields, you could fetch the related page titles
        // This requires additional API calls, so use sparingly
        try {
          const relatedTitles = await Promise.all(
            property.relation.slice(0, 3).map(async (rel) => { // Limit to first 3
              const pageResponse = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, {
                headers: {
                  'Authorization': `Bearer ${NOTION_TOKEN}`,
                  'Notion-Version': '2022-06-28'
                }
              });
              
              if (pageResponse.ok) {
                const pageData = await pageResponse.json();
                // Extract title from the page
                const titleProperty = Object.values(pageData.properties).find(p => p.type === 'title');
                if (titleProperty && titleProperty.title.length > 0) {
                  return titleProperty.title[0].plain_text;
                }
              }
              return 'Related Item';
            })
          );
          
          // Store the titles in a custom field
          processedRecord.properties[key + '_titles'] = {
            type: 'rich_text',
            rich_text: [{ plain_text: relatedTitles.join(', ') + (property.relation.length > 3 ? '...' : '') }]
          };
        } catch (error) {
          console.error('Error fetching relation data:', error);
        }
      }
    }
    
    return processedRecord;
  }));
}
    
    // Apply universal column configuration
    const columnConfig = getUniversalColumnConfig();
    
    if (data.results && columnConfig.columns) {
      data.results = data.results.map(record => {
        const filteredRecord = {
          id: record.id,
          properties: {}
        };
        
        // Add properties in the specified order
        columnConfig.columns.forEach(columnName => {
          if (record.properties[columnName]) {
            filteredRecord.properties[columnName] = record.properties[columnName];
          }
        });
        
        return filteredRecord;
      });
    }
    
    res.status(200).json({
      ...data,
      authorizedClient: clientName,
      userEmail: userEmail,
      columnOrder: columnConfig.columns,
      columnHeaders: columnConfig.columnHeaders
    });
    
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
}

function getUniversalColumnConfig() {
  // Define the columns and headers that ALL clients will see
  return {
    columns: [
      'Invoice date',           // Adjust these to match your actual Notion columns
      'Inv #',
      'Vendor',
      'Description',
      'Income Type',
      'Net',
      'Gross',
      'Currency',
      'Paid in date',
      'Amount Received',
      'Currency (receipt)',
      'Adjustments',
      'Net Commissionable',
      'Commission %',
      'Mgmt Commission',
      'Mgmt Inv #'
    ],
    columnHeaders: {
      'Name': 'Date (Inv/Stmt)',
      'Date Created': 'Invoice #',
      'Priority': 'Vendor',
      'Description': 'Description',
      'Assigned To': 'Income Type',
      'Assigned To': 'Net Amount',
      'Assigned To': 'Gross Amount',
      'Assigned To': 'Currency (Inv/Stmt)',
      'Assigned To': 'Paid In Date',
      'Assigned To': 'Amount Received',
      'Assigned To': 'Currency (Received)',
      'Assigned To': 'Adjustments',
      'Assigned To': 'Net Commissionable',
      'Assigned To': 'Commission %',
      'Assigned To': 'Mgmt Commission',
      'Assigned To': 'Mgmt Inv #'
    
    }
  };
}

function getClientForUser(userEmail) {
  const userClientMap = {
    'nick@sayshey.com': 'King Ed',
    'client.a@company.com': 'Client A',      
    'client.b@business.com': 'Client B',
  };
  
  return userClientMap[userEmail?.toLowerCase()] || null;
}

function verifySecureKey(userEmail, secureKey, timestamp) {
  try {
    const userSecureKeys = {
      'nick@sayshey.com': 'ke-' + Buffer.from('king-ed-2025').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'client.a@company.com': 'ca-' + Buffer.from('client-a-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'client.b@business.com': 'cb-' + Buffer.from('client-b-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
    };
    
    const expectedKey = userSecureKeys[userEmail.toLowerCase()];
    
    if (!expectedKey || secureKey !== expectedKey) {
      return false;
    }
    
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp);
    const timeDiff = now - requestTime;
    
    if (timeDiff > 3600 || timeDiff < -300) {
      return false;
    }
    
    return true;
    
  } catch (error) {
    console.error('Secure key verification error:', error);
    return false;
  }
}
