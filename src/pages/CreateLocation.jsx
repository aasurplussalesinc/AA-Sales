import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import QRCode from 'qrcode';
import { OrgDB as DB } from '../orgDb';

export default function CreateLocation() {
  const navigate = useNavigate();
  const location = useLocation();
  const scannedQR = location.state?.qrCode;

  // Dropdown options
  const warehouses = ['W1', 'W2', 'W3', 'W4'];
  const racks = ['1', '2', '3'];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const shelves = ['1', '2', '3'];

  const [warehouse, setWarehouse] = useState('W1');
  const [rack, setRack] = useState('1');
  const [letter, setLetter] = useState('A');
  const [shelf, setShelf] = useState('1');
  const [qrCode, setQrCode] = useState(scannedQR || '');
  const [qrImage, setQrImage] = useState('');

  useEffect(() => {
    if (qrCode) generateQRImage();
  }, [qrCode]);

  const getLocationCode = () => {
    return `${warehouse}-R${rack}-${letter}-${shelf}`;
  };

  const generateQR = () => {
    const code = `LOC-${getLocationCode()}-${Date.now()}`;
    setQrCode(code);
  };

  const generateQRImage = async () => {
    try {
      const url = await QRCode.toDataURL(qrCode, { width: 300 });
      setQrImage(url);
    } catch (err) {
      console.error(err);
    }
  };

  const create = async () => {
    const code = qrCode || generateQR();
    const locationCode = getLocationCode();
    
    await DB.createLocation({
      warehouse,
      rack,
      letter,
      shelf,
      locationCode,
      qrCode: code,
      inventory: {}
    });

    alert('Location created!');
    navigate('/locations');
  };

  const printQR = () => {
    const locationCode = getLocationCode();
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>QR Code - ${locationCode}</title>
          <style>
            body { 
              display: flex; 
              flex-direction: column; 
              align-items: center; 
              justify-content: center; 
              padding: 40px;
              font-family: Arial, sans-serif;
            }
            h1 { font-size: 32px; margin-bottom: 20px; }
            img { border: 3px solid #000; padding: 20px; }
            p { margin-top: 15px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <h1>${locationCode}</h1>
          <img src="${qrImage}" />
          <p>${qrCode}</p>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  return (
    <div className="page">
      <div className="header">
        <h1>Create Location</h1>
        <p>Set up a new warehouse location</p>
      </div>

      <label className="label">Warehouse</label>
      <select
        className="input"
        value={warehouse}
        onChange={e => setWarehouse(e.target.value)}
      >
        {warehouses.map(w => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>

      <label className="label">Rack</label>
      <select
        className="input"
        value={rack}
        onChange={e => setRack(e.target.value)}
      >
        {racks.map(r => (
          <option key={r} value={r}>Rack {r}</option>
        ))}
      </select>

      <label className="label">Letter</label>
      <select
        className="input"
        value={letter}
        onChange={e => setLetter(e.target.value)}
      >
        {letters.map(l => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      <label className="label">Shelf</label>
      <select
        className="input"
        value={shelf}
        onChange={e => setShelf(e.target.value)}
      >
        {shelves.map(s => (
          <option key={s} value={s}>Shelf {s}</option>
        ))}
      </select>

      <div className="card" style={{marginTop: 20, textAlign: 'center'}}>
        <h3 style={{color: '#2196F3', fontSize: 28}}>
          {getLocationCode()}
        </h3>
      </div>

      {!qrCode && (
        <button className="btn" onClick={generateQR}>
          Generate QR Code
        </button>
      )}

      {qrImage && (
        <div className="qr-container">
          <img src={qrImage} alt="QR Code" style={{maxWidth: '100%'}} />
          <p style={{fontSize: 12, color: '#999', marginTop: 10}}>{qrCode}</p>
          <button className="btn" onClick={printQR} style={{marginTop: 15}}>
            🖨️ Print QR Code
          </button>
        </div>
      )}

      <button className="btn btn-success" onClick={create}>
        Create Location
      </button>

      <button
        className="btn"
        onClick={() => navigate('/locations')}
        style={{background: '#999', marginTop: 10}}
      >
        Cancel
      </button>
    </div>
  );
}
