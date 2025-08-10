import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import axios from "axios";
import dotenv from "dotenv";
import { Worker } from "worker_threads";
import { promisify } from "util";
import compression from "compression";
import cluster from "cluster";
import os from "os";
import helmet from "helmet";
import rateLimit from "express-rate-limit";


dotenv.config();

const PORT = 4000;
const app = express();

// Enhanced caching with multiple layers
const cache = new NodeCache({ 
  stdTTL: 300, // 5 minutes
  checkperiod: 60, // Check for expired keys every minute
  useClones: false, // Disable cloning for better performance
  maxKeys: 1000 // Limit cache size
});

// Page cache for faster repeated requests
const pageCache = new NodeCache({ 
  stdTTL: 600, // 10 minutes for pages
  maxKeys: 500 
});

// Browser pool configuration
const BROWSER_POOL_SIZE = 3;
const MAX_PAGES_PER_BROWSER = 10;
let browserPool = [];
let availablePages = [];
let busyPages = new Set();


// Enhanced cache with longer TTL and more aggressive caching
const cache = new NodeCache({
  stdTTL: 1800, // 30 minutes
  checkperiod: 120, // Check for expired keys every 2 minutes
  useClones: false, // Avoid deep cloning for better performance
  maxKeys: 1000, // Limit memory usage
});

// Performance optimized cache for exchange rates
const exchangeRateCache = new NodeCache({
  stdTTL: 3600, // 1 hour for exchange rates
  maxKeys: 10,
});

let EURO_AZN = 1.8;
let USD_AZN = 1.7;
let browserLaunchAttempts = 0;
const MAX_BROWSER_LAUNCH_ATTEMPTS = 3;
const BROWSER_RETRY_DELAY = 5000; // 5 seconds

// Performance monitoring
const performanceMetrics = {
  requestCount: 0,
  totalResponseTime: 0,
  averageResponseTime: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errorCount: 0,
  browserPoolStats: {
    activeBrowsers: 0,
    availablePages: 0,
    busyPages: 0
  }
};

// Enhanced logging utility with performance tracking

class Logger {
  static info(message, data = null) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[INFO] ${new Date().toISOString()} - ${message}`,
        data || ""
      );
    }
  }

  static error(message, error = null) {
    console.error(
      `[ERROR] ${new Date().toISOString()} - ${message}`,
      error || ""
    );
    performanceMetrics.errorCount++;
  }

  static warn(message, data = null) {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data || "");
  }

  static perf(message, duration = null) {
    console.log(`[PERF] ${new Date().toISOString()} - ${message}${duration ? ` (${duration}ms)` : ""}`);
  }
}


  static perf(operation, duration) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[PERF] ${operation}: ${duration}ms`);
    }
  }
}

// Performance monitoring middleware
app.use((req, res, next) => {
  req.startTime = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - req.startTime;
    if (duration > 1000) {
      // Log slow requests
      Logger.warn(`Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
  });
  next();
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: "Too many requests",
    message: "Please try again later"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Middleware optimizations
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: [process.env.SOCKET_API, process.env.CLIENT_ORIGIN],
  credentials: true,
  optionsSuccessStatus: 200
}));

// Performance monitoring middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  performanceMetrics.requestCount++;
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    performanceMetrics.totalResponseTime += duration;
    performanceMetrics.averageResponseTime = 
      performanceMetrics.totalResponseTime / performanceMetrics.requestCount;
    
    if (duration > 5000) { // Log slow requests
      Logger.warn(`Slow request detected: ${req.method} ${req.path} took ${duration}ms`);
    }
    
    // Trigger garbage collection for long requests
    if (duration > 10000 && global.gc) {
      setImmediate(() => {
        global.gc();
        Logger.info("Garbage collection triggered after long request");
      });
    }
  });
  
  next();
});

// Memory management
const cleanupInterval = setInterval(() => {
  // Clean up old pages in the pool
  const now = Date.now();
  const maxPageAge = 10 * 60 * 1000; // 10 minutes
  
  availablePages = availablePages.filter(pageInfo => {
    if (now - pageInfo.lastUsed > maxPageAge) {
      try {
        pageInfo.page.close();
        Logger.info(`Closed aged page from browser ${pageInfo.browserId}`);
        return false;
      } catch (error) {
        Logger.error("Error closing aged page:", error.message);
        return false;
      }
    }
    return true;
  });
  
  // Update metrics
  performanceMetrics.browserPoolStats.availablePages = availablePages.length;
  
  // Force garbage collection if memory usage is high
  if (global.gc && process.memoryUsage().heapUsed > 500 * 1024 * 1024) { // > 500MB
    global.gc();
    Logger.info("Garbage collection triggered due to high memory usage");
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Clear cleanup interval on shutdown
process.on('exit', () => {
  clearInterval(cleanupInterval);
});

// Cache warming functionality
async function warmCache() {
  Logger.info("Starting cache warming...");
  
  try {
    // Warm up exchange rates
    await Promise.allSettled([getEuroConverts(), getUsdConverts()]);
    
    // Warm up random cars cache for different quantities
    const warmUpSizes = [5, 10, 20];
    for (const size of warmUpSizes) {
      try {
        await getRandomCars(size);
        Logger.info(`Cache warmed for ${size} random cars`);
      } catch (error) {
        Logger.error(`Failed to warm cache for ${size} cars:`, error.message);
      }
    }
    
    Logger.info("Cache warming completed");
  } catch (error) {
    Logger.error("Cache warming failed:", error.message);
  }
}

// Schedule cache warming
const cacheWarmingInterval = setInterval(warmCache, 30 * 60 * 1000); // Every 30 minutes

// Clear cache warming interval on shutdown
process.on('exit', () => {
  clearInterval(cacheWarmingInterval);
});

// Enhanced browser pool management
async function initializeBrowserPool() {
  Logger.info("Initializing browser pool...");
  
  for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
    try {
      const browser = await launchOptimizedBrowser();
      browserPool.push({
        browser,
        pages: [],
        id: i,
        createdAt: Date.now(),
        lastUsed: Date.now()
      });
      
      // Pre-create pages for each browser
      for (let j = 0; j < MAX_PAGES_PER_BROWSER; j++) {
        const page = await createOptimizedPage(browser);
        availablePages.push({
          page,
          browserId: i,
          createdAt: Date.now(),
          lastUsed: Date.now()
        });
      }
      
      Logger.info(`Browser ${i} initialized with ${MAX_PAGES_PER_BROWSER} pages`);
    } catch (error) {
      Logger.error(`Failed to initialize browser ${i}:`, error.message);
    }
  }
  
  performanceMetrics.browserPoolStats.activeBrowsers = browserPool.length;
  performanceMetrics.browserPoolStats.availablePages = availablePages.length;
  
  Logger.info(`Browser pool initialized: ${browserPool.length} browsers, ${availablePages.length} pages`);
}

// Optimized browser launch with better configuration
async function launchOptimizedBrowser() {
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    null, // Let Puppeteer find its own browser
  ].filter((path) => path !== undefined);

  for (const executablePath of chromiumPaths) {
    try {
      Logger.info(`Launching optimized browser with path: ${executablePath}`);

      const launchOptions = {
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-networking",
          "--disable-background-media-processing",
          "--disable-hang-monitor",
          "--disable-client-side-phishing-detection",
          "--disable-popup-blocking",
          "--disable-sync",
          "--disable-translate",
          "--disable-component-update",
          "--memory-pressure-off",
          "--max_old_space_size=4096"
        ],
        timeout: 30000,
        ignoreDefaultArgs: ['--disable-extensions'],
        defaultViewport: {
          width: 1366,
          height: 768
        }
      };

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      const browser = await puppeteer.launch(launchOptions);
      Logger.info(`Optimized browser launched successfully with path: ${executablePath}`);
      return browser;
    } catch (error) {
      Logger.error(`Failed to launch browser with path ${executablePath}:`, error.message);
    }
  }
  
  throw new BrowserLaunchError("Failed to launch browser with all available paths", null);
}

// Create optimized page with enhanced settings
async function createOptimizedPage(browser) {
  const page = await browser.newPage();
  
  // Set aggressive timeouts for faster operation
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  
  // Enhanced request interception for maximum speed
  await page.setRequestInterception(true);
  
  // Create a more comprehensive blocklist
  const blockedDomains = new Set([
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.com',
    'doubleclick.net',
    'googlesyndication.com',
    'adsystem.com',
    'amazon-adsystem.com',
    'criteo.com',
    'outbrain.com',
    'taboola.com',
    'addthis.com',
    'sharethis.com',
    'hotjar.com',
    'fullstory.com',
    'crazyegg.com'
  ]);
  
  const blockedResourceTypes = new Set([
    'image', 'stylesheet', 'font', 'media', 'websocket', 
    'manifest', 'other', 'eventsource'
  ]);
  
  const blockedKeywords = new Set([
    'ads', 'analytics', 'tracking', 'gtm', 'pixel', 
    'beacon', 'metrics', 'telemetry', 'social'
  ]);
  
  page.on("request", (req) => {
    try {
      const resourceType = req.resourceType();
      const url = req.url().toLowerCase();
      
      // Block by resource type
      if (blockedResourceTypes.has(resourceType)) {
        req.abort();
        return;
      }
      
      // Block by domain
      const hostname = new URL(url).hostname;
      if (blockedDomains.has(hostname)) {
        req.abort();
        return;
      }
      
      // Block by URL keywords
      if ([...blockedKeywords].some(keyword => url.includes(keyword))) {
        req.abort();
        return;
      }
      
      // Block large files that might slow down the process
      if (url.includes('.mp4') || url.includes('.avi') || 
          url.includes('.mov') || url.includes('.pdf') ||
          url.includes('.zip') || url.includes('.exe')) {
        req.abort();
        return;
      }
      
      req.continue();
    } catch (error) {
      Logger.error("Request interception error:", error.message);
      try {
        req.continue();
      } catch (e) {
        // Request might already be handled
      }
    }
  });
  
  // Disable images and CSS for faster loading
  await page.setRequestInterception(true);
  
  // Set user agent to avoid bot detection
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  
  // Optimize page settings
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });
  
  return page;
}

// Get page from pool with automatic management
async function getPageFromPool() {
  const startTime = Date.now();
  
  if (availablePages.length === 0) {
    Logger.warn("No available pages in pool, creating new page...");
    
    // Try to get a browser with available capacity
    const availableBrowser = browserPool.find(b => b.pages.length < MAX_PAGES_PER_BROWSER);
    if (availableBrowser) {
      const page = await createOptimizedPage(availableBrowser.browser);
      const pageInfo = {
        page,
        browserId: availableBrowser.id,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      
      availableBrowser.pages.push(pageInfo);
      Logger.perf("New page created", Date.now() - startTime);
      return pageInfo;
    } else {
      throw new Error("Browser pool exhausted");
    }
  }
  
  const pageInfo = availablePages.pop();
  pageInfo.lastUsed = Date.now();
  busyPages.add(pageInfo);
  
  performanceMetrics.browserPoolStats.availablePages = availablePages.length;
  performanceMetrics.browserPoolStats.busyPages = busyPages.size;
  
  Logger.perf("Page acquired from pool", Date.now() - startTime);
  return pageInfo;
}

// Return page to pool
function returnPageToPool(pageInfo) {
  busyPages.delete(pageInfo);
  pageInfo.lastUsed = Date.now();
  availablePages.push(pageInfo);
  
  performanceMetrics.browserPoolStats.availablePages = availablePages.length;
  performanceMetrics.browserPoolStats.busyPages = busyPages.size;
}

// Enhanced browser launch with retry logic and multiple fallback paths
async function launchBrowser() {
  // Use browser pool instead
  if (browserPool.length === 0) {
    await initializeBrowserPool();
  }
  
  return browserPool[0]?.browser;
}

// Enhanced page creation with error handling
async function getPage() {
  try {
    const pageInfo = await getPageFromPool();
    return pageInfo.page;
  } catch (error) {
    Logger.error("Failed to get page from pool:", error.message);
    throw error;
  }
}

// Enhanced random cars fetching with comprehensive error handling and caching
async function getRandomCars(numberOfCars) {
  const cacheKey = `randomCars_${numberOfCars}`;
  const cachedResult = cache.get(cacheKey);
  
  if (cachedResult) {
    performanceMetrics.cacheHits++;
    Logger.info(`Cache hit for random cars (${numberOfCars})`);
    return cachedResult;
  }
  
  performanceMetrics.cacheMisses++;
  let pageInfo;
  
  try {
    pageInfo = await getPageFromPool();
    const page = pageInfo.page;
    const randomPage = Math.floor(Math.random() * 20) + 1;
    const url = `https://turbo.az/autos?pages=${randomPage}`;

    Logger.info(`Fetching car URLs from page ${randomPage}`);

    const startTime = Date.now();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Wait for content to load with reduced timeout
    await page.waitForSelector(".products-i", { timeout: 8000 });


    const carUrls = await page.evaluate((numberOfCars) => {
      const links = document.querySelectorAll(".products-i__link");
      const urls = Array.from(links, (link) => link.href).filter(Boolean);

      // Fast random sampling using Fisher-Yates shuffle (partial)
      const result = [];
      const maxItems = Math.min(urls.length, numberOfCars);

      for (let i = 0; i < maxItems; i++) {
        const randomIndex = i + Math.floor(Math.random() * (urls.length - i));
        [urls[i], urls[randomIndex]] = [urls[randomIndex], urls[i]];
        result.push(urls[i]);
      }

      return result;
    }, numberOfCars);

    Logger.perf(`Found ${carUrls.length} car URLs`, Date.now() - startTime);
    
    // Cache the result
    cache.set(cacheKey, carUrls, 180); // Cache for 3 minutes
    

    return carUrls;
  } finally {
    if (pageInfo) {
      returnPageToPool(pageInfo);
    }
  }
}

// Enhanced car info fetching with retry logic and caching
async function getCarInfo(carUrl, retryCount = 0) {
  const MAX_RETRIES = 2;
  const cacheKey = `carInfo_${Buffer.from(carUrl).toString('base64').slice(0, 20)}`;
  
  // Check cache first
  const cachedResult = pageCache.get(cacheKey);
  if (cachedResult) {
    performanceMetrics.cacheHits++;
    Logger.info(`Cache hit for car info: ${carUrl}`);
    return cachedResult;
  }
  
  performanceMetrics.cacheMisses++;
  let pageInfo;

  try {
    pageInfo = await getPageFromPool();
    const page = pageInfo.page;
    Logger.info(`Fetching car info from: ${carUrl}`);

    const startTime = Date.now();
    await page.goto(carUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Wait for essential content with reduced timeout
    await page.waitForSelector(".product-title", { timeout: 8000 });

    const carInfo = await page.evaluate(
      (USD_AZN, EURO_AZN) => {
        const getManatPrice = (priceText) => {
          if (!priceText) return null;
          try {
            const parts = priceText.trim().split(" ");
            const currency = parts[parts.length - 1];
            const value = parseFloat(
              parts.slice(0, -1).join("").replace(/,/g, "")
            );

            if (isNaN(value)) return null;

            switch (currency) {
              case "AZN":
                return value;
              case "USD":
                return Math.round(value * USD_AZN);
              case "EUR":
                return Math.round(value * EURO_AZN);
              default:
                return null;
            }
          } catch {
            return null;
          }
        };

        try {
          return {
            title:
              document
                .querySelector(".product-title")
                ?.textContent?.split(", ")[0] || "Unknown",
            year:
              document.querySelector(
                ".product-properties__i-name[for='ad_reg_year']+span a"
              )?.textContent || "Unknown",
            mileage:
              document
                .querySelector(".product-properties__i-name[for='ad_mileage']")
                ?.nextSibling?.textContent?.trim() || "Unknown",
            engine:
              document
                .querySelector(
                  ".product-properties__i-name[for='ad_engine_volume']"
                )
                ?.nextSibling?.textContent?.trim() || "Unknown",
            transmission:
              document
                .querySelector(
                  ".product-properties__i-name[for='ad_transmission']"
                )
                ?.nextSibling?.textContent?.trim() || "Unknown",
            images: [
              ...document.querySelectorAll(
                ".slick-slide:not(.slick-cloned) img"
              ),
            ]
              .map((elem) => elem.src)
              .filter((src) => src && !src.includes("data:image"))
              .slice(0, 5), // Limit to 5 images for performance
            price:
              getManatPrice(
                document.querySelector(".product-price__i")?.textContent
              ) || "Unknown",
            url: window.location.href,
          };
        } catch (error) {
          console.error("Data extraction error:", error);
          return {
            error: "Failed to extract car data",
            url: window.location.href,
          };
        }
      },
      USD_AZN,
      EURO_AZN
    );

    Logger.perf(`Successfully fetched car info: ${carInfo.title}`, Date.now() - startTime);
    
    // Cache successful results
    if (!carInfo.error) {
      pageCache.set(cacheKey, carInfo, 300); // Cache for 5 minutes
    }
    
    return carInfo;
  } catch (error) {
    Logger.error(
      `Error fetching car info (attempt ${retryCount + 1}):`,
      error.message
    );

    if (retryCount < MAX_RETRIES) {
      Logger.info(`Retrying car info fetch for ${carUrl}...`);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Reduced wait time
      return getCarInfo(carUrl, retryCount + 1);
    }

    return {
      error: "Failed to fetch car details",
      url: carUrl,
      title: "Unknown",
      year: "Unknown",
      mileage: "Unknown",
      engine: "Unknown",
      transmission: "Unknown",
      images: [],
      price: "Unknown",
    };
  } finally {
    if (pageInfo) {
      returnPageToPool(pageInfo);
    }

  }
}

// Optimized exchange rate fetching with better caching
async function updateExchangeRates() {
  const startTime = Date.now();

  const cachedRates = exchangeRateCache.get("rates");
  if (cachedRates) {
    USD_AZN = cachedRates.USD_AZN;
    EURO_AZN = cachedRates.EURO_AZN;
    Logger.perf("Exchange rates cache hit", Date.now() - startTime);
    return;
  }

  try {
    // Fetch both rates in parallel with shorter timeout
    const [usdResponse, eurResponse] = await Promise.allSettled([
      axiosInstance.get(
        "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
      ),
      axiosInstance.get(
        "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json"
      ),
    ]);

    if (usdResponse.status === "fulfilled") {
      USD_AZN = usdResponse.value.data.usd.azn || USD_AZN;
    }

    if (eurResponse.status === "fulfilled") {
      EURO_AZN = eurResponse.value.data.eur.azn || EURO_AZN;
    }

    // Cache the rates
    exchangeRateCache.set("rates", { USD_AZN, EURO_AZN });

    Logger.info(`Exchange rates updated: USD=${USD_AZN}, EUR=${EURO_AZN}`);
    Logger.perf("Exchange rates update", Date.now() - startTime);
  } catch (error) {
    Logger.warn("Failed to update exchange rates, using cached/default values");
  }
}

// Ultra-optimized main endpoint
app.get("/get-random-cars", async (req, res) => {
  const requestStart = Date.now();

  try {
    const numberOfCars = Math.min(parseInt(req.query.number) || 20, 30); // Reduced default and max

    // Check for complete cache hit
    const fullCacheKey = `fullResponse_${numberOfCars}`;
    const cachedResponse = cache.get(fullCacheKey);
    if (cachedResponse) {
      Logger.perf("Full response cache hit", Date.now() - requestStart);
      return res.json(cachedResponse);
    }

    Logger.info(`Processing optimized request for ${numberOfCars} cars`);

    // Get car URLs
    const urlFetchStart = Date.now();
    const carUrls = await getRandomCarsOptimized(numberOfCars);
    Logger.perf("URL fetch", Date.now() - urlFetchStart);

    if (carUrls.length === 0) {
      return res.status(404).json({
        error: "No cars found",
        message: "Unable to fetch car listings",
      });
    }

    // Process cars with optimized concurrency
    const BATCH_SIZE = Math.min(availablePages.length, 8); // Dynamic batch size based on available pages
    const carInfos = [];
    const processingStartTime = Date.now();

    Logger.info(`Processing ${cars.length} cars with batch size ${BATCH_SIZE}`);

    for (let i = 0; i < cars.length; i += BATCH_SIZE) {
      const batch = cars.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(cars.length / BATCH_SIZE);
      
      Logger.info(`Processing batch ${batchNum}/${totalBatches} (${batch.length} cars)`);

      const batchStartTime = Date.now();
      const batchResults = await Promise.allSettled(
        batch.map((car, index) => {
          return Promise.race([
            getCarInfo(car),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), 25000) // 25 second timeout per car
            )
          ]);
        })
      );

      batchResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          carInfos.push(result.value);
        } else {
          Logger.error(
            `Failed to process car ${batch[index]}:`,
            result.reason?.message
          );
          carInfos.push({
            error: "Failed to fetch car details",
            url: batch[index] || "Unknown",
            title: "Unknown",
            year: "Unknown",
            mileage: "Unknown",
            engine: "Unknown",
            transmission: "Unknown",
            images: [],
            price: "Unknown",
          });
        }
      });

      Logger.perf(`Batch ${batchNum} completed`, Date.now() - batchStartTime);

      // Reduced delay between batches for faster processing
      if (i + BATCH_SIZE < cars.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    
    Logger.perf(`Total processing completed`, Date.now() - processingStartTime);

    const carInfoResults = await Promise.allSettled(carInfoPromises);
    const carInfos = carInfoResults.map((result) =>
      result.status === "fulfilled"
        ? result.value
        : {
            error: "Failed to fetch",
            title: "Unknown",
          }
    );

    Logger.perf("Info fetch", Date.now() - infoFetchStart);

    const successfulCars = carInfos.filter((car) => !car.error);

    const response = {
      cars: carInfos,
      stats: {
        requested: numberOfCars,
        found: carUrls.length,
        processed: carInfos.length,
        successful: successfulCars.length,
        failed: carInfos.length - successfulCars.length,
        processingTime: Date.now() - requestStart,
      },
    };

    // Cache successful complete responses
    if (successfulCars.length > 0) {
      cache.set(fullCacheKey, response, 180); // 3 minutes cache
    }

// Enhanced metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    res.json({
      timestamp: new Date().toISOString(),
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memoryUsage.external / 1024 / 1024), // MB
        rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
      },
      cpu: {
        user: Math.round(cpuUsage.user / 1000), // ms
        system: Math.round(cpuUsage.system / 1000), // ms
      },
      performance: performanceMetrics,
      browserPool: {
        totalBrowsers: browserPool.length,
        availablePages: availablePages.length,
        busyPages: busyPages.size,
        totalPages: availablePages.length + busyPages.size,
      },
      cache: {
        mainCache: {
          keys: cache.keys().length,
          stats: cache.getStats(),
        },
        pageCache: {
          keys: pageCache.keys().length,
          stats: pageCache.getStats(),
        }
      },
      uptime: Math.round(process.uptime()),
    });
  } catch (error) {
    Logger.error("Metrics endpoint error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const browserStatus =
      browserPool.length > 0 && browserPool[0]?.browser && !browserPool[0]?.browser.disconnected ? "running" : "stopped";

    const memoryUsage = process.memoryUsage();
    const isHealthy = memoryUsage.heapUsed < 1024 * 1024 * 1024 && // < 1GB
                     browserPool.length > 0 &&
                     performanceMetrics.errorCount < 100;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      browser: browserStatus,
      cache: {
        keys: cache.keys().length,
        stats: cache.getStats(),
      },
      exchangeRates: {
        USD_AZN,
        EURO_AZN,
      },
      performance: performanceMetrics,
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        isHealthy: memoryUsage.heapUsed < 1024 * 1024 * 1024
      }
    });
  } catch (error) {
    Logger.error("Critical error in /get-random-cars:", error.message);

    res.status(500).json({
      error: "Internal server error",
      message: "Service temporarily unavailable",
      code: "INTERNAL_ERROR",
    });
  }
});

// Graceful shutdown handling
process.on("SIGTERM", async () => {
  Logger.info("SIGTERM received, shutting down gracefully...");
  try {
    for (const browserInfo of browserPool) {
      if (browserInfo.browser) {
        await browserInfo.browser.close();
        Logger.info(`Browser ${browserInfo.id} closed successfully`);
      }
    }
    Logger.info("All browsers closed successfully");
  } catch (error) {
    Logger.error("Error during shutdown:", error.message);
  }
  process.exit(0);

});

// Cleanup endpoint for manual cache clearing
app.post("/admin/clear-cache", (req, res) => {
  cache.flushAll();
  exchangeRateCache.flushAll();
  res.json({ message: "Cache cleared successfully" });
});

// Graceful shutdown with proper cleanup
async function gracefulShutdown(signal) {
  Logger.info(`${signal} received, shutting down gracefully...`);

  try {
    for (const browserInfo of browserPool) {
      if (browserInfo.browser) {
        await browserInfo.browser.close();
        Logger.info(`Browser ${browserInfo.id} closed successfully`);
      }
    }
    Logger.info("All browsers closed successfully");
  } catch (error) {
    Logger.error("Error during shutdown:", error.message);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Enhanced error handlers
process.on("unhandledRejection", (reason, promise) => {
  Logger.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  Logger.error("Uncaught Exception:", error.message);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

// Cache management endpoint
app.post("/cache/clear", (req, res) => {
  try {
    const type = req.body.type || 'all';
    
    if (type === 'all' || type === 'main') {
      cache.flushAll();
      Logger.info("Main cache cleared");
    }
    
    if (type === 'all' || type === 'page') {
      pageCache.flushAll();
      Logger.info("Page cache cleared");
    }
    
    res.json({
      status: "success",
      message: `${type} cache cleared`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    Logger.error("Cache clear error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Warm cache endpoint
app.post("/cache/warm", async (req, res) => {
  try {
    await warmCache();
    res.json({
      status: "success",
      message: "Cache warming completed",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    Logger.error("Cache warming error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Server startup with enhanced error handling
app.listen(PORT, async () => {
  try {
    Logger.info(`🚀 Starting optimized server on port ${PORT}...`);

    // Initialize browser pool
    await initializeBrowserPool();
    Logger.info("Browser pool initialized successfully");

    // Initialize exchange rates
    await updateExchangeRates();
    Logger.info("✅ Exchange rates initialized");

    // Initial cache warming
    setImmediate(() => {
      warmCache().catch(error => 
        Logger.error("Initial cache warming failed:", error.message)
      );
    });

    Logger.info(`[SERVER] ExpressJS is listening on http://localhost:${PORT}`);
    Logger.info("Health check available at: /health");
    Logger.info("Metrics available at: /metrics");
    Logger.info("Cache management available at: /cache/clear and /cache/warm");
  } catch (error) {
    Logger.error("❌ Server startup failed:", error.message);
    process.exit(1);
  }
});
