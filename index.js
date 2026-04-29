const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Check if we're in a serverless environment (Render.com, Vercel, etc.)
const isServerless = !!process.env.RENDER || !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const app = express();
app.use(express.json({ limit: '10mb' }));

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

// Apply page breaks using preview-style unit pagination.
async function applyPreviewPaginationBreaks(page, pageSize, templateId, pagePaddingMm) {
  const dimensions = getPageDimensions(pageSize);
  const resolvedPadding = {
    top: Number.isFinite(pagePaddingMm?.top) ? pagePaddingMm.top : 10,
    right: Number.isFinite(pagePaddingMm?.right) ? pagePaddingMm.right : 10,
    bottom: Number.isFinite(pagePaddingMm?.bottom) ? pagePaddingMm.bottom : 10,
    left: Number.isFinite(pagePaddingMm?.left) ? pagePaddingMm.left : 10,
  };
  const verticalPadding = resolvedPadding.top + resolvedPadding.bottom;
  // Match app preview/export geometry: width uses the canonical "double horizontal"
  // calculation while page wrappers still render with 10mm visual padding per side.
  const horizontalPadding = (resolvedPadding.left + resolvedPadding.right) * 2;
  const usableHeightPx = (dimensions.height - verticalPadding) * 3.779;
  const usableWidthPx = (dimensions.width - horizontalPadding) * 3.779;
  const editorClasses = `ProseMirror tiptap-editor preview-mode template-${templateId || 'classic'}`;
  const SMALL_BLOCK_RATIO = 0.25;
  
  await page.evaluate(({ usableHeightPx, usableWidthPx, editorClasses, SMALL_BLOCK_RATIO, dimensions, resolvedPadding }) => {
    const container = document.querySelector('.resume-container');
    if (!container) return;

    // If the incoming HTML is already pre-paginated (app generated .pages-container/.export-page),
    // we skip pagination to avoid duplicating work and drifting page layout.
    const exportPagesContainer = document.querySelector(
      '.pages-container.export-pages-container',
    );
    if (exportPagesContainer && exportPagesContainer.querySelector('.export-page')) {
      // Keep existing pre-paginated pages consistent with requested margin contract.
      const existingPages = exportPagesContainer.querySelectorAll('.export-page');
      existingPages.forEach((pageEl) => {
        pageEl.style.padding = `${resolvedPadding.top}mm ${resolvedPadding.right}mm ${resolvedPadding.bottom}mm ${resolvedPadding.left}mm`;
      });
      return;
    }
    
    const containerEl = container;
    const blocks = Array.from(containerEl.children);
    if (blocks.length === 0) return;
    
    const isHeading = (el) => /^H[1-6]$/.test(el.tagName.toUpperCase());
    
    const measureHeightLikePreview = (element, containerWidthPx, cssClasses) => {
      if (element.isConnected && element.parentElement) {
        const parentWidth = element.parentElement.getBoundingClientRect().width;
        if (Math.abs(parentWidth - containerWidthPx) < 10) {
          void element.offsetHeight;
          const directHeight = element.scrollHeight || element.offsetHeight;
          if (directHeight > 0) {
            return directHeight;
          }
        }
      }

      const tempContainer = document.createElement('div');
      tempContainer.style.width = `${containerWidthPx}px`;
      tempContainer.style.position = 'absolute';
      tempContainer.style.visibility = 'hidden';
      tempContainer.style.top = '-9999px';
      tempContainer.style.left = '-9999px';
      tempContainer.style.boxSizing = 'border-box';

      const editorContainer = document.createElement('div');
      editorContainer.className = 'tiptap-editor-container';
      editorContainer.style.width = '100%';
      editorContainer.style.boxSizing = 'border-box';

      const wrapper = document.createElement('div');
      wrapper.style.width = '100%';
      wrapper.style.boxSizing = 'border-box';
      wrapper.style.minHeight = '0';
      wrapper.style.height = 'auto';
      if (cssClasses) {
        wrapper.className = cssClasses;
      }

      const cloned = element.cloneNode(true);
      wrapper.appendChild(cloned);
      editorContainer.appendChild(wrapper);
      tempContainer.appendChild(editorContainer);
      document.body.appendChild(tempContainer);

      void tempContainer.offsetHeight;
      void wrapper.offsetHeight;
      void cloned.offsetHeight;

      const measuredHeight = cloned.scrollHeight || cloned.offsetHeight;
      tempContainer.remove();
      return measuredHeight;
    };

    const measureUnit = (elements) => {
      const wrapper = document.createElement('div');
      for (const el of elements) {
        wrapper.appendChild(el.cloneNode(true));
      }
      return measureHeightLikePreview(wrapper, usableWidthPx, editorClasses);
    };

    const splitOversizedDomBlock = (block, maxChunkHeightPx) => {
      if (block.children.length < 2) return null;
      if (block.getBoundingClientRect().height < usableHeightPx * 0.45) {
        return null;
      }

      const childNodes = Array.from(block.children);
      const chunks = [];
      let currentChunk = block.cloneNode(false);
      let hasAny = false;

      for (const child of childNodes) {
        const testChunk = currentChunk.cloneNode(true);
        testChunk.appendChild(child.cloneNode(true));
        const testHeight = measureUnit([testChunk]);

        if (testHeight <= maxChunkHeightPx) {
          currentChunk.appendChild(child.cloneNode(true));
          hasAny = true;
          continue;
        }

        if (!hasAny) {
          return null;
        }

        chunks.push(currentChunk);
        currentChunk = block.cloneNode(false);
        currentChunk.appendChild(child.cloneNode(true));
        hasAny = true;
      }

      if (currentChunk.children.length > 0) {
        chunks.push(currentChunk);
      }

      return chunks.length > 1 ? chunks : null;
    };

    let units = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const next = blocks[i + 1];

      if (isHeading(block) && next) {
        const nextHeight = measureUnit([next]);
        if (nextHeight <= usableHeightPx * SMALL_BLOCK_RATIO) {
          const pair = [block, next];
          units.push({ elements: pair, height: measureUnit(pair) });
          i++;
          continue;
        }
      }

      units.push({ elements: [block], height: measureUnit([block]) });
    }

    const createNewPage = () => {
      const pageEl = document.createElement('div');
      pageEl.className = 'page paginated export-page';
      pageEl.style.width = `${dimensions.width}mm`;
      pageEl.style.height = `${dimensions.height}mm`;
      pageEl.style.minWidth = `${dimensions.width}mm`;
      pageEl.style.maxWidth = `${dimensions.width}mm`;
      pageEl.style.minHeight = `${dimensions.height}mm`;
      pageEl.style.maxHeight = `${dimensions.height}mm`;
      pageEl.style.boxSizing = 'border-box';
      pageEl.style.overflow = 'hidden';
      pageEl.style.padding = `${resolvedPadding.top}mm ${resolvedPadding.right}mm ${resolvedPadding.bottom}mm ${resolvedPadding.left}mm`;
      pageEl.style.borderRadius = '0';
      pageEl.style.boxShadow = 'none';
      pageEl.style.background = 'white';
      pageEl.style.margin = '0';

      const proseMirror = document.createElement('div');
      proseMirror.className = editorClasses;
      proseMirror.style.width = '100%';
      proseMirror.style.height = 'auto';
      proseMirror.style.minHeight = '100%';
      proseMirror.style.padding = '0';
      proseMirror.style.margin = '0';
      proseMirror.style.boxSizing = 'border-box';
      pageEl.appendChild(proseMirror);

      return { page: pageEl, contentParent: proseMirror };
    };

    const pagesContainer = document.createElement('div');
    pagesContainer.className = 'pages-container export-pages-container';
    pagesContainer.style.display = 'flex';
    pagesContainer.style.flexDirection = 'column';
    pagesContainer.style.alignItems = 'stretch';
    pagesContainer.style.gap = '0';
    pagesContainer.style.background = 'white';

    let current = createNewPage();
    let currentHeight = 0;
    let i = 0;

    while (i < units.length) {
      const unit = units[i];

      if (currentHeight + unit.height <= usableHeightPx) {
        for (const el of unit.elements) {
          current.contentParent.appendChild(el.cloneNode(true));
        }
        currentHeight += unit.height;
        i++;
        continue;
      }

      if (unit.elements.length === 1) {
        const remainingHeight = usableHeightPx - currentHeight;
        const splitTargetHeight = currentHeight > 0 ? remainingHeight : usableHeightPx;
        const split = splitOversizedDomBlock(unit.elements[0], splitTargetHeight);
        if (split) {
          units.splice(
            i,
            1,
            ...split.map((chunk) => ({
              elements: [chunk],
              height: measureUnit([chunk]),
            }))
          );
          continue;
        }
      }

      if (currentHeight === 0) {
        for (const el of unit.elements) {
          current.contentParent.appendChild(el.cloneNode(true));
        }
        currentHeight = unit.height;
        i++;
        continue;
      }

      if (current.contentParent.children.length > 0) {
        pagesContainer.appendChild(current.page);
      }
      current = createNewPage();
      currentHeight = 0;
    }

    if (current.contentParent.children.length > 0) {
      pagesContainer.appendChild(current.page);
    }

    if (pagesContainer.children.length === 0) {
      const empty = createNewPage();
      pagesContainer.appendChild(empty.page);
    }

    const exportRoot = containerEl.closest('.tiptap-editor-container') || containerEl;
    if (exportRoot.parentElement) {
      exportRoot.parentElement.replaceChild(pagesContainer, exportRoot);
    }
  }, {
    usableHeightPx,
    usableWidthPx,
    editorClasses,
    SMALL_BLOCK_RATIO,
    dimensions,
    resolvedPadding,
  });
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
    const { html, templateId, previewViewMode, previewPageSize, marginMm, pagePaddingMm } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: 'Missing required field: html' });
    }
    
    const viewMode = previewViewMode || 'page';
    const pageSize = previewPageSize || 'A4';
    const resolvedMarginMm = {
      top: Number.isFinite(marginMm?.top) ? marginMm.top : 10,
      right: Number.isFinite(marginMm?.right) ? marginMm.right : 10,
      bottom: Number.isFinite(marginMm?.bottom) ? marginMm.bottom : 10,
      left: Number.isFinite(marginMm?.left) ? marginMm.left : 10,
    };
    const resolvedPagePaddingMm = {
      top: Number.isFinite(pagePaddingMm?.top) ? pagePaddingMm.top : 10,
      right: Number.isFinite(pagePaddingMm?.right) ? pagePaddingMm.right : 10,
      bottom: Number.isFinite(pagePaddingMm?.bottom) ? pagePaddingMm.bottom : 10,
      left: Number.isFinite(pagePaddingMm?.left) ? pagePaddingMm.left : 10,
    };
    
    console.log('[PDF Service] Starting PDF generation:', {
      templateId,
      viewMode,
      pageSize,
      marginMm: resolvedMarginMm,
      pagePaddingMm: resolvedPagePaddingMm,
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
    // Keep viewport math aligned with app pdf-generator.ts and smart-page-splitter.ts.
    const horizontalPadding =
      (resolvedPagePaddingMm.left + resolvedPagePaddingMm.right) * 2;
    const verticalPadding = resolvedPagePaddingMm.top + resolvedPagePaddingMm.bottom;
    const pageWidthPx = ((dimensions.width - horizontalPadding) * 3.779);
    const pageHeightPx = ((dimensions.height - verticalPadding) * 3.779);
    
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
      
      await applyPreviewPaginationBreaks(
        page,
        pageSize,
        templateId,
        resolvedPagePaddingMm,
      );
      
      pdfOptions = {
        format: pageSize === 'A4' ? 'A4' : undefined,
        width: pageSize === 'US Letter' ? `${dimensions.width}mm` : undefined,
        height: pageSize === 'US Letter' ? `${dimensions.height}mm` : undefined,
        printBackground: true,
        margin: {
          top: `${resolvedMarginMm.top}mm`,
          right: `${resolvedMarginMm.right}mm`,
          bottom: `${resolvedMarginMm.bottom}mm`,
          left: `${resolvedMarginMm.left}mm`,
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
          top: `${resolvedMarginMm.top}mm`,
          right: `${resolvedMarginMm.right}mm`,
          bottom: `${resolvedMarginMm.bottom}mm`,
          left: `${resolvedMarginMm.left}mm`,
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

