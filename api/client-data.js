// api/client-data.js - With Wix member authentication
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
  const AUTH_SECRET = process.env.AUTH_SECRET; // Add this to Vercel env vars
  
  if (!NOTION_TOKEN || !DATABASE_ID || !AUTH_SECRET) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  const { userEmail, authToken, timestamp } = req.query;
  
  if (!userEmail || !authToken || !timestamp) {
    return res.status(401).json({ error: 'Missing authentication parameters' });
  }
  
  // Verify the authentication token
  if (!verifyWixMemberToken(userEmail, authToken, timestamp, AUTH_SECRET)) {
    return res.status(401).json({ error: 'Invalid authentication token' });
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
    
    console.log(`Authenticated request: ${clientName}, user: ${userEmail}`);
    
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

function verifyWixMemberToken(userEmail, authToken, timestamp, secret) {
  try {
    // Check if timestamp is recent (within 1 hour)
    const now = Math.floor(Date.now() / 1000);
    const tokenTime = parseInt(timestamp);
    const timeDiff = now - tokenTime;
    
    if (timeDiff > 3600 || timeDiff < 0) { // 1 hour window
      console.log('Token expired or invalid timestamp');
      return false;
    }
    
    // Generate expected token
    const expectedToken = generateMemberToken(userEmail, timestamp, secret);
    
    // Compare tokens
    const isValid = authToken === expectedToken;
    console.log(`Token validation: ${isValid} for user: ${userEmail}`);
    
    return isValid;
  } catch (error) {
    console.error('Token verification error:', error);
    return false;
  }
}

function generateMemberToken(userEmail, timestamp, secret) {
  // Simple but secure token generation
  const crypto = require('crypto');
  const payload = `${userEmail}:${timestamp}:${secret}`;
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

function getClientForUser(userEmail) {
  const userClientMap = {
    'nick@sayshey.com': 'King Ed',
    'client.a@company.com': 'Client A',      
    'client.b@business.com': 'Client B',
  };
  
  return userClientMap[userEmail?.toLowerCase()] || null;
}
