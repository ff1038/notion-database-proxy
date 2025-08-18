// api/client-data.js - With secure key authentication
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
  
  // Get client for this authenticated user
  const clientName = getClientForUser(userEmail);
  if (!clientName) {
    return res.status(403).json({ error: 'No client access for user: ' + userEmail });
  }
  
  try {
    const requestBody = {
      page_size: 100,
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
    
    res.status(200).json({
      ...data,
      authorizedClient: clientName,
      userEmail: userEmail
    });
    
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
}

function verifySecureKey(userEmail, secureKey, timestamp) {
  try {
    // Define secure keys for each user
    const userSecureKeys = {
      'nick@sayshey.com': 'ke-' + Buffer.from('king-ed-2025').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'client.a@company.com': 'ca-' + Buffer.from('client-a-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      'client.b@business.com': 'cb-' + Buffer.from('client-b-2024').toString('base64').replace(/[^a-zA-Z0-9]/g, ''),
      // Add more clients here with unique keys
    };
    
    const expectedKey = userSecureKeys[userEmail.toLowerCase()];
    
    if (!expectedKey) {
      console.log('No secure key defined for user:', userEmail);
      return false;
    }
    
    if (secureKey !== expectedKey) {
      console.log('Secure key mismatch for user:', userEmail);
      return false;
    }
    
    // Check if timestamp is recent (within 1 hour for security)
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp);
    const timeDiff = now - requestTime;
    
    if (timeDiff > 3600 || timeDiff < -300) { // 1 hour window, 5 min future tolerance
      console.log('Timestamp outside valid window');
      return false;
    }
    
    console.log(`Valid secure access for: ${userEmail}`);
    return true;
    
  } catch (error) {
    console.error('Secure key verification error:', error);
    return false;
  }
}

function getClientForUser(userEmail) {
  const userClientMap = {
    'nick@sayshey.com': 'King Ed',
    'client.a@company.com': 'Client A',      
    'client.b@business.com': 'Client B',
  };
  
  return userClientMap[userEmail?.toLowerCase()] || null;
}
