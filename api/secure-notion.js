// api/secure-notion.js - Secure user-specific API
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;
  const AUTH_SECRET = process.env.AUTH_SECRET;
  
  if (!NOTION_TOKEN || !DATABASE_ID || !AUTH_SECRET) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  // Get parameters
  const { wixUserId, userEmail, authHash, action } = req.query;
  
  // SECURITY: Verify the request comes from authorized user
  if (!verifyUserAuth(wixUserId, userEmail, authHash, AUTH_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized access' });
  }
  
  // SECURITY: Get the client name for this specific user
  const clientName = getClientForUser(userEmail);
  if (!clientName) {
    return res.status(403).json({ error: 'No client access assigned to this user' });
  }
  
  try {
    if (action === 'properties') {
      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Notion API error: ${response.status}`);
      }
      
      const data = await response.json();
      res.status(200).json(data);
      
    } else {
      // Query database - user can ONLY access their assigned client
      const requestBody = {
        page_size: 100,
        filter: {
          property: "Client",
          select: {
            equals: clientName // This is determined server-side, not from client
          }
        }
      };
      
      // Add additional filters if provided
      const { filterProperty, filterCondition, filterValue } = req.query;
      if (filterProperty && filterCondition && filterProperty !== "Client") {
        const additionalFilter = buildFilter(filterProperty, filterCondition, filterValue);
        requestBody.filter = {
          and: [requestBody.filter, additionalFilter]
        };
      }
      
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
      
      // Return data with client info for verification
      res.status(200).json({
        ...data,
        authorizedClient: clientName,
        userEmail: userEmail
      });
    }
    
  } catch (error) {
    console.error('Secure API error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

function verifyUserAuth(wixUserId, userEmail, authHash, secret) {
  try {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / (1000 * 60 * 15)); // 15-minute window
    const expectedHash = crypto
      .createHmac('sha256', secret)
      .update(`${wixUserId}:${userEmail}:${timestamp}`)
      .digest('hex');
    
    return authHash === expectedHash;
  } catch (error) {
    return false;
  }
}

function getClientForUser(userEmail) {
  // SECURE SERVER-SIDE MAPPING - Update these with your actual user emails
  const userClientMap = {
    'edcarlile@me.com': 'King Ed',           // Replace with actual email
    'mrkieranbeardmore@gmail.com': 'Kieran "KES" Beardmore',      // Replace with actual email  
    'willvrocks@gmail.com': 'Will Vaughan',     // Replace with actual email
    'lindenjaymusic@gmail.com': 'Linden Jay',     // Replace with actual email 
    'nick@fastfriends.co': 'Admin',           // Admin user
    
    // Add more user-to-client mappings here:
    // 'user@email.com': 'Client Name',
  };
  
  return userClientMap[userEmail.toLowerCase()] || null;
}

function buildFilter(property, condition, value) {
  const filter = { property: property };
  
  switch (condition) {
    case 'equals':
      filter.rich_text = { equals: value };
      break;
    case 'contains':
      filter.rich_text = { contains: value };
      break;
    case 'checkbox':
      filter.checkbox = { equals: true };
      break;
    default:
      filter.rich_text = { contains: value };
  }
  
  return filter;
}
