import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyAaWJeLMm4nYXGDi43-odr_7_TJpX4oEaI",
  authDomain: "warehouse-inventory-cec3b.firebaseapp.com",
  projectId: "warehouse-inventory-cec3b",
  storageBucket: "warehouse-inventory-cec3b.firebasestorage.app",
  messagingSenderId: "723704456374",
  appId: "1:723704456374:web:800848984809de02767217"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
