import { useState } from 'react';
import * as XLSX from 'xlsx';
import { OrgDB as DB } from '../orgDb';

export default function ImportData() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImporting(true);
    setResult(null);
    setPreview(null);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);

      if (rows.length === 0) {
        throw new Error('No data found in file');
      }

      // Detect column format and map accordingly
      const firstRow = rows[0];
      const columns = Object.keys(firstRow);
      
      // Map columns flexibly - support multiple formats
      const items = rows.map(row => {
        const item = {
          // Try multiple possible column names for each field
          partNumber: row['SKU'] || row['Part Number'] || row['PartNumber'] || row['partNumber'] || '',
          name: row['Item Name'] || row['Item'] || row['Name'] || row['name'] || '',
          category: row['Category'] || row['category'] || '',
          stock: parseInt(row['Quantity'] || row['Stock'] || row['stock'] || row['Qty']) || 0,
          price: parseFloat(row['Price'] || row['price'] || row['Unit Price']) || 0,
          location: row['Location'] || row['location'] || '',
          weight: parseFloat(row['Est. Weight (lbs)'] || row['Weight'] || row['weight'] || row['Weight (lbs)']) || null,
        };
        
        // Only include weight if it has a value
        if (!item.weight) delete item.weight;
        
        return item;
      });

      // Filter out items with no name
      const validItems = items.filter(i => i.name);
      
      // Show preview
      setPreview({
        total: rows.length,
        valid: validItems.length,
        sample: validItems.slice(0, 5),
        columns: columns
      });

      const count = await DB.importItems(validItems);
      setResult({ success: true, count });
    } catch (error) {
      setResult({ success: false, error: error.message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <div className="header">
        <h1>Import Inventory</h1>
        <p>Upload Excel or CSV file</p>
      </div>

      <div className="card">
        <h3>Upload File</h3>
        <p style={{color: '#666', fontSize: 14, marginBottom: 15}}>
          Supported columns: SKU, Item Name, Category, Quantity, Price, Location, Weight
        </p>
        
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          disabled={importing}
          style={{width: '100%', padding: 10}}
        />

        {importing && (
          <div style={{ marginTop: 15, padding: 15, background: '#e3f2fd', borderRadius: 8 }}>
            <p>⏳ Importing... Please wait...</p>
          </div>
        )}

        {preview && !result && (
          <div style={{ marginTop: 15, padding: 15, background: '#f5f5f5', borderRadius: 8 }}>
            <p><strong>Preview:</strong> Found {preview.total} rows, {preview.valid} valid items</p>
            <p style={{ fontSize: 12, color: '#666' }}>Columns detected: {preview.columns.join(', ')}</p>
          </div>
        )}

        {result && (
          <div style={{
            marginTop: 15,
            padding: 15,
            borderRadius: 8,
            background: result.success ? '#e8f5e9' : '#ffebee',
            color: result.success ? '#2e7d32' : '#c62828'
          }}>
            {result.success ? (
              <p>✅ Successfully imported {result.count} items!</p>
            ) : (
              <p>❌ Import failed: {result.error}</p>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Import Notes</h3>
        <ul style={{color: '#666', fontSize: 14, lineHeight: 1.8}}>
          <li><strong>Weight field</strong> will be saved and used for contract cost calculations</li>
          <li>Items are matched by <strong>SKU/Part Number</strong> - existing items will be updated</li>
          <li>Items without a name will be skipped</li>
          <li>Supports both .xlsx and .csv files</li>
        </ul>
      </div>
    </div>
  );
}
