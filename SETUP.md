# Chip Draw Raffle — Setup

Same recipe as 4th and Cold: GitHub Pages hosting + Firebase backend, no build step. New repo, new Firebase project (keeps the two games' data and security rules separate).

## 1. Firebase (10 min)
1. console.firebase.google.com → **Add project** → name it `chip-draw` (Analytics off is fine).
2. **Build → Firestore Database → Create database** → production mode → your region.
3. **Build → Authentication → Get started** → enable **Anonymous** AND **Google** sign-in providers.
4. Project settings (gear) → **Your apps → Web app (</>)** → register `chip-draw` → copy the `firebaseConfig` values into `firebase-config.js`.
5. In `firebase-config.js`, set `ADMIN_EMAILS` to the admin Gmail addresses (lowercase).
6. Firestore → **Rules** tab → paste the contents of `firestore.rules`, edit the same email list inside the `isAdmin()` function, → **Publish**.

## 2. GitHub Pages (5 min)
1. New **public** repo, e.g. `chip-draw`.
2. Upload: `index.html`, `styles.css`, `app.js`, `firebase-config.js` (with real values — safe to commit, same as the board).
3. Settings → Pages → Source: main branch → Save.
4. Site: `https://roberthlawrence.github.io/chip-draw/`
5. Back in Firebase: **Authentication → Settings → Authorized domains** → add `roberthlawrence.github.io` (needed for Google admin sign-in).

## 3. Running a game
1. Open the site, go to **The Bag** tab → **Admin sign-in** (Google). Admin tab appears. **If you're playing too, do this before drawing chips** so your chips stay tied to your Google account.
2. Admin tab → build **The bag** (rows of $ value × count; totals shown live) → Save.
3. Add **Prizes** (name, description, optional photo — resized on-device, up to 30).
4. **Settings**: title, Venmo handle, optional unpaid-limit brake, and the unplaced-chips rule for lock time (warn-and-block, or auto-move to a bucket of your choice).
5. **Open the game.** Share the link. Players join with name + email, draw chips, and place them on prizes. Everyone sees live bucket counts and what's left in the bag.
6. Payments section tracks owed vs. paid per player, with Venmo deep links on the player side.
7. When it's time: **Lock buckets** (the unplaced-chips rule runs here; unpaid chips stay valid entries, and admins get flagged until all balances clear).
8. **Draw winner** per prize (or Draw all). Winners get a gold banner; then **Mark game complete**.

## Behavior notes
- Every chip = one entry regardless of value; draws are crypto-random weighted by what's left in the bag, per denomination.
- Removing a prize returns its chips to owners as unplaced, notifies each owner at next login, and gives admins the impacted list with a copy-emails button.
- Chips can be added mid-game via the bag builder; denominations can't be cut below what's already drawn.
- CSV export (chips + balances) is in the Payments section.
