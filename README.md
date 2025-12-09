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
3. Set build command: `npm install -g pnpm && pnpm install`
4. Set start command: `pnpm start`
5. Set environment: Node.js
6. **Required environment variable:**
   - `PDF_SERVICE_API_KEY`: A secret API key for authentication (generate a secure random string)

## Security

- **API Key Authentication**: All requests (except `/health`) require an `X-API-Key` header
- **Rate Limiting**: 10 requests per minute per client (IP or API key)
- **Note**: Vercel doesn't have fixed IP addresses, so API key authentication is used instead of IP allowlist

## API

### POST /render

Generate a PDF from HTML.

**Headers:**
- `X-API-Key`: Required. Your PDF service API key
- `Content-Type`: `application/json`

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
- Error: JSON with error message
  - `401`: Missing or invalid API key
  - `429`: Rate limit exceeded
  - `400`: Invalid request
  - `500`: Server error

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
- Free tier instances spin down after inactivity (adds ~50 seconds to first request)
- Rate limiting uses in-memory store (resets on service restart)

