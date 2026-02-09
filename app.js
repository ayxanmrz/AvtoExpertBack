import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import axios from "axios";
import dotenv from "dotenv";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

const PORT = process.env.PORT || 4000;
const ENABLE_SCRAPING = process.env.ENABLE_SCRAPING === "true";
const app = express();

console.log(`Scraping ${ENABLE_SCRAPING ? "ENABLED" : "DISABLED"}`);

const MONGO_URI = process.env.MONGO_URI;

console.log(`Connecting to MongoDB at ${MONGO_URI}`);

const client = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let carDataCollection;

async function connectDB() {
  try {
    await client.connect();
    const database = client.db("cardb");
    // Send a ping to confirm a successful connection
    carDataCollection = database.collection("car_datas");
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    throw new Error("Database connection failed");
  }
}

async function insertCars(carDatas) {
  try {
    const result = await carDataCollection.insertMany(carDatas, {
      ordered: false,
    });
    console.log(
      "Inserted:",
      result.insertedCount,
      "documents into the collection",
    );
  } catch (err) {
    if (err.code === 11000) {
      console.log("Some duplicates were skipped.");
    } else {
      throw err;
    }
  }
}

await connectDB();

// Enhanced caching with multiple layers
const cache = new NodeCache({
  stdTTL: 300, // 5 minutes
  checkperiod: 60, // Check for expired keys every minute
  useClones: false, // Disable cloning for better performance
  maxKeys: 1000, // Limit cache size
});

// Page cache for faster repeated requests
const pageCache = new NodeCache({
  stdTTL: 600, // 10 minutes for pages
  maxKeys: 500,
});

// Browser pool configuration
const BROWSER_POOL_SIZE = 1;
const MAX_PAGES_PER_BROWSER = 5;
let browserPool = [];
let availablePages = [];
let busyPages = new Set();
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
    busyPages: 0,
  },
};

// Enhanced logging utility with performance tracking
class Logger {
  static info(message, data = null) {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data || "");
  }

  static error(message, error = null) {
    console.error(
      `[ERROR] ${new Date().toISOString()} - ${message}`,
      error || "",
    );
    performanceMetrics.errorCount++;
  }

  static warn(message, data = null) {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data || "");
  }

  static perf(message, duration = null) {
    console.log(
      `[PERF] ${new Date().toISOString()} - ${message}${
        duration ? ` (${duration}ms)` : ""
      }`,
    );
  }
}

// Custom error classes
class BrowserLaunchError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = "BrowserLaunchError";
    this.originalError = originalError;
  }
}

class PageProcessingError extends Error {
  constructor(message, url, originalError) {
    super(message);
    this.name = "PageProcessingError";
    this.url = url;
    this.originalError = originalError;
  }
}

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable CSP for API
    crossOriginEmbedderPolicy: false,
  }),
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: "Too many requests",
    message: "Please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Middleware optimizations
app.use(
  compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: [process.env.SOCKET_API, process.env.CLIENT_ORIGIN],
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

// Performance monitoring middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  performanceMetrics.requestCount++;

  res.on("finish", () => {
    const duration = Date.now() - startTime;
    performanceMetrics.totalResponseTime += duration;
    performanceMetrics.averageResponseTime =
      performanceMetrics.totalResponseTime / performanceMetrics.requestCount;

    if (duration > 5000) {
      // Log slow requests
      Logger.warn(
        `Slow request detected: ${req.method} ${req.path} took ${duration}ms`,
      );
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
const cleanupInterval = setInterval(
  async () => {
    // Clean up old pages in the pool
    const now = Date.now();
    const maxPageAge = 10 * 60 * 1000; // 10 minutes

    const pagesToRemove = [];
    availablePages = availablePages.filter((pageInfo) => {
      if (now - pageInfo.lastUsed > maxPageAge) {
        pagesToRemove.push(pageInfo);
        return false;
      }
      return true;
    });

    // Clean up and close aged pages
    for (const pageInfo of pagesToRemove) {
      try {
        await cleanupPage(pageInfo.page);
        await pageInfo.page.close();
        Logger.info(`Closed aged page from browser ${pageInfo.browserId}`);
      } catch (error) {
        Logger.error("Error closing aged page:", error.message);
      }
    }

    // Update metrics
    performanceMetrics.browserPoolStats.availablePages = availablePages.length;

    // Force garbage collection if memory usage is high
    if (global.gc && process.memoryUsage().heapUsed > 500 * 1024 * 1024) {
      // > 500MB
      global.gc();
      Logger.info("Garbage collection triggered due to high memory usage");
    }
  },
  5 * 60 * 1000,
); // Every 5 minutes

// Cache warming functionality
async function warmCache() {
  Logger.info("Starting cache warming...");

  try {
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

// Schedule cache warming - ONLY if scraping is enabled
let cacheWarmingInterval;
if (ENABLE_SCRAPING) {
  cacheWarmingInterval = setInterval(warmCache, 30 * 60 * 1000); // Every 30 minutes
  console.log("Cache warming interval started");
} else {
  console.log("Cache warming disabled (ENABLE_SCRAPING=false)");
}

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
        lastUsed: Date.now(),
      });

      // Pre-create pages for each browser
      for (let j = 0; j < MAX_PAGES_PER_BROWSER; j++) {
        const page = await createOptimizedPage(browser);
        availablePages.push({
          page,
          browserId: i,
          createdAt: Date.now(),
          lastUsed: Date.now(),
        });
      }

      Logger.info(
        `Browser ${i} initialized with ${MAX_PAGES_PER_BROWSER} pages`,
      );
    } catch (error) {
      Logger.error(`Failed to initialize browser ${i}:`, error.message);
    }
  }

  performanceMetrics.browserPoolStats.activeBrowsers = browserPool.length;
  performanceMetrics.browserPoolStats.availablePages = availablePages.length;

  Logger.info(
    `Browser pool initialized: ${browserPool.length} browsers, ${availablePages.length} pages`,
  );
}

// Optimized browser launch with better configuration
async function launchOptimizedBrowser() {
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    puppeteer.executablePath(),
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
          "--max_old_space_size=4096",
        ],
        timeout: 30000,
        ignoreDefaultArgs: ["--disable-extensions"],
        defaultViewport: {
          width: 1366,
          height: 768,
        },
      };

      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      const browser = await puppeteer.launch(launchOptions);
      Logger.info(
        `Optimized browser launched successfully with path: ${executablePath}`,
      );
      return browser;
    } catch (error) {
      Logger.error(
        `Failed to launch browser with path ${executablePath}:`,
        error.message,
      );
    }
  }

  throw new BrowserLaunchError(
    "Failed to launch browser with all available paths",
    null,
  );
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
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.com",
    "doubleclick.net",
    "googlesyndication.com",
    "adsystem.com",
    "amazon-adsystem.com",
    "criteo.com",
    "outbrain.com",
    "taboola.com",
    "addthis.com",
    "sharethis.com",
    "hotjar.com",
    "fullstory.com",
    "crazyegg.com",
  ]);

  const blockedResourceTypes = new Set([
    "image",
    "stylesheet",
    "font",
    "media",
    "websocket",
    "manifest",
    "other",
    "eventsource",
  ]);

  const blockedKeywords = new Set([
    "ads",
    "analytics",
    "tracking",
    "gtm",
    "pixel",
    "beacon",
    "metrics",
    "telemetry",
    "social",
  ]);

  // Store the handler so we can remove it later
  const requestHandler = (req) => {
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
      if ([...blockedKeywords].some((keyword) => url.includes(keyword))) {
        req.abort();
        return;
      }

      // Block large files that might slow down the process
      if (
        url.includes(".mp4") ||
        url.includes(".avi") ||
        url.includes(".mov") ||
        url.includes(".pdf") ||
        url.includes(".zip") ||
        url.includes(".exe")
      ) {
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
  };

  page.on("request", requestHandler);

  // Store handler reference for cleanup
  page._customRequestHandler = requestHandler;

  // Set user agent to avoid bot detection
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  );

  // Optimize page settings
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  return page;
}

// Clean up page resources before returning to pool or closing
async function cleanupPage(page) {
  try {
    if (!page || page.isClosed()) return;

    // Remove custom event listener
    if (page._customRequestHandler) {
      page.removeListener("request", page._customRequestHandler);
      page._customRequestHandler = null;
    }

    // Remove all other listeners to prevent memory leaks
    page.removeAllListeners();

    // Navigate to blank page to clear any residual state
    try {
      await page.goto("about:blank", {
        waitUntil: "domcontentloaded",
        timeout: 3000,
      });
    } catch (e) {
      // Ignore navigation errors
    }
  } catch (error) {
    Logger.error("Error cleaning up page:", error.message);
  }
}

// Get page from pool with automatic management
async function getPageFromPool() {
  const startTime = Date.now();

  if (availablePages.length === 0) {
    Logger.warn("No available pages in pool, creating new page...");

    // Try to get a browser with available capacity
    const availableBrowser = browserPool.find(
      (b) => b.pages.length < MAX_PAGES_PER_BROWSER,
    );
    if (availableBrowser) {
      const page = await createOptimizedPage(availableBrowser.browser);
      const pageInfo = {
        page,
        browserId: availableBrowser.id,
        createdAt: Date.now(),
        lastUsed: Date.now(),
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

// Return page to pool with cleanup
async function returnPageToPool(pageInfo) {
  try {
    await cleanupPage(pageInfo.page);
    busyPages.delete(pageInfo);
    pageInfo.lastUsed = Date.now();
    availablePages.push(pageInfo);

    performanceMetrics.browserPoolStats.availablePages = availablePages.length;
    performanceMetrics.browserPoolStats.busyPages = busyPages.size;
  } catch (error) {
    Logger.error("Error returning page to pool:", error.message);
    try {
      await pageInfo.page.close();
    } catch {}
  }
}

// Enhanced random cars fetching with comprehensive error handling and caching
async function getRandomCars(numberOfCars, useCache = true) {
  const cacheKey = `randomCars_${numberOfCars}`;
  const cachedResult = useCache ? cache.get(cacheKey) : null;

  if (cachedResult) {
    performanceMetrics.cacheHits++;
    Logger.info(`Cache hit for random cars (${numberOfCars})`);
    return { result: cachedResult, isCached: true };
  }

  performanceMetrics.cacheMisses++;
  let pageInfo;

  try {
    pageInfo = await getPageFromPool();
    const page = pageInfo.page;
    const randomPage = Math.floor(Math.random() * 1000) + 1;
    const url = `https://turbo.az/autos?pages=${randomPage}`;

    Logger.info(`Fetching random cars from page ${randomPage}`);

    const startTime = Date.now();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Wait for content to load with reduced timeout
    await page.waitForSelector(".products-i", { timeout: 8000 });

    const carUrls = await page.evaluate((numberOfCars) => {
      const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
      const sampleSize = (arr, n = 1) => shuffle(arr).slice(0, n);

      const carDatas = [...document.querySelectorAll(".products-i")]
        .map((elem) => elem.querySelector(".products-i__link")?.href)
        .filter(Boolean); // Remove null/undefined values

      return sampleSize(carDatas, Math.min(carDatas.length, numberOfCars));
    }, numberOfCars);

    Logger.perf(`Found ${carUrls.length} car URLs`, Date.now() - startTime);

    // Cache the result
    cache.set(cacheKey, carUrls, 180); // Cache for 3 minutes

    return { result: carUrls, isCached: false };
  } catch (error) {
    Logger.error("Error fetching random cars:", error.message);
    throw new PageProcessingError(
      "Failed to fetch random cars",
      "turbo.az",
      error,
    );
  } finally {
    if (pageInfo) {
      try {
        const isClosed = pageInfo.page.isClosed(); // Fixed: removed await, it's synchronous
        if (!isClosed) {
          await returnPageToPool(pageInfo);
        } else {
          Logger.warn("Page was closed, creating new one");
          // Create replacement page
          const browser = browserPool.find((b) => b.id === pageInfo.browserId);
          if (browser && browser.browser) {
            const newPage = await createOptimizedPage(browser.browser);
            availablePages.push({
              page: newPage,
              browserId: browser.id,
              createdAt: Date.now(),
              lastUsed: Date.now(),
            });
          }
        }
      } catch (err) {
        Logger.error("Error returning page to pool:", err.message);
        try {
          await pageInfo.page.close();
        } catch {}
      }
    }
  }
}

// Enhanced car info fetching with retry logic and caching
async function getCarInfo(carUrl, retryCount = 0) {
  const MAX_RETRIES = 2;
  const cacheKey = `carInfo_${Buffer.from(carUrl.slice(23, 31))
    .toString("base64")
    .slice(0, 20)}`;
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

    const carInfo = await page.evaluate(() => {
      try {
        return {
          car_id: window.location.href.slice(23, 30),
          title:
            document
              .querySelector(".product-title")
              ?.textContent?.split(", ")[0] || "Unknown",
          year:
            document.querySelector(
              ".product-properties__i-name[for='ad_reg_year']+span a",
            )?.textContent || "Unknown",
          mileage:
            document
              .querySelector(".product-properties__i-name[for='ad_mileage']")
              ?.nextSibling?.textContent?.trim() || "Unknown",
          engine:
            document
              .querySelector(
                ".product-properties__i-name[for='ad_engine_volume']",
              )
              ?.nextSibling?.textContent?.trim() || "Unknown",
          transmission:
            document
              .querySelector(
                ".product-properties__i-name[for='ad_transmission']",
              )
              ?.nextSibling?.textContent?.trim() || "Unknown",
          images: [
            ...document.querySelectorAll(".slick-slide:not(.slick-cloned) img"),
          ]
            .map((elem) => elem.src)
            .filter((src) => src && !src.includes("data:image"))
            .slice(0, 5), // Limit to 5 images for performance
          price:
            Number(
              document
                .querySelector(".product-price__i")
                ?.textContent.replace(/[^\d]/g, ""),
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
    });

    Logger.perf(
      `Successfully fetched car info: ${carInfo.title}`,
      Date.now() - startTime,
    );

    // Cache successful results
    if (!carInfo.error) {
      pageCache.set(cacheKey, carInfo, 300); // Cache for 5 minutes
    }

    return carInfo;
  } catch (error) {
    Logger.error(
      `Error fetching car info (attempt ${retryCount + 1}):`,
      error.message,
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
      try {
        const isClosed = pageInfo.page.isClosed();
        if (!isClosed) {
          await returnPageToPool(pageInfo);
        }
      } catch (err) {
        Logger.warn("Discarding invalid page, creating a fresh one...");
        try {
          await pageInfo.page.close();
        } catch {}
      }
    }
  }
}

// ✅ Core logic (no req/res here, reusable everywhere)
async function fetchCompleteCarDataCore({ number = 20, useCache = true }) {
  try {
    const numberOfCars = Math.min(parseInt(number) || 20, 50); // Limit max cars
    Logger.info(`Processing request for ${numberOfCars} random cars`);

    const callRandomCars = await getRandomCars(numberOfCars, useCache);
    const cars = callRandomCars.result;
    const isCarsCached = callRandomCars.isCached;
    console.log("Is cars cached " + isCarsCached);

    if (cars.length === 0) {
      Logger.warn("No cars found");
      return {
        error: "No cars found",
        message: "Unable to fetch car listings from the source",
      };
    }

    const BATCH_SIZE = Math.min(availablePages.length, 4);
    const carInfos = [];
    const processingStartTime = Date.now();

    Logger.info(`Processing ${cars.length} cars with batch size ${BATCH_SIZE}`);

    for (let i = 0; i < cars.length; i += BATCH_SIZE) {
      const batch = cars.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(cars.length / BATCH_SIZE);

      console.log(`Batch ${batchNum}`);
      console.log(batch);

      Logger.info(
        `Processing batch ${batchNum}/${totalBatches} (${batch.length} cars)`,
      );

      const batchStartTime = Date.now();
      const batchResults = await Promise.allSettled(
        batch.map((car) =>
          Promise.race([
            getCarInfo(car),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 25000),
            ),
          ]),
        ),
      );

      batchResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          carInfos.push(result.value);
        } else {
          Logger.error(
            `Failed to process car ${batch[index]}:`,
            result.reason?.message,
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

      if (i + BATCH_SIZE < cars.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    Logger.perf(`Total processing completed`, Date.now() - processingStartTime);

    const successfulCars = carInfos.filter((car) => !car.error);
    Logger.info(
      `Successfully processed ${successfulCars.length}/${cars.length} cars`,
    );

    if (successfulCars.length > 0) {
      cache.set("randomCars", carInfos);
      if (!isCarsCached) {
        insertCars(successfulCars);
      }
    }

    return {
      cars: carInfos,
      stats: {
        requested: numberOfCars,
        found: cars.length,
        processed: carInfos.length,
        successful: successfulCars.length,
        failed: carInfos.length - successfulCars.length,
      },
    };
  } catch (error) {
    Logger.error("Critical error in fetchCompleteCarDataCore:", error.message);

    if (error instanceof BrowserLaunchError) {
      return {
        error: "Service temporarily unavailable",
        message: "Browser service is not available. Please try again later.",
        code: "BROWSER_UNAVAILABLE",
      };
    } else if (error instanceof PageProcessingError) {
      return {
        error: "External service error",
        message: "Unable to fetch data from car listings website.",
        code: "EXTERNAL_SERVICE_ERROR",
      };
    } else {
      return {
        error: "Internal server error",
        message: "An unexpected error occurred while processing your request.",
        code: "INTERNAL_ERROR",
      };
    }
  }
}

async function fetchCompleteCarData(req, res) {
  const result = await fetchCompleteCarDataCore({ number: req.query.number });
  if (result.error) {
    return res.status(500).json(result);
  }
  res.json(result);
}

// Only enable scraping endpoint if ENABLE_SCRAPING is true
if (ENABLE_SCRAPING) {
  app.get("/scrape-cars", fetchCompleteCarData);
  console.log("Scraping endpoint /scrape-cars is enabled");
} else {
  app.get("/scrape-cars", (req, res) => {
    res.status(403).json({ error: "Scraping is disabled" });
  });
}

async function fetchCarDataFromDB(numberOfCars) {
  try {
    const N = Math.min(parseInt(numberOfCars) || 20, 50); // Limit max cars
    const cars = await carDataCollection
      .aggregate([{ $sample: { size: N } }])
      .toArray();

    if (cars.length === 0) {
      Logger.warn("No cars found in database");
      return [];
    }

    Logger.info(`Fetched ${cars.length} cars from database`);
    return cars;
  } catch (error) {
    Logger.error("Error fetching cars from database:", error.message);
    throw new Error("Database fetch failed");
  }
}

// Enhanced API endpoint with comprehensive error handling
app.get("/get-random-cars", async (req, res) => {
  try {
    const numberOfCars = Math.min(parseInt(req.query.number) || 20, 50); // Limit max cars
    Logger.info(`Processing request for ${numberOfCars} random cars`);

    const cars = await fetchCarDataFromDB(numberOfCars);

    if (cars.length === 0) {
      Logger.warn("No cars found");
      return res.status(404).json({
        error: "No cars found",
        message: "Unable to fetch car listings from the source",
      });
    }

    res.json({
      cars: cars,
      stats: {
        requested: numberOfCars,
        found: cars.length,
      },
    });
  } catch (error) {
    Logger.error("Critical error in /get-random-cars:", error.message);

    if (error instanceof BrowserLaunchError) {
      res.status(503).json({
        error: "Service temporarily unavailable",
        message: "Browser service is not available. Please try again later.",
        code: "BROWSER_UNAVAILABLE",
      });
    } else if (error instanceof PageProcessingError) {
      res.status(502).json({
        error: "External service error",
        message: "Unable to fetch data from car listings website.",
        code: "EXTERNAL_SERVICE_ERROR",
      });
    } else {
      res.status(500).json({
        error: "Internal server error",
        message: "An unexpected error occurred while processing your request.",
        code: "INTERNAL_ERROR",
      });
    }
  }
});

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
        },
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
      browserPool.length > 0 &&
      browserPool[0]?.browser &&
      !browserPool[0]?.browser.disconnected
        ? "running"
        : "stopped";

    const memoryUsage = process.memoryUsage();
    const isHealthy =
      memoryUsage.heapUsed < 512 * 1024 * 1024 && // < 512MB (lowered from 1GB)
      browserPool.length > 0 &&
      availablePages.length > 0 && // Added check for available pages
      performanceMetrics.errorCount < 100;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      browser: browserStatus,
      cache: {
        keys: cache.keys().length,
        stats: cache.getStats(),
      },
      performance: performanceMetrics,
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        isHealthy: memoryUsage.heapUsed < 1024 * 1024 * 1024,
      },
    });
  } catch (error) {
    Logger.error("Health check error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message,
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

process.on("SIGINT", async () => {
  Logger.info("SIGINT received, shutting down gracefully...");
  try {
    await client.close();
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

// Unhandled rejection handler
process.on("unhandledRejection", (reason, promise) => {
  Logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Uncaught exception handler
process.on("uncaughtException", (error) => {
  Logger.error("Uncaught Exception:", error.message);
  process.exit(1);
});

// Cache management endpoint
app.post("/cache/clear", (req, res) => {
  try {
    const type = req.body.type || "all";

    if (type === "all" || type === "main") {
      cache.flushAll();
      Logger.info("Main cache cleared");
    }

    if (type === "all" || type === "page") {
      pageCache.flushAll();
      Logger.info("Page cache cleared");
    }

    res.json({
      status: "success",
      message: `${type} cache cleared`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error("Cache clear error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message,
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
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error("Cache warming error:", error.message);
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// Server startup with enhanced error handling
app.listen(PORT, async () => {
  try {
    Logger.info(`Server starting on port ${PORT}...`);

    // Only initialize browser pool if scraping is enabled
    if (ENABLE_SCRAPING) {
      await initializeBrowserPool();
      Logger.info("Browser pool initialized successfully");

      // Initial cache warming
      setImmediate(() => {
        warmCache().catch((error) =>
          Logger.error("Initial cache warming failed:", error.message),
        );
      });
    } else {
      Logger.info(
        "Browser pool initialization skipped (ENABLE_SCRAPING=false)",
      );
    }

    Logger.info(`[SERVER] ExpressJS is listening on http://localhost:${PORT}`);
    Logger.info("Health check available at: /health");
    Logger.info("Metrics available at: /metrics");
    Logger.info("Cache management available at: /cache/clear and /cache/warm");
  } catch (error) {
    Logger.error("Server startup error:", error.message);
    if (error instanceof BrowserLaunchError) {
      Logger.error(
        "⚠️  Browser launch failed. Server will continue but /get-random-cars endpoint may not work properly.",
      );
      Logger.error(
        "Please check your Docker setup and ensure Chromium is properly installed.",
      );
    }
  }
});

app.set("trust proxy", 1);

async function deleteDuplicateCars() {
  carDataCollection
    .aggregate([
      {
        $group: {
          _id: "$car_id",
          latestId: { $max: "$_id" }, // keep the newest
          dups: { $push: "$_id" },
        },
      },
      {
        $project: {
          _id: 1,
          dups: {
            $filter: {
              input: "$dups",
              as: "id",
              cond: { $ne: ["$$id", "$latestId"] },
            },
          },
        },
      },
    ])
    .forEach((doc) => {
      if (doc.dups.length > 0) {
        carDataCollection.deleteMany({ _id: { $in: doc.dups } });
      }
    });
}

// Only start automatic scraping if ENABLE_SCRAPING is true
let cleanupScrapeInterval;
if (ENABLE_SCRAPING) {
  cleanupScrapeInterval = setInterval(
    async () => {
      try {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;

        // Only scrape if memory is healthy
        if (
          heapUsedMB < 512 &&
          availablePages.length > 0 &&
          browserPool.length > 0
        ) {
          Logger.info(
            `Scraping 35 cars. Current memory: ${heapUsedMB.toFixed(2)}MB`,
          );
          await fetchCompleteCarDataCore({ number: 35, useCache: false });
        } else {
          Logger.warn(
            `Skipping scrape - Memory: ${heapUsedMB.toFixed(2)}MB, Available pages: ${availablePages.length}, Browsers: ${browserPool.length}`,
          );

          // Force garbage collection if available
          if (global.gc) {
            global.gc();
            Logger.info("Forced garbage collection");
          }
        }
      } catch (error) {
        Logger.error("Error in cleanup scrape interval:", error.message);
      }
    },
    10 * 60 * 1000,
  ); // Every 10 minutes
  console.log("Automatic scraping interval started");
} else {
  console.log("Automatic scraping interval disabled");
}

// Browser pool refresh to prevent memory leaks - ONLY if scraping is enabled
let browserRefreshInterval;
if (ENABLE_SCRAPING) {
  browserRefreshInterval = setInterval(
    async () => {
      try {
        Logger.info("Refreshing browser pool to prevent memory leaks...");

        // Clean up all pages first
        const allPages = [...availablePages, ...Array.from(busyPages)];
        for (const pageInfo of allPages) {
          try {
            await cleanupPage(pageInfo.page);
            await pageInfo.page.close();
          } catch (error) {
            Logger.error("Error closing page during refresh:", error.message);
          }
        }

        // Close old browsers
        for (const browserInfo of browserPool) {
          if (browserInfo.browser) {
            try {
              await browserInfo.browser.close();
              Logger.info(`Closed browser ${browserInfo.id}`);
            } catch (error) {
              Logger.error(
                `Error closing browser ${browserInfo.id}:`,
                error.message,
              );
            }
          }
        }

        // Clear pools
        availablePages = [];
        busyPages.clear();
        browserPool = [];

        // Reinitialize
        await initializeBrowserPool();

        Logger.info("Browser pool refreshed successfully");

        // Force garbage collection
        if (global.gc) {
          global.gc();
          Logger.info("Garbage collection after browser refresh");
        }
      } catch (error) {
        Logger.error("Error refreshing browser pool:", error.message);
      }
    },
    60 * 60 * 1000,
  ); // Every hour
  console.log("Browser refresh interval started");
} else {
  console.log("Browser refresh disabled (ENABLE_SCRAPING=false)");
}

// Clear cleanup interval on shutdown
process.on("exit", () => {
  if (cleanupScrapeInterval) {
    clearInterval(cleanupScrapeInterval);
  }
  if (cacheWarmingInterval) {
    clearInterval(cacheWarmingInterval);
  }
  if (browserRefreshInterval) {
    clearInterval(browserRefreshInterval);
  }
  clearInterval(cleanupInterval);
  Logger.info("Cleanup intervals cleared and server shutting down gracefully.");
});
