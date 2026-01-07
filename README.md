# Warehouse Inventory - Web App

Simple web-based inventory system. Works on any device with a browser.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Features

✅ **Excel Import** - Upload your inventory spreadsheet
✅ **QR Scanner** - Scan with phone camera (works in browser!)
✅ **Create Locations** - Aisle-Shelf-Bin system
✅ **Count Inventory** - Update quantities
✅ **Print QR Codes** - Generate labels
✅ **Firebase Sync** - Cloud database (already configured)

## First Time Setup

### 1. Import Your Data

1. Go to "Import" tab
2. Upload `20251223_aa_surplus_inventory_report.xlsx`
3. Wait for import to complete (1,454 items)

### 2. Create a Location

1. Go to "Locations" tab
2. Click "+ Create New Location"
3. Enter: Aisle: A, Shelf: 1, Bin: 1
4. Click "Generate QR Code"
5. Click "Print QR Code"
6. Print and stick to physical location

### 3. Start Counting

1. Go to "Scanner" tab
2. Click "Start Camera"
3. Scan the QR code you printed
4. Search for items
5. Update counts with +/- buttons

## Using on Mobile

Just open the URL on your phone. The QR scanner works in mobile browsers (Chrome, Safari).

**For best results:**
- Use Chrome on Android
- Use Safari on iPhone
- Allow camera permission when prompted

## Firestore Rules

Your Firebase is already configured. Set these rules in Firebase Console:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

## Collections

**items** - Your inventory (1,454 items from Excel)
- name, partNumber, location, price, stock

**locations** - Warehouse locations
- aisle, shelf, bin, qrCode, inventory{}

## Tips

- **Search by part number** - Fastest way to find items
- **Use + / - buttons** - Easier than typing on phone
- **Print multiple QR codes** - Do all locations at once
- **Bookmark on phone home screen** - Acts like an app

## Deploy to Production

```bash
npm run build
```

Upload the `dist` folder to:
- Firebase Hosting (free)
- Netlify (free)
- Vercel (free)

Then access from anywhere!

---

**No app stores. No downloads. Just works.**
