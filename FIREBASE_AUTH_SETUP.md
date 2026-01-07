# Firebase Authentication Setup

## Step 1: Enable Authentication in Firebase Console

1. Go to https://console.firebase.google.com
2. Select your project: **warehouse-inventory-cec3b**
3. Click **Authentication** in the left sidebar
4. Click **Get started** (if first time)
5. Click **Sign-in method** tab
6. Click **Email/Password**
7. Toggle **Enable** to ON
8. Click **Save**

## Step 2: Create User Accounts

1. Still in Firebase Console → Authentication
2. Click **Users** tab
3. Click **Add user**
4. Enter email and password for each employee
5. Click **Add user**

**Example users:**
- admin@yourcompany.com
- warehouse1@yourcompany.com
- warehouse2@yourcompany.com

## Step 3: Test Locally

```bash
cd warehouse-inventory
npm install
npm run dev
```

Open https://localhost:3000 - you should see the login screen!

## Step 4: Deploy to Vercel

1. Go to https://vercel.com
2. Sign up with GitHub (free)
3. Click **Add New Project**
4. Import your repository (or upload folder)
5. Click **Deploy**
6. Get your public URL!

---

## Managing Users

**Add new employee:**
- Firebase Console → Authentication → Users → Add user

**Remove employee access:**
- Firebase Console → Authentication → Users → Find user → Delete

**Reset password:**
- Users can click "Forgot password?" on login screen
- Or you can delete and recreate their account

---

## Security Notes

- Each user has their own login
- Movements track WHO made changes (email logged)
- Only authenticated users can access the app
- Firebase handles password security

---

## Troubleshooting

**"auth/user-not-found"**
- User doesn't exist in Firebase Authentication
- Create the user in Firebase Console

**"auth/wrong-password"**
- Password is incorrect
- Use "Forgot password?" or reset in Firebase Console

**"auth/too-many-requests"**
- Too many failed login attempts
- Wait a few minutes and try again
