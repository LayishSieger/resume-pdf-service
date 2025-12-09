# Resume PDF Service

Standalone PDF generation service for Render.com that matches the local PDF generation behavior.

## Features

- Matches local PDF generation logic exactly
- Supports both page mode and continuous scroll mode
- Handles font loading (Raleway fonts)
- Smart page break logic for page mode
- Accurate height measurement for continuous mode
- Works on Render.com free tier

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. For local testing, install Chrome for Puppeteer:
```bash
npx puppeteer browsers install chrome
```

3. Run locally:
```bash
pnpm start
```

The service will automatically use regular Puppeteer for local development and `@sparticuz/chromium` when deployed to Render.com.

## Deploy to Render.com

1. Create a new Web Service on Render.com
2. Connect your repository or deploy from this directory
3. Set build command: `pnpm install`
4. Set start command: `pnpm start`
5. Set environment: Node.js
6. No environment variables required

## API

### POST /render

Generate a PDF from HTML.

**Request Body:**
```json
{
  "html": "<html>...</html>",
  "templateId": "modern",
  "previewViewMode": "page" | "continuous",
  "previewPageSize": "A4" | "US Letter"
}
```

**Response:**
- Success: PDF file (Content-Type: application/pdf)
- Error: JSON with error message (status 400 or 500)

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "resume-pdf-service"
}
```

## Notes

- Uses `puppeteer-core` + `@sparticuz/chromium` for compatibility with Render.com
- Browser is launched fresh for each request (no caching)
- 30 second timeout for PDF generation
- 10MB request body limit

