# 🚗 Auto Drive-Time Blocker for Google Calendar

Automatically adds "Drive to ..." events before your calendar meetings, estimating real-world travel time (with traffic) from your home address to the meeting location.  

This script runs entirely in **Google Apps Script**, using **time-based triggers** — no external servers or web deployment required.

---

## 🧠 Problem Statement

Many people forget to leave buffer time between meetings that require travel.  
Google Calendar can show travel time, but it doesn't automatically block time to **drive** to the next meeting — leaving schedules unrealistic.

### Pain points:
- Back-to-back meetings in different places.
- No automatic reminder or buffer for commute time.
- Need to manually add travel blocks before each event.

---

## 💡 Solution

This project solves that by automatically creating “Drive to …” events before your calendar events that have physical locations.

### Key features:
- 🕓 Predicts **real-time traffic** using the Google Maps **Distance Matrix API**.  
- 📅 Automatically inserts or updates “Drive to …” events before meetings.  
- 🚫 Removes them if the event is canceled or moved online.  
- ⏱️ Runs every **5 minutes** via a time-based trigger — no manual work.  
- 💾 Uses caching to minimize API calls and cost.  
- ⚙️ Fully configurable through script properties (no code changes required).

---

## ⚙️ Prerequisites

You’ll need:

- A **Google account** with access to [Google Apps Script](https://script.google.com/).
- A **Google Maps API key** with the **Distance Matrix API** enabled.  
  - Create one in [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
  - Make sure **billing** is enabled.
- Access to your **Google Calendar** (primary or shared).

---

## 🛠️ Setup Instructions

### 1️⃣ Create the Apps Script project
1. Go to [https://script.google.com/](https://script.google.com/).
2. Click **New Project** → name it `Auto Drive-Time Blocker`.
3. Paste all the code from [`Code.gs`](./Code.gs) into the editor.

---

### 2️⃣ Enable required services

- In the left sidebar → **Services (puzzle icon)** → click **+** → enable:
  - **Google Calendar API (Advanced Service)**

- In **Google Cloud Console → Library** enable:
  - **Google Calendar API**
  - **Distance Matrix API**

---

### 3️⃣ Configure script properties

Open **Project Settings → Script properties** and add the following:

| Property | Example | Description |
|-----------|----------|-------------|
| `HOME_ADDRESS` | `"123 Main St, San Jose, CA"` | Starting point for driving |
| `BUFFER_MINUTES` | `"10"` | Extra time for parking/walking |
| `WATCH_CALENDAR_ID` | `"primary"` | Calendar to monitor |
| `GOOGLE_MAPS_API_KEY` | `"AIza...YOUR_KEY_HERE"` | Maps API key |
| `SCAN_LOOKAHEAD_HOURS` | `"48"` | How far ahead to scan (default 48 hours) |
| `LOG_LEVEL` | `"INFO"` or `"DEBUG"` | Logging verbosity |

---

### 4️⃣ Authorize and install triggers

In the Apps Script editor:

1. Run the function `authKickstart()` once → approve permissions.  
2. Run the function `setup()` once → installs background triggers.  
3. Check triggers via the 🕒 **Triggers** icon (left sidebar).  
   You should see:
   - `scanUpcoming_` → every 5 minutes
   - `scanUpcoming_` → every hour (backup)

---

### 5️⃣ Test it

1. Create an event in Google Calendar with a **real street location** (not a Zoom/Meet link).  
2. Wait up to 5 minutes (or run `scanNow()` manually in the editor).  
3. A new **"Drive to [Location]"** event will appear before your meeting.

---

## 🔍 How it Works

1. Every 5 minutes, the script runs `scanUpcoming_()`:
   - Fetches upcoming events in your selected calendar.
   - For each event with a physical location:
     - Uses the Maps Distance Matrix API to calculate ETA with traffic.
     - Inserts or updates a “Drive to …” block.
   - Deletes any that are no longer needed.

2. Caching minimizes repeated API calls (one call per route per hour).

3. Uses predictive traffic data (`traffic_model=best_guess`) based on the **actual time of the meeting**, not the time the script runs.

---

## 💰 Cost and Quotas

| Service | Free quota | What this script uses |
|----------|-------------|----------------------|
| Apps Script runtime | 90 minutes/day (free) | ~30–60 minutes total |
| Distance Matrix API | 100 elements/day free | ~2 per event |
| Calendar API | 20k requests/day | Few hundred at most |

Typical personal use: **$0/month** — fully within the free tier.

---

## 🧾 Logs and Debugging

- Open [**Executions page**](https://script.google.com/home/executions) to view logs.  
- Set `LOG_LEVEL = "DEBUG"` in Script Properties to see detailed `[DEBUG]` entries.  
- Manual debug:  
  ```javascript
  function scanNow() { scanUpcoming_(); }


⚙️ Customizations
	•	Multiple calendars:
Set WATCH_CALENDAR_IDS = "primary,team@example.com" and loop through each in scanUpcoming_().
	•	Separate “Travel Time” calendar:
Change insert/delete calls to use a dedicated calendar ID (keeps your main one clean).
	•	Longer horizon:
Set SCAN_LOOKAHEAD_HOURS = "720" for 30 days ahead.

⸻

🚨 Safety
	•	The script never deletes your original meetings.
	•	It only deletes “Drive to …” events that it created itself (identified by metadata and title).
	•	You can test safely using a separate calendar.

⸻

🧰 Tech Stack
	•	Google Apps Script
	•	Google Calendar API (Advanced Service)
	•	Google Maps Distance Matrix API
	•	CacheService (1-hour caching)

⸻

📄 License

MIT License © 2025 — You’re free to use and modify.
Please credit this repo if you share or fork it.


🙌 Author

Built by Mathew Varghese
