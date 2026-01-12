import { useState, useRef, useEffect } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { OrgDB as DB } from '../orgDb';
import AddInventory from '../components/AddInventory';
import PickInventory from '../components/PickInventory';
import MoveLocation from '../components/MoveLocation';

export default function Scanner() {
  const [qrInput, setQrInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scannedData, setScannedData] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPickModal, setShowPickModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const scannerRef = useRef(null);

  const startCamera = async () => {
    try {
      setScanning(true); // Set scanning first so div renders
      
      // Wait for div to render
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          handleScan(decodedText);
          stopCamera();
        }
      );
    } catch (err) {
      setScanning(false);
      alert('Camera access denied or not available: ' + err.message);
      console.error(err);
    }
  };

  const stopCamera = () => {
    if (scannerRef.current) {
      scannerRef.current.stop();
      setScanning(false);
    }
  };

  const handleScan = async (code) => {
    setQrInput(code);
    
    // Look up in database - could be item or location
    const item = await DB.getItemByPartNumber(code);
    const location = await DB.getLocationByQR(code);
    
    if (item || location) {
      setScannedData({
        code,
        item: item || null,
        location: location || null,
        currentInventory: item ? (item.stock || 0) : 0,
        currentLocation: item ? (item.location || 'Unassigned') : 
                         location ? (location.locationCode || `${location.warehouse}-R${location.rack}-${location.letter}-${location.shelf}`) : 'Unknown'
      });
      setShowPopup(true);
    } else {
      alert('Item or location not found');
    }
  };

  const handleAction = (action) => {
    console.log('handleAction called with:', action);
    console.log('scannedData:', scannedData);
    
    setShowPopup(false);
    
    switch(action) {
      case 'add':
        console.log('Opening Add modal');
        setShowAddModal(true);
        break;
      case 'pick':
        console.log('Opening Pick modal');
        setShowPickModal(true);
        break;
      case 'new_location':
        console.log('Opening Move modal');
        setShowMoveModal(true);
        break;
      default:
        console.log('Unknown action:', action);
    }
  };

  const handleSuccess = () => {
    // Refresh data after successful action
    setScannedData(null);
    alert('Inventory updated successfully!');
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  return (
    <div className="page-content">
      <div style={{background: 'white', padding: 30, borderRadius: 8, maxWidth: 600, margin: '0 auto'}}>
        <h2 style={{marginBottom: 20}}>QR Scanner</h2>
        
        {scanning && (
          <div style={{marginBottom: 20}}>
            <div 
              id="qr-reader" 
              style={{
                width: '100%',
                maxWidth: '500px',
                margin: '0 auto',
                border: '2px solid #2d5f3f',
                borderRadius: '8px',
                overflow: 'hidden'
              }}
            ></div>
          </div>
        )}
        
        {!scanning && (
          <>
            <div style={{marginBottom: 20}}>
              <input
                type="text"
                className="form-input"
                placeholder="Scan or enter QR code..."
                value={qrInput}
                onChange={e => setQrInput(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleScan(qrInput)}
                style={{fontSize: 18, padding: 15}}
                autoFocus
              />
            </div>

            <button
              className="btn btn-primary"
              onClick={() => handleScan(qrInput)}
              style={{width: '100%', padding: 15, fontSize: 16, marginBottom: 10}}
            >
              Manual Scan
            </button>

            <button
              className="btn btn-primary"
              onClick={startCamera}
              style={{width: '100%', padding: 15, fontSize: 16}}
            >
              📷 Start Camera Scanner
            </button>
          </>
        )}

        {scanning && (
          <button
            className="btn btn-danger"
            onClick={stopCamera}
            style={{width: '100%', padding: 15, fontSize: 16}}
          >
            ⏹ Stop Camera
          </button>
        )}

        {!scanning && (
          <div style={{marginTop: 30, padding: 15, background: '#f8f9fa', borderRadius: 6}}>
            <p style={{fontSize: 14, color: '#666'}}>
              Use camera to scan QR codes or enter them manually above.
            </p>
          </div>
        )}
      </div>

      {/* Popup Modal */}
      {showPopup && scannedData && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div style={{
            background: 'white',
            borderRadius: 12,
            padding: 30,
            maxWidth: 500,
            width: '100%',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            <h2 style={{marginBottom: 20, textAlign: 'center'}}>Scanned Successfully</h2>
            
            <div style={{marginBottom: 25}}>
              <div style={{padding: 15, background: '#f8f9fa', borderRadius: 8, marginBottom: 10}}>
                <p style={{fontSize: 14, color: '#666', marginBottom: 5}}>Current Inventory</p>
                <p style={{fontSize: 24, fontWeight: 'bold', color: '#2d5f3f'}}>
                  {scannedData.currentInventory} units
                </p>
              </div>
              
              <div style={{padding: 15, background: '#f8f9fa', borderRadius: 8}}>
                <p style={{fontSize: 14, color: '#666', marginBottom: 5}}>Current Location</p>
                <p style={{fontSize: 20, fontWeight: 'bold', color: '#2d5f3f'}}>
                  {scannedData.currentLocation}
                </p>
              </div>
            </div>

            <div style={{display: 'grid', gap: 10, marginBottom: 15}}>
              <button
                className="btn btn-primary"
                onClick={() => handleAction('add')}
                style={{padding: 15, fontSize: 16}}
              >
                ➕ Add
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleAction('pick')}
                style={{padding: 15, fontSize: 16}}
              >
                📦 Pick
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleAction('new_location')}
                style={{padding: 15, fontSize: 16}}
              >
                📍 New Location
              </button>
            </div>

            <button
              className="btn"
              onClick={() => setShowPopup(false)}
              style={{width: '100%', padding: 12, background: '#6c757d', color: 'white'}}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Action Modals */}
      {showAddModal && scannedData?.item && (
        <AddInventory
          item={scannedData.item}
          location={scannedData.location}
          onClose={() => setShowAddModal(false)}
          onSuccess={handleSuccess}
        />
      )}

      {showPickModal && scannedData?.item && (
        <PickInventory
          item={scannedData.item}
          location={scannedData.location}
          onClose={() => setShowPickModal(false)}
          onSuccess={handleSuccess}
        />
      )}

      {showMoveModal && scannedData?.item && (
        <MoveLocation
          item={scannedData.item}
          location={scannedData.location}
          onClose={() => setShowMoveModal(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
