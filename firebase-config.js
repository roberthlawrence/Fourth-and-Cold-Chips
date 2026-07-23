// ============================================================
// CHIP DRAW — Firebase configuration
// 1. Create a new Firebase project (e.g. "chip-draw") at
//    https://console.firebase.google.com
// 2. Add a Web App, copy its config object, and paste the
//    values below.
// 3. List admin Gmail addresses in ADMIN_EMAILS. The SAME list
//    must be pasted into firestore.rules (isAdmin function).
// Once real values are in, this file is safe to commit — same
// as the 4th and Cold board.
// ============================================================

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Google accounts allowed to use the Admin tab (lowercase).
export const ADMIN_EMAILS = [
  "you@gmail.com"
];
