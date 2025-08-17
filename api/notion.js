// api/notion.js - Auto-loading with environment variables
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  // Get credentials from environment variables (secure)
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;
  
  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ 
      error: 'Server configuration error: Missing credentials' 
    });
  }
  
  // Get parameters
  const { clientName, action } = req.query;
  
  try {
    if (action === 'properties') {
      // Get database schema
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
      // For client data queries, clientName is required
      if (!clientName) {
        return res.status(400).json({ 
          error: 'Client name is required for data access' 
        });
      }
      
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
      
      // Add additional filters if provided
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
      
      // Add column selection if provided
      const { columns } = req.query;
      if (columns) {
        // Parse column list (comma-separated)
        const columnList = columns.split(',').map(col => col.trim());
        // Note: Notion API doesn't support selecting specific properties in query,
        // but we'll filter on the response side
        requestBody._selectedColumns = columnList;
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
          return false;
        });
        
        // Filter columns if specified
        if (columns) {
          const columnList = columns.split(',').map(col => col.trim());
          data.results = data.results.map(record => {
            const filteredRecord = {
              id: record.id,
              properties: {}
            };
            
            // Always include Client column for security
            if (record.properties.Client) {
              filteredRecord.properties.Client = record.properties.Client;
            }
            
            // Include only requested columns
            columnList.forEach(col => {
              if (record.properties[col]) {
                filteredRecord.properties[col] = record.properties[col];
              }
            });
            
            return filteredRecord;
          });
          
          // Add column order information to response
          data._columnOrder = columnList;
        }
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
