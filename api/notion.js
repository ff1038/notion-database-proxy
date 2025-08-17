// api/notion.js - Secure client-specific version
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  // Get parameters
  const { databaseId, token, clientName, action } = req.query;
  
  if (!databaseId || !token) {
    return res.status(400).json({ 
      error: 'Missing databaseId or token parameters' 
    });
  }
  
  // For client-specific queries, clientName is required
  if (!action && !clientName) {
    return res.status(400).json({ 
      error: 'Client name is required for data access' 
    });
  }
  
  try {
    if (action === 'properties') {
      // Get database schema
      const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Notion API error: ${response.status}`);
      }
      
      const data = await response.json();
      res.status(200).json(data);
      
    } else {
      // Query database with MANDATORY client filter
      const requestBody = {
        page_size: 100,
        filter: {
          property: "Client",
          select: {
            equals: clientName
          }
        }
      };
      
      // Add additional filters if provided (combined with client filter)
      const { filterProperty, filterCondition, filterValue } = req.query;
      if (filterProperty && filterCondition && filterProperty !== "Client") {
        const additionalFilter = buildFilter(filterProperty, filterCondition, filterValue);
        requestBody.filter = {
          and: [
            requestBody.filter, // Client filter (ALWAYS required)
            additionalFilter    // Additional filter
          ]
        };
      }
      
      // Add sorting if provided
      const { sortProperty, sortDirection } = req.query;
      if (sortProperty) {
        requestBody.sorts = [{
          property: sortProperty,
          direction: sortDirection || 'ascending'
        }];
      }
      
      const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Notion API error: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json();
      
      // SECURITY: Double-check that all returned records belong to the requested client
      if (data.results) {
        data.results = data.results.filter(record => {
          const clientProperty = record.properties.Client;
          if (clientProperty && clientProperty.select) {
            return clientProperty.select.name === clientName;
          }
          return false; // Exclude records without proper client assignment
        });
      }
      
      res.status(200).json(data);
    }
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Access denied or invalid parameters'
    });
  }
}

function buildFilter(property, condition, value) {
  const filter = {
    property: property
  };
  
  switch (condition) {
    case 'equals':
      // Handle different property types
      if (property.toLowerCase().includes('date')) {
        filter.date = { equals: value };
      } else if (property.toLowerCase().includes('number') || property.toLowerCase().includes('price')) {
        filter.number = { equals: parseFloat(value) || 0 };
      } else {
        filter.rich_text = { equals: value };
      }
      break;
      
    case 'contains':
      filter.rich_text = { contains: value };
      break;
      
    case 'does_not_contain':
      filter.rich_text = { does_not_contain: value };
      break;
      
    case 'starts_with':
      filter.rich_text = { starts_with: value };
      break;
      
    case 'checkbox':
      filter.checkbox = { equals: true };
      break;
      
    case 'not_checkbox':
      filter.checkbox = { equals: false };
      break;
      
    case 'is_empty':
      filter.rich_text = { is_empty: true };
      break;
      
    case 'is_not_empty':
      filter.rich_text = { is_not_empty: true };
      break;
      
    default:
      filter.rich_text = { contains: value };
  }
  
  return filter;
}
