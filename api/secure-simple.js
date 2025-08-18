// api/secure-simple.js - Simplified secure version
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
  
  const { userEmail, action } = req.query;
  
  if (!userEmail) {
    return res.status(400).json({ error: 'Missing userEmail' });
  }
  
  // Get client for this user
  const clientName = getClientForUser(userEmail);
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
      // Query database with client filter
      const requestBody = {
        page_size: 100,
        filter: {
          property: "Client",
          select: {
            equals: clientName
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
      
      res.status(200).json({
        ...data,
        authorizedClient: clientName,
        userEmail: userEmail
      });
    }
    
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
}

function getClientForUser(userEmail) {
  const userClientMap = {
    'nicksayshey@gmail.com': 'Linden Jay',
    'nick@sayshey.com': 'King Ed',           // Your actual email
    'client.a@company.com': 'Client A',      
    'client.b@business.com': 'Client B',
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
