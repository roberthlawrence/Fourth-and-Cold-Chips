# Chip Draw — update notes

## Upload to GitHub (4 files)
index.html · styles.css · app.js — replace existing.
Plus the two logo PNGs (logo-white.png, logo-dark.png) copied from your
squares repo if you haven't yet — download raw from that repo, upload here.

## Firebase console (2 edits — this fixes your permission errors)
1. **Firestore → Rules**: paste the new firestore.rules. Inside it, edit BOTH
   email lists: `isPower()` (you + other full admins) and `isPay()` (payment
   admins). Use the exact lowercase Gmail you sign in with. **Publish.**
2. **Authentication → Settings → Authorized domains**: add
   `roberthlawrence.github.io` (fixes the auth/unauthorized-domain error).

## Edit firebase-config.js in the repo (don't replace the file — just edit)
Replace the ADMIN_EMAILS block with two lists matching the rules:

    export const POWER_ADMIN_EMAILS = [
      "you@gmail.com"
    ];
    export const PAYMENT_ADMIN_EMAILS = [
      "paymentadmin1@gmail.com"
    ];

(The app still accepts the old ADMIN_EMAILS name as power admins, so nothing
breaks if you update it later.)
