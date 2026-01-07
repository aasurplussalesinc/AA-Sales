# Enable HTTPS for Camera Access

## Quick Setup

1. **Stop your current dev server** (Ctrl+C)

2. **Install the SSL plugin:**
```bash
npm install
```

3. **Start with HTTPS:**
```bash
npm run dev
```

4. **Access on your computer:**
- Go to: `https://localhost:3000`
- Your browser will warn about self-signed certificate
- Click **"Advanced"** → **"Proceed to localhost"**

5. **Access on your phone:**
- Find the HTTPS URL in terminal (looks like `https://192.168.1.XXX:3000`)
- Open in **Chrome** (Android) or **Safari** (iOS)
- You'll see a security warning
- **On Chrome:** Tap "Advanced" → "Proceed to site"
- **On Safari:** Tap "Show Details" → "Visit this website"
- Allow camera permission when asked

## Why This Works

- Browsers require HTTPS to access camera
- The `@vitejs/plugin-basic-ssl` creates a self-signed certificate
- It's safe for local development
- Camera will now work on your phone!

## Troubleshooting

**"This site can't be reached"**
- Make sure your phone is on same WiFi
- Check firewall isn't blocking port 3000

**Camera still not working**
- Make sure you're using Chrome or Safari
- Check browser permissions: Settings → Chrome → Permissions → Camera
- Try refreshing the page after allowing permission

**Certificate errors**
- This is normal with self-signed certificates
- Just click through the warning (it's your own local server)
