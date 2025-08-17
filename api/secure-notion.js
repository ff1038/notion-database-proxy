// api/secure-notion.js - Secure version for separate pages
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
  const { userEmail, authToken, action } = req.query;
  
  if (!userEmail || !authToken) {
    return res.status(400).json({ error: 'Missing userEmail or authToken' });
  }
  
  // SECURITY: Verify the authentication token
  if (!verifyAuthToken(authToken, userEmail, AUTH_SECRET)) {
    return res.status(401).json({ error: 'Invalid authentication token' });
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

function verifyAuthToken(authToken, userEmail, secret) {
  try {
    // Verify the token matches what we expect for this user
    const timestamp = Math.floor(Date.now() / (1000 * 60 * 30)); // 30-minute window
    const expectedToken = generateAuthToken(userEmail, timestamp, secret);
    
    // Also check previous time window for clock drift
    const previousTimestamp = timestamp - 1;
    const previousToken = generateAuthToken(userEmail, previousTimestamp, secret);
    
    return authToken === expectedToken || authToken === previousToken;
  } catch (error) {
    console.error('Token verification error:', error);
    return false;
  }
}

function generateAuthToken(userEmail, timestamp, secret) {
  // Simple but secure token generation
  const crypto = require('crypto');
  const payload = `${userEmail}:${timestamp}:${secret}`;
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

function getClientForUser(userEmail) {
  // SECURE SERVER-SIDE MAPPING - Update these with your actual user emails
  const userClientMap = {
    'nick@sayshey.com': 'King Ed',
    'nicksayshey@gmai.com': 'Linden Jay',      
    'client.b@business.com': 'Client B',
    
    // Add more user-to-client mappings here:
    // 'user@email.com': 'Client Name',
  };
  
  console.log(`Looking up client for user: ${userEmail}`);
  const client = userClientMap[userEmail?.toLowerCase()] || null;
  console.log(`Found client: ${client}`);
  
  return client;
}

function buildFilter(property, condition, value) {
  const filter = { property: property };
  
  switch (condition) {
    case 'equals':
      filter.rich_text = { equals: value };
      break;
