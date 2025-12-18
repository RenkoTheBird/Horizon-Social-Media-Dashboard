// csv-parser.js
// Simple CSV parser that handles quoted fields with newlines

export function parseCSV(csvText) {
  const lines = [];
  const rows = [];
  let currentLine = '';
  let inQuotes = false;
  
  // First, handle quoted fields that may contain newlines
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentLine += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        currentLine += char;
      }
    } else if (char === '\n' && !inQuotes) {
      // End of line (not in quotes)
      lines.push(currentLine);
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
  
  // Add the last line if there's any content
  if (currentLine.trim()) {
    lines.push(currentLine);
  }
  
  // Parse each line into fields
  for (const line of lines) {
    if (!line.trim()) continue;
    
    const fields = [];
    let currentField = '';
    let inFieldQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === '"') {
        if (inFieldQuotes && nextChar === '"') {
          // Escaped quote
          currentField += '"';
          i++;
        } else {
          // Toggle quote state
          inFieldQuotes = !inFieldQuotes;
        }
      } else if (char === ',' && !inFieldQuotes) {
        // Field separator
        fields.push(currentField.trim());
        currentField = '';
      } else {
        currentField += char;
      }
    }
    
    // Add the last field
    fields.push(currentField.trim());
    rows.push(fields);
  }
  
  return rows;
}

export function csvToObjects(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return [];
  
  const headers = rows[0];
  const objects = [];
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length !== headers.length) {
      // Skip malformed rows
      continue;
    }
    
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let value = row[j];
      // Remove surrounding quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/""/g, '"');
      }
      obj[headers[j]] = value;
    }
    objects.push(obj);
  }
  
  return objects;
}

