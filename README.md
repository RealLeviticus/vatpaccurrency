# VATPAC Watchlist - GitHub Pages Dashboard

A modern web dashboard for monitoring VATSIM controller activity in the Australia/Pacific region.

## Architecture

```
┌─────────────────────────────────────────┐
│     GitHub Pages (Static Frontend)      │
│  • Dashboard (index.html)               │
│  • Audit Results (audit.html)           │
│  • Watchlist Management (watchlist.html)│
└────────────────┬────────────────────────┘
                 │ HTTPS + CORS
                 ▼
┌─────────────────────────────────────────┐
│   Cloudflare Worker (REST API Backend)  │
│  • Watchlist CRUD                       │
│  • Audit Engine (5-min cron)            │
│  • Presence Monitoring                  │
│  • VATSIM API Integration               │
│  • GitHub Storage (store.json)          │
└─────────────────────────────────────────┘
```

## Features

- **Real-time Presence Monitoring**: See which watched controllers are currently online
- **Activity Audits**: Track visiting (10hr) and local (15hr) controller requirements
- **Watchlist Management**: Add/remove controllers with CID validation
- **Interactive Tables**: Sort and filter audit results
- **Dark Aviation Theme**: Professional UI matching existing VATPAC tools
- **Auto-refresh**: Dashboard updates every 30 seconds
- **Mobile Responsive**: Works on all devices

## Files

### Frontend (GitHub Pages)

```
Controller Stats Site/
├── index.html              # Dashboard page
├── audit.html             # Audit results (visiting/local tabs)
├── watchlist.html         # Manage watchlist
├── css/
│   └── style.css          # Dark aviation theme
├── js/
│   ├── api.js             # API client wrapper
│   ├── dashboard.js       # Dashboard logic
│   ├── audit.js           # Audit table logic
│   ├── watchlist.js       # Watchlist CRUD
│   └── utils.js           # Shared utilities
└── worker.js              # Cloudflare Worker code
```

### Backend (Cloudflare Worker)

- **File**: `worker.js`
- **Deployment URL**: `https://vatsimactivitybot.therealleviticus.workers.dev`
- **Storage**: GitHub-backed store.json
- **Cron**: Runs every 5 minutes for presence and audit ticking

## API Endpoints

All endpoints are prefixed with `/api/`

### Watchlist

- `GET /api/watchlist` - Get all watched controllers
- `POST /api/watchlist` - Add controller (body: `{cid: "123456"}`)
- `DELETE /api/watchlist/:cid` - Remove controller

### Audits

- `GET /api/audit/visiting` - Get visiting audit results
- `GET /api/audit/local` - Get local audit results

### Presence

- `GET /api/presence` - Get currently online controllers

### Stats

- `GET /api/stats` - Get dashboard statistics

## Setup Instructions

### 1. Deploy Frontend (GitHub Pages)

1. Commit all files to your repository:
   ```bash
   git add .
   git commit -m "Add VATPAC Watchlist dashboard"
   git push
   ```

2. Enable GitHub Pages:
   - Go to repository Settings → Pages
   - Source: Deploy from branch `main` (root directory)
   - Save

3. Your site will be available at: `https://realleviticus.github.io/Controller-Stats-Site/`

### 2. Deploy Backend (Cloudflare Worker)

1. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```

2. Create `wrangler.toml` in the same directory as `worker.js`:
   ```toml
   name = "vatsimactivitybot"
   main = "worker.js"
   compatibility_date = "2024-01-01"

   [vars]
   ALLOWED_ORIGIN = "https://realleviticus.github.io"
   GITHUB_DIR = "cf-cache"
   GITHUB_BRANCH = "main"

   [[unsafe.bindings]]
   name = "GITHUB_TOKEN"
   type = "secret_text"

   [[unsafe.bindings]]
   name = "GITHUB_REPO"
   type = "secret_text"

   [triggers]
   crons = ["*/5 * * * *"]  # Every 5 minutes
   ```

3. Set secrets:
   ```bash
   wrangler secret put GITHUB_TOKEN
   # Enter your GitHub Personal Access Token

   wrangler secret put GITHUB_REPO
   # Enter: YourUsername/YourRepoName
   ```

4. Deploy:
   ```bash
   wrangler deploy
   ```

5. Your Worker will be available at: `https://vatsimactivitybot.therealleviticus.workers.dev`

### 3. Test the Integration

1. Open `https://realleviticus.github.io/Controller-Stats-Site/` in your browser

2. Check browser console for any errors:
   - Press F12 → Console tab
   - Look for CORS errors (should be none)
   - Look for API connection errors

3. Try adding a controller:
   - Go to Watchlist page
   - Click "Add Controller"
   - Enter a valid VATSIM CID
   - Submit

4. Check Dashboard:
   - Should show stats
   - Should show presence if controllers online

## Development

### Local Testing

Frontend:
```bash
# Serve locally with any static server
python -m http.server 8000
# or
npx http-server

# Open http://localhost:8000
```

Worker:
```bash
# Test locally with wrangler
wrangler dev

# Test API endpoints
curl http://localhost:8787/api/stats
curl http://localhost:8787/api/watchlist
```

### Debugging

- **CORS errors**: Check `ALLOWED_ORIGIN` in Worker environment
- **404 on API calls**: Verify Worker URL in `js/api.js`
- **Empty data**: Check Worker logs in Cloudflare dashboard
- **Audit not running**: Verify cron trigger is active

## Data Storage

All data is stored in a single GitHub file: `cf-cache/store.json`

Structure:
```json
{
  "watchlist": ["123456", "789012"],
  "online_state": { ... },
  "audit:job": { ... },
  "audit:partial:visiting": [ ... ],
  "audit:partial:local": [ ... ],
  "rating:123456": { "label": "C1", "cached_at": 1234567890 },
  ...
}
```

## Customization

### Change Colors

Edit `css/style.css`:
```css
:root {
  --bg-primary: #0a0e27;      /* Main background */
  --accent-cyan: #06b6d4;      /* Primary accent */
  --accent-blue: #3b82f6;      /* Secondary accent */
  /* ... */
}
```

### Add More Stats

1. Add API endpoint in `worker.js`
2. Call from frontend in `js/dashboard.js`
3. Display in `index.html`

### Change Refresh Rate

Edit `js/dashboard.js`:
```javascript
// Change from 30 seconds to 60 seconds
refreshInterval = setInterval(() => {
  loadDashboard();
}, 60000);  // was 30000
```

## Troubleshooting

### API Returns 404

- Check Worker is deployed: `curl https://vatsimactivitybot.therealleviticus.workers.dev/`
- Should return: `{"status":"ok","version":"2.0.0"}`

### CORS Errors

- Verify `ALLOWED_ORIGIN` in Worker environment matches your GitHub Pages URL
- Check browser console for exact error message

### No Data Showing

1. Open browser DevTools (F12)
2. Go to Network tab
3. Reload page
4. Check API calls - are they returning data?
5. Check Console tab for JavaScript errors

### Audits Not Running

- Check Cloudflare dashboard → Workers → Triggers → Cron Triggers
- Should show `*/5 * * * *` (every 5 minutes)
- Check Worker logs for errors

## Migration from Discord Bot

If you have existing watchlist data:

1. Export from old Discord bot storage
2. Format as array of CIDs: `["123456", "789012", ...]`
3. Manually add to `store.json` in GitHub repo
4. Or add one-by-one via web UI

## Contributing

Feel free to submit issues or pull requests!

## License

MIT License - feel free to use and modify for your own division/vACC.

## Credits

- Built for VATPAC (Australia/Pacific Division)
- Uses VATSIM API for controller data
- Uses vatSys datasets for AU/PAC callsigns
- Inspired by the existing VATPAC Area QNH Map project
