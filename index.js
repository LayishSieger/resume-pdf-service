const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Check if we're in a serverless environment (Render.com, Vercel, etc.)
const isServerless = !!process.env.RENDER || !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const app = express();
app.use(express.json({ limit: '10mb' }));

// Request logging middleware for debugging (after JSON parser)
app.use((req, res, next) => {
  if (req.path === '/render') {
    console.log('[PDF Service] Request received:', {
      method: req.method,
      path: req.path,
      contentType: req.headers['content-type'],
      hasBody: !!req.body,
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
    });
  }
  next();
});

// API Key Authentication
const PDF_SERVICE_API_KEY = process.env.PDF_SERVICE_API_KEY;
if (!PDF_SERVICE_API_KEY) {
  console.warn('[PDF Service] WARNING: PDF_SERVICE_API_KEY not set. Service is unsecured!');
}

// Rate limiting store (in-memory, resets on service restart)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute per IP

// Rate limiting middleware
function rateLimitMiddleware(req, res, next) {
  const clientId = req.headers['x-api-key'] || req.ip || 'unknown';
  const now = Date.now();
  
  if (!rateLimitStore.has(clientId)) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const limit = rateLimitStore.get(clientId);
  
  // Reset if window expired
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  // Check if limit exceeded
  if (limit.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Too many requests. Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per minute.`,
      retryAfter: Math.ceil((limit.resetTime - now) / 1000),
    });
  }
  
  limit.count++;
  next();
}

// API key authentication middleware
function apiKeyAuthMiddleware(req, res, next) {
  // Skip auth for health check
  if (req.path === '/health') {
    return next();
  }
  
  // If no API key is configured, allow all requests (development mode)
  if (!PDF_SERVICE_API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing API key. Please provide X-API-Key header.',
    });
  }
  
  if (apiKey !== PDF_SERVICE_API_KEY) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key.',
    });
  }
  
  next();
}

// Apply middleware
app.use(apiKeyAuthMiddleware);
app.use('/render', rateLimitMiddleware);

// Page size constants (in millimeters)
const PAGE_SIZES = {
  A4: { width: 210, height: 297 },
  'US Letter': { width: 215.9, height: 279.4 },
};

// Convert pixels to millimeters (1mm ≈ 3.779px at 96dpi)
function pxToMm(px) {
  return px / 3.779;
}

// Get page dimensions
function getPageDimensions(pageSize) {
  return PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
}

// Measure content height in continuous scroll mode
async function measureContentHeight(page) {
  const measurements = await page.evaluate(() => {
    const container = document.querySelector('.resume-container');
    const body = document.body;
    const html = document.documentElement;
    
    // Force reflow
    if (container) void container.offsetHeight;
    void body.offsetHeight;
    void html.offsetHeight;
    
    const measurements = {};
    
    // Measure resume-container
    if (container) {
      const containerEl = container;
      const rect = containerEl.getBoundingClientRect();
      measurements['resume-container.scrollHeight'] = containerEl.scrollHeight;
      measurements['resume-container.offsetHeight'] = containerEl.offsetHeight;
      measurements['resume-container.getBoundingClientRect().height'] = rect.height;
      measurements['resume-container.children.length'] = containerEl.children.length;
      
      const header = containerEl.querySelector('.resume-header');
      measurements['resume-container.hasHeader'] = header ? 1 : 0;
      if (header) {
        measurements['resume-header.offsetHeight'] = header.offsetHeight;
      }
    } else {
      measurements['resume-container'] = 0;
    }
    
    // Measure body
    measurements['body.scrollHeight'] = body.scrollHeight;
    measurements['body.offsetHeight'] = body.offsetHeight;
    
    // Measure documentElement
    measurements['documentElement.scrollHeight'] = html.scrollHeight;
    measurements['documentElement.offsetHeight'] = html.offsetHeight;
    
    return measurements;
  });
  
  console.log('[PDF Service] Height measurements:', JSON.stringify(measurements, null, 2));
  
  let height = 0;
  
  if (measurements['resume-container.scrollHeight']) {
    height = Math.max(
      measurements['resume-container.scrollHeight'] || 0,
      measurements['resume-container.offsetHeight'] || 0,
      measurements['resume-container.getBoundingClientRect().height'] || 0
    );
    console.log('[PDF Service] Using resume-container height:', height);
  } else {
    height = Math.max(
      measurements['body.scrollHeight'] || 0,
      measurements['body.offsetHeight'] || 0,
      measurements['documentElement.scrollHeight'] || 0,
      measurements['documentElement.offsetHeight'] || 0
    );
    console.log('[PDF Service] Using body/documentElement height (fallback):', height);
  }
  
  // Add padding to account for margins
  const padding = 150; // 150px to account for margins and ensure single page
  const finalHeight = height + padding;
  
  console.log('[PDF Service] Final height calculation:', {
    baseHeight: height,
    padding,
    finalHeight,
    hasHeader: measurements['resume-container.hasHeader'] === 1,
    headerHeight: measurements['resume-header.offsetHeight'] || 0,
  });
  
  return finalHeight;
}

// Log measurements for page mode
async function logPDFMeasurements(page, pageSize) {
  const dimensions = getPageDimensions(pageSize);
  const padding = 20; // 20mm total, 10mm per side
  const usableHeight = dimensions.height - padding;
  const A4_HEIGHT_PX = usableHeight * 3.779;
  const A4_WIDTH_PX = (dimensions.width - padding * 2) * 3.779;
  
  const measurements = await page.evaluate(async ({ A4_HEIGHT_PX, A4_WIDTH_PX }) => {
    const container = document.querySelector('.resume-container');
    if (!container) return null;
    
    const containerEl = container;
    const sections = Array.from(containerEl.querySelectorAll('.resume-section'));
    
    const sectionData = await Promise.all(sections.map(async (section, index) => {
      const sectionEl = section;
      const header = sectionEl.querySelector('h2');
      const headerHeight = header ? Math.max(header.scrollHeight, header.offsetHeight) : 0;
      const sectionName = header?.textContent?.trim() || `Section ${index + 1}`;
      
      // Get all items in section
      const items = [];
      const itemSelectors = [
        '.experience-item',
        '.education-item',
        '.project-item',
        '.certificate-item',
        '.skill-item'
      ];
      
      for (const selector of itemSelectors) {
        const sectionItems = Array.from(sectionEl.querySelectorAll(selector));
        items.push(...sectionItems);
      }
      
      // Force reflow for each item before measuring
      for (let i = 0; i < 3; i++) {
        items.forEach(item => {
          void item.offsetHeight;
          void item.scrollHeight;
          void item.getBoundingClientRect();
        });
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Measure each item individually
      const itemHeights = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        
        void item.offsetHeight;
        void item.scrollHeight;
        void item.getBoundingClientRect();
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        void item.offsetHeight;
        void item.scrollHeight;
        void item.getBoundingClientRect();
        
        await new Promise(resolve => setTimeout(resolve, 5));
        
        void item.offsetHeight;
        void item.scrollHeight;
        
        const scrollHeight = item.scrollHeight;
        const offsetHeight = item.offsetHeight;
        const height = Math.max(scrollHeight, offsetHeight);
        
        itemHeights.push(height);
      }
      
      // Include margins in measurement
      const computedStyle = window.getComputedStyle(sectionEl);
      const marginTop = parseFloat(computedStyle.marginTop) || 0;
      const marginBottom = parseFloat(computedStyle.marginBottom) || 0;
      const contentHeight = Math.max(
        sectionEl.scrollHeight,
        sectionEl.offsetHeight
      );
      const totalSectionHeight = contentHeight + marginTop + marginBottom;
      
      return {
        index,
        sectionName,
        totalSectionHeight,
        headerHeight,
        itemHeights,
        itemCount: items.length,
      };
    }));
    
    const header = containerEl.querySelector('.resume-header');
    const headerHeight = header ? Math.max(header.scrollHeight, header.offsetHeight) : 0;
    
    return {
      pageHeight: A4_HEIGHT_PX,
      pageWidth: A4_WIDTH_PX,
      headerHeight,
      sections: sectionData,
      totalContentHeight: Math.max(
        containerEl.scrollHeight,
        containerEl.offsetHeight
      ),
    };
  }, { A4_HEIGHT_PX, A4_WIDTH_PX });
  
  if (measurements) {
    console.log('[PDF Service] Page measurements:', {
      pageHeight: measurements.pageHeight,
      pageWidth: measurements.pageWidth,
      headerHeight: measurements.headerHeight,
      totalContentHeight: measurements.totalContentHeight,
      sectionsCount: measurements.sections.length,
    });
  }
  
  return measurements;
}

// Apply page breaks based on measurements
async function applyPageBreaks(page, measurementData, pageSize) {
  const dimensions = getPageDimensions(pageSize);
  const padding = 20; // 20mm total, 10mm per side
  const usableHeight = dimensions.height - padding;
  const A4_HEIGHT_PX = usableHeight * 3.779;
  
  await page.evaluate(({ A4_HEIGHT_PX, sections, headerHeight }) => {
    const container = document.querySelector('.resume-container');
    if (!container) return;
    
    const containerEl = container;
    const sectionElements = Array.from(containerEl.querySelectorAll('.resume-section'));
    
    let currentHeight = headerHeight;
    
    for (let i = 0; i < sections.length && i < sectionElements.length; i++) {
      const section = sections[i];
      const sectionEl = sectionElements[i];
      
      if (!section || !sectionEl) continue;
      
      const sectionHeight = section.totalSectionHeight;
      const testHeight = currentHeight + sectionHeight;
      
      // Rule 1: Section fits entirely - keep it on current page
      if (testHeight <= A4_HEIGHT_PX && section.itemCount > 0) {
        currentHeight = testHeight;
        continue;
      }
      
      // Rule 2: Section doesn't fit - add page break before it
      if (testHeight > A4_HEIGHT_PX && currentHeight > 0) {
        sectionEl.style.pageBreakBefore = 'always';
        sectionEl.style.breakBefore = 'page';
        currentHeight = sectionHeight;
        console.log(`[PDF Service] Added page break before section "${section.sectionName}" (height: ${currentHeight} + ${sectionHeight} = ${testHeight} > ${A4_HEIGHT_PX})`);
      } else {
        currentHeight = testHeight;
      }
    }
  }, { A4_HEIGHT_PX, sections: measurementData.sections, headerHeight: measurementData.headerHeight });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'resume-pdf-service' });
});

// PDF generation endpoint
app.post('/render', async (req, res) => {
  let browser = null;
  let page = null;
  
  try {
    // Validate request
    const { html, templateId, previewViewMode, previewPageSize } = req.body;
    
    console.log('[PDF Service] Received request:', {
      hasHtml: !!html,
      htmlLength: html?.length || 0,
      templateId,
      previewViewMode,
      previewPageSize,
      bodyKeys: Object.keys(req.body || {}),
    });
    
    if (!html) {
      console.error('[PDF Service] Missing HTML field in request body');
      return res.status(400).json({ 
        error: 'Missing required field: html',
        message: 'The request body must include an "html" field with the HTML content to convert to PDF.'
      });
    }
    
    const viewMode = previewViewMode || 'page';
    const pageSize = previewPageSize || 'A4';
    
    console.log('[PDF Service] Starting PDF generation:', {
      templateId,
      viewMode,
      pageSize,
      htmlLength: html.length,
    });
    
    // Launch browser - use @sparticuz/chromium in serverless, regular puppeteer locally
    if (isServerless) {
      // Production/serverless: Use @sparticuz/chromium
      const executablePath = await chromium.executablePath();
      const args = [
        ...chromium.args,
        '--single-process',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--hide-scrollbars',
      ];
      
      console.log('[PDF Service] Using @sparticuz/chromium at:', executablePath);
      
      browser = await puppeteer.launch({
        executablePath,
        args,
        headless: true,
        defaultViewport: {
          width: 1920,
          height: 1080,
        },
      });
    } else {
      // Local development: Use regular puppeteer (includes Chromium)
      const puppeteerFull = require('puppeteer');
      console.log('[PDF Service] Using local puppeteer (development mode)');
      
      browser = await puppeteerFull.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });
    }
    
    page = await browser.newPage();
    
    // Set viewport to match page width (important for accurate text wrapping)
    const dimensions = getPageDimensions(pageSize);
    const padding = 20; // 20mm total, 10mm per side
    const pageWidthPx = ((dimensions.width - padding * 2) * 3.779);
    const pageHeightPx = ((dimensions.height - padding) * 3.779);
    
    console.log('[PDF Service] Setting viewport size:', {
      pageSize,
      dimensions,
      pageWidthPx: Math.round(pageWidthPx),
      pageHeightPx: Math.round(pageHeightPx),
    });
    
    await page.setViewport({
      width: Math.round(pageWidthPx),
      height: Math.round(pageHeightPx),
    });
    
    // Set content - wait for network to be idle to ensure fonts are loaded
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    // Wait for fonts to load - this is critical for accurate measurements
    const fontLoadResult = await page.evaluate(async () => {
      const results = {
        fontsReady: false,
        ralewayLoaded: false,
        fontFamilyCheck: '',
        loadedFonts: [],
      };
      
      // Wait for all fonts to be loaded
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
        results.fontsReady = true;
      }
      
      // List all loaded fonts
      if (document.fonts && document.fonts.forEach) {
        document.fonts.forEach((font) => {
          if (font.status === 'loaded') {
            results.loadedFonts.push(`${font.family} ${font.weight}`);
          }
        });
      }
      
      // Wait for all font faces to be loaded (more thorough check)
      if (document.fonts) {
        const loadedRalewayWeights = [];
        document.fonts.forEach((font) => {
          if (font.family === 'Raleway' && font.status === 'loaded') {
            const weight = parseInt(font.weight) || 400;
            if (!loadedRalewayWeights.includes(weight)) {
              loadedRalewayWeights.push(weight);
            }
          }
        });
        
        const requiredWeights = [400, 500, 700];
        const hasRequiredWeights = requiredWeights.every(weight => 
          loadedRalewayWeights.includes(weight)
        );
        
        results.ralewayLoaded = hasRequiredWeights && loadedRalewayWeights.length > 0;
        results.loadedRalewayWeights = loadedRalewayWeights;
        
        // If required weights aren't loaded, wait a bit more and retry
        if (!hasRequiredWeights) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await document.fonts.ready;
          
          // Retry - check again
          const retryLoadedWeights = [];
          document.fonts.forEach((font) => {
            if (font.family === 'Raleway' && font.status === 'loaded') {
              const weight = parseInt(font.weight) || 400;
              if (!retryLoadedWeights.includes(weight)) {
                retryLoadedWeights.push(weight);
              }
            }
          });
          
          const retryHasRequired = requiredWeights.every(weight => 
            retryLoadedWeights.includes(weight)
          );
          results.ralewayLoaded = retryHasRequired && retryLoadedWeights.length > 0;
          results.loadedRalewayWeights = retryLoadedWeights;
        }
      }
      
      // Verify fonts are actually loaded by checking a specific font
      const testElement = document.createElement('div');
      testElement.style.fontFamily = "'Raleway', sans-serif";
      testElement.style.position = 'absolute';
      testElement.style.visibility = 'hidden';
      testElement.textContent = 'Test';
      document.body.appendChild(testElement);
      
      // Force multiple reflows to ensure fonts are applied
      void testElement.offsetHeight;
      void document.body.offsetHeight;
      
      // Wait for font rendering to stabilize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Verify the font is actually being used
      const computedStyle = window.getComputedStyle(testElement);
      const fontFamily = computedStyle.fontFamily;
      results.fontFamilyCheck = fontFamily;
      const isRalewayLoaded = fontFamily.includes('Raleway');
      
      if (!isRalewayLoaded) {
        console.warn('[PDF Service] Raleway font may not be loaded, falling back to system font');
      }
      
      // Remove test element
      testElement.remove();
      
      // Force one more reflow after font verification
      void document.body.offsetHeight;
      
      return results;
    });
    
    console.log('[PDF Service] Font loading status:', fontLoadResult);
    
    let pdfOptions;
    
    if (viewMode === 'page') {
      // Page view mode: Use selected page size with page breaks
      const dimensions = getPageDimensions(pageSize);
      
      // Wait additional time for content to fully render and stabilize
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Force a final reflow to ensure all measurements are accurate
      await page.evaluate(() => {
        void document.body.offsetHeight;
        const container = document.querySelector('.resume-container');
        if (container) {
          void container.offsetHeight;
          const sections = document.querySelectorAll('.resume-section');
          sections.forEach(section => {
            void section.offsetHeight;
            const items = section.querySelectorAll('.experience-item, .education-item, .project-item, .certificate-item, .skill-item');
            items.forEach(item => {
              void item.offsetHeight;
            });
          });
        }
      });
      
      // Wait one more time after forcing reflow
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Log measurements for comparison with preview
      const measurementData = await logPDFMeasurements(page, pageSize);
      
      // Apply page breaks based on measurements
      if (measurementData) {
        await applyPageBreaks(page, measurementData, pageSize);
      }
      
      pdfOptions = {
        format: pageSize === 'A4' ? 'A4' : undefined,
        width: pageSize === 'US Letter' ? `${dimensions.width}mm` : undefined,
        height: pageSize === 'US Letter' ? `${dimensions.height}mm` : undefined,
        printBackground: true,
        margin: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm',
        },
        preferCSSPageSize: true,
      };
    } else {
      // Continuous scroll mode: Measure content and use single page
      await new Promise(resolve => setTimeout(resolve, 200));
      console.log('[PDF Service] Measuring content height for continuous mode...');
      const contentHeight = await measureContentHeight(page);
      const dimensions = getPageDimensions(pageSize);
      
      // Convert measured height from px to mm
      const heightMm = pxToMm(contentHeight);
      
      console.log('[PDF Service] Continuous mode PDF options:', {
        contentHeightPx: contentHeight,
        heightMm,
        pageWidth: dimensions.width,
        pageSize,
      });
      
      pdfOptions = {
        width: `${dimensions.width}mm`,
        height: `${heightMm}mm`,
        printBackground: true,
        margin: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm',
        },
        preferCSSPageSize: false,
      };
    }
    
    // Generate PDF with timeout
    const pdfBuffer = await Promise.race([
      page.pdf(pdfOptions),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('PDF generation timeout')), 30000)
      ),
    ]);
    
    res.set('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBuffer));
    
    console.log('[PDF Service] PDF generated successfully');
    
  } catch (error) {
    console.error('[PDF Service] Error generating PDF:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF', 
      message: error.message 
    });
  } finally {
    // Always close the page and browser
    if (page) {
      try {
        await page.close();
      } catch (error) {
        console.error('[PDF Service] Error closing page:', error);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('[PDF Service] Error closing browser:', error);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[PDF Service] Server running on port ${PORT}`);
});

