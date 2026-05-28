# CareerCopilot — Network Intelligence Chrome Extension

A Manifest V3 Chrome extension that lets you import LinkedIn connection data into CareerCopilot to find warm job opportunities through your network.

---

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `extension/` folder from this repository
5. The CareerCopilot extension will appear in your extensions list

Pin it to the toolbar for easy access: click the puzzle piece icon → pin CareerCopilot.

---

## Connecting to CareerCopilot

1. Log in to [CareerCopilot](https://adib-job-agent.web.app)
2. Go to **Settings → Extension** tab
3. Click **"Generate Extension Token"**
4. Copy the token that appears
5. Click the CareerCopilot extension icon in Chrome
6. Paste your token in the input field and click **Connect**

The status indicator will turn green when successfully connected.

---

## Using on LinkedIn

The extension works on three types of LinkedIn pages:

### Profile Pages (`linkedin.com/in/username`)
- Opens someone's profile
- Click "Analyze This Page" to extract their info (name, title, company, mutual connections)
- Works on the currently visible content only

### Company People Pages (`linkedin.com/company/name/people`)
- Navigate to a company's People tab
- Scroll to load the profiles you want to capture
- Click "Analyze This Page" — extracts all visible profile cards

### Search Results (`linkedin.com/search/results/people`)
- Run a People search with any filters
- Scroll to the results you care about
- Click "Analyze This Page" — extracts all visible results

### Syncing

After analysis, review the count and click **"Sync to CareerCopilot"** to send the connections to your network. CareerCopilot will then surface warm intro opportunities based on your network.

### Floating Button

A small **CC** button appears in the bottom-right corner of LinkedIn pages as a quick shortcut to open the extension popup.

---

## Privacy & Compliance Notes

- **No automated scraping**: The extension never auto-scrolls, auto-clicks, or runs without explicit user action
- **Visible content only**: Only data visible on screen at the time you click "Analyze" is read
- **No background data collection**: The content script is passive until you trigger analysis
- **LinkedIn safe**: The extension reads the DOM like a human would read the page — no API calls to LinkedIn, no session token access, no automated behavior
- **Your data**: Connections are sent only to your CareerCopilot account via an authenticated token you control. You can disconnect at any time

---

## File Structure

```
extension/
├── manifest.json              # Manifest V3 config
├── background.js              # Service worker (auth, badge state)
├── content/
│   └── linkedin-analyzer.js  # LinkedIn DOM parser + floating button
├── popup/
│   ├── popup.html             # Extension popup UI
│   └── popup.js               # Popup logic and API calls
├── utils/
│   ├── api-client.js          # Backend API client class
│   └── linkedin-parser.js    # LinkedIn parsing utilities (standalone)
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

---

## Development

To update the extension after making changes:
1. Go to `chrome://extensions/`
2. Click the refresh icon on the CareerCopilot extension card

For content script changes, also refresh any open LinkedIn tabs.
