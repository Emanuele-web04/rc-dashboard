# RevenueCat Personal Dashboard

Read-only Next.js dashboard for RevenueCat metrics beyond the default 28-day view.

## Setup

Create `.env.local` from `.env.example`:

```bash
REVENUECAT_API_KEY=your_read_only_secret_key
REVENUECAT_PROJECT_ID=
REVENUECAT_CURRENCY=USD
```

Never commit a real RevenueCat secret key. `.env.local` and every `.env.*` file are gitignored; `.env.example` must keep placeholder values only.

`REVENUECAT_PROJECT_ID` is optional. If it is empty, the app calls RevenueCat `/v2/projects` and uses the first project available to the API key.

## RevenueCat Permissions

Use a restricted key with read-only scopes:

- `charts_metrics:overview:read`
- `charts_metrics:charts:read`
- `project_configuration:projects:read` only if you want automatic project discovery

No client-side code receives the API key. Browser requests go to `/api/revenuecat`, and that server route calls RevenueCat.

## Metrics Included

Core chart cards:

- Revenue
- MRR
- ARR
- Active subscriptions
- Active customers
- Churn
- Active trials
- Refund rate
- New customers

The dashboard also renders every metric returned by RevenueCat's `/metrics/overview` endpoint in the "All overview metrics" section.

The range picker supports:

- 7 days
- 28 days
- 3 months
- 6 months
- All time

## Run

```bash
npm run dev
```

Open `http://127.0.0.1:3000`.

Without `.env.local`, the dashboard shows deterministic demo data so the UI can still be inspected.
# rc-dashboard
