// api/simple-notion.js - Simplified version for testing
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
  
  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  // Get parameters
  const { userEmail, action } = req.query;
  
  // Simple user mapping (for testing)
  const clientName = getSimpleClientForUser(userEmail);
  if (!clientName) {
    return res.status(403).json({ error: 'No client access for user: ' + userEmail });
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
      // Query database
      const requestBody = {
        page_size: 100,
        filter: {
          property: "Client",
          select: {
            equals: clientName
          }
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
      
      if (!response.ok) {
        throw new Error(`Notion API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      res.status(200).json({
        ...data,
        authorizedClient: clientName,
        userEmail: userEmail
      });
    }
    
  } catch (error) {
    console.error('Simple API error:', error);
    res.status(500).json({ error: error.message });
  }
}

function getSimpleClientForUser(userEmail) {
  const userClientMap = {
    'kinged@gmail.com': 'King Ed',
    'nick@sayshey.com': 'King Ed',  // For testing
    // Add your actual mappings here
  };
  
  return userClientMap[userEmail?.toLowerCase()] || null;
}
