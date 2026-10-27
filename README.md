# FIFTY — Minimal Shared File Room

A very minimal web app with **50 shared slots**, **one file in each slot**, and **up to 10 people connected at the same time**. Designed for phones and computers.

## Included

- Exactly **50 numbered file slots** (all shared with everyone)
- Upload a file to any slot; replace or delete it later
- **Rename both the slot title and the displayed/downloaded file name**
- Download any existing file
- Search by slot number, slot title, file name, or uploader
- See live uploads, deletions, renames, and how many people are online
- Up to **10 people in the room at once**, with a brief 30-second reconnect allowance
- Drag-and-drop files onto slots on computers
- Optional shared room passcode
- No database service or third-party Node packages needed

Everyone inside the room can edit any slot. There's no per-person file ownership or administrator account in this version. For private sharing, set the optional `ROOM_PASSCODE` and only give your website link/passcode to people you trust.

## Start locally

1. Install Node.js version 20 or newer.
2. Open a terminal in the project folder.
3. Run: `npm start`
4. Open `http://localhost:3000`.

No `npm install` is required: the app only uses built-in Node.js modules.

## Deploy on Render from GitHub

1. Extract the ZIP. Upload the contents of the folder to a new GitHub repository. Keep `package.json`, `server.js`, and `public/` in the repository root.
2. On Render, create a **New Web Service** from that repository.
3. Choose the **Node** environment.
4. Build command: `npm install` (or leave build blank, if Render supports it).
5. Start command: `npm start`.
6. Once deployed, open the Render URL on your phone and share that URL with the other participants.

### IMPORTANT: persistent file storage

**Uploaded files are saved to the server's disk. Render's default ephemeral filesystem can wipe these files on restarts, redeploys, or instance replacement.** For genuine long-term shared file storage, use a Render plan that supports a persistent disk, and configure:

- Disk mount path: `/var/data`
- Environment variable: `DATA_DIR=/var/data`

Use a disk with enough capacity. With the default 20 MB cap, 50 full slots could occupy up to about 1 GB. If you deploy on a free/ephemeral hosting service without a persistent disk, files may disappear. A future version can use cloud storage instead.

### Settings (optional environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Web server port; Render sets it automatically. |
| `DATA_DIR` | `./data` | Where uploaded files and names are saved. |
| `ROOM_PASSCODE` | empty | If set, everyone needs this passcode to join. |
| `MAX_FILE_MB` | `20` | Maximum upload size per file, from 1 to 100 MB. |

## How to use

1. Enter a display name and join the room.
2. Tap **+ ADD** on an empty slot to upload a file.
3. Tap **✎** to rename the slot (for example, "Vehicle Photos") and, if a file exists, its filename.
4. Tap **GET** to download or **SWAP** to replace the file.
5. Open **✎** and choose **Remove file** to empty a slot.
6. Other participants see the changes live without refreshing.

## Technical / privacy details

- Each slot holds one file, not a folder. Uploading to an occupied slot replaces the previous file after confirmation.
- Up to 10 active browser sessions at a time. Closing a tab releases its spot after a short reconnect grace period, or immediately through **Leave**.
- Session access uses an HTTP-only cookie. The optional shared passcode protects entry; it is not individual user authentication.
- Uploaded files are forced to download instead of rendering as executable HTML inside the app.
- Shared file names and slot titles persist in `DATA_DIR/slots.json`, and uploaded bytes are in `DATA_DIR/uploads/`.
- This version is for small trusted groups. It does not include malware scanning, user-specific permissions, backups, or file-version history.
