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
    
    if (item) {
      setScannedData({
        code,
        type: 'item',
        item: item,
        location: null,
        currentInventory: item.stock || 0,
        currentLocation: item.location || 'Unassigned'
      });
      setShowPopup(true);
    } else if (location) {
      // Get items at this location
      const allItems = await DB.getItems();
      const locationCode = location.locationCode || `${location.warehouse}-R${location.rack}-${location.letter}-${location.shelf}`;
      
      // Get inventory from location.inventory object
      const locationItems = [];
      if (location.inventory) {
        for (const [itemId, qty] of Object.entries(location.inventory)) {
          if (qty > 0) {
            const item = allItems.find(i => i.id === itemId);
            if (item) {
              locationItems.push({ ...item, qtyAtLocation: qty });
            }
          }
        }
      }
      
      // Also check items that have this location in their location field
      allItems.forEach(item => {
        if (item.location === locationCode && !locationItems.find(li => li.id === item.id)) {
          locationItems.push({ ...item, qtyAtLocation: item.stock || 0 });
        }
      });
      
      setScannedData({
        code,
        type: 'location',
        item: null,
        location: location,
        locationCode,
        locationItems
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
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
          }}>
            {/* ITEM SCAN */}
            {scannedData.type === 'item' && scannedData.item && (
              <>
                <h2 style={{marginBottom: 20, textAlign: 'center'}}>📦 Item Scanned</h2>
                
                <div style={{ padding: 15, background: '#e8f5e9', borderRadius: 8, marginBottom: 15 }}>
                  <div style={{ fontWeight: 600, fontSize: 18 }}>{scannedData.item.name}</div>
                  <div style={{ color: '#666', fontSize: 13 }}>SKU: {scannedData.item.partNumber || 'N/A'}</div>
                </div>
                
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
              </>
            )}

            {/* LOCATION SCAN */}
            {scannedData.type === 'location' && scannedData.location && (
              <>
                <h2 style={{marginBottom: 20, textAlign: 'center'}}>📍 Location Scanned</h2>
                
                <div style={{ 
                  padding: 20, 
                  background: 'linear-gradient(135deg, #2d5f3f, #1a3a26)', 
                  borderRadius: 8, 
                  marginBottom: 20,
                  color: 'white',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>
                    {scannedData.locationCode}
                  </div>
                </div>
                
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ fontSize: 16, marginBottom: 10, color: '#666' }}>
                    Items at this location ({scannedData.locationItems?.length || 0})
                  </h3>
                  
                  {(!scannedData.locationItems || scannedData.locationItems.length === 0) ? (
                    <div style={{ 
                      padding: 30, 
                      background: '#f5f5f5', 
                      borderRadius: 8, 
                      textAlign: 'center',
                      color: '#666'
                    }}>
                      No items at this location
                    </div>
                  ) : (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      {scannedData.locationItems.map((item, idx) => (
                        <div 
                          key={item.id || idx}
                          style={{
                            padding: 12,
                            background: idx % 2 === 0 ? '#f8f9fa' : 'white',
                            borderRadius: 6,
                            marginBottom: 5,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600 }}>{item.name}</div>
                            <div style={{ fontSize: 12, color: '#666' }}>
                              {item.partNumber || 'No SKU'}
                            </div>
                          </div>
                          <div style={{
                            background: '#2d5f3f',
                            color: 'white',
                            padding: '5px 12px',
                            borderRadius: 20,
                            fontWeight: 600
                          }}>
                            {item.qtyAtLocation}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              className="btn"
              onClick={() => setShowPopup(false)}
              style={{width: '100%', padding: 12, background: '#6c757d', color: 'white'}}
            >
              Close
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
