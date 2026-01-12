import { useState } from 'react';
import * as XLSX from 'xlsx';
import { OrgDB as DB } from '../orgDb';

export default function ImportData() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImporting(true);
    setResult(null);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);

      // Map your Excel columns to database format
      const items = rows.map(row => ({
        name: row.Item || '',
        partNumber: row['Part Number'] || '',
        location: row.Location || '',
        price: parseFloat(row.Price) || 0,
        stock: parseInt(row.Stock) || 0
      }));

      const count = await DB.importItems(items);
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
        <p>Upload your Excel file</p>
      </div>

      <div className="card">
        <h3>Upload Excel File</h3>
        <p style={{color: '#666', fontSize: 14, marginBottom: 15}}>
          Expected columns: Item, Part Number, Location, Price, Stock
        </p>
        
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
          disabled={importing}
          style={{width: '100%', padding: 10}}
        />

        {importing && (
          <div className="loading">
            <p>Importing... Please wait...</p>
          </div>
        )}

        {result && (
          <div className="card" style={{
            marginTop: 15,
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
        <h3>Quick Stats</h3>
        <p style={{color: '#666', fontSize: 14}}>
          After importing, your items will be searchable when counting inventory.
          You can re-import to update prices and stock levels.
        </p>
      </div>
    </div>
  );
}
