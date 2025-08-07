import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import axios from "axios";
import dotenv from "dotenv";
import cluster from "cluster";
import os from "os";

dotenv.config();

const PORT = 4000;
const app = express();

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
let browserPool = [];
const MAX_BROWSER_INSTANCES = Math.min(os.cpus().length, 3); // Limit based on CPU cores
const MAX_PAGES_PER_BROWSER = 10;
let currentBrowserIndex = 0;

// Connection pool for HTTP requests
const axiosInstance = axios.create({
  timeout: 5000,
  maxRedirects: 3,
  headers: {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  },
});

// Enhanced logging with performance tracking
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
  }

  static warn(message, data = null) {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data || "");
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

app.use(
  cors({
    origin: [process.env.SOCKET_API, process.env.CLIENT_ORIGIN],
    credentials: true,
  })
);

// Optimized browser launch with better resource management
async function launchOptimizedBrowser() {
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
      "--disable-ipc-flooding-protection",
      "--disable-hang-monitor",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--no-zygote",
      "--single-process", // Use single process for better resource control
      "--memory-pressure-off",
      "--max_old_space_size=4096",
    ],
    timeout: 15000,
    protocolTimeout: 15000,
    ignoreHTTPSErrors: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  };

  const browser = await puppeteer.launch(launchOptions);

  // Pre-warm browser with a page
  const warmupPage = await browser.newPage();
  await warmupPage.goto("data:text/html,<html></html>", {
    waitUntil: "domcontentloaded",
  });
  await warmupPage.close();

  return browser;
}

// Browser pool management
async function initializeBrowserPool() {
  const startTime = Date.now();
  Logger.info(
    `Initializing browser pool with ${MAX_BROWSER_INSTANCES} instances`
  );

  try {
    const browsers = await Promise.all(
      Array(MAX_BROWSER_INSTANCES)
        .fill()
        .map(() => launchOptimizedBrowser())
    );

    browserPool = browsers.map((browser) => ({
      browser,
      activePagesCount: 0,
      lastUsed: Date.now(),
    }));

    Logger.perf("Browser pool initialization", Date.now() - startTime);
    return browserPool;
  } catch (error) {
    Logger.error("Failed to initialize browser pool:", error.message);
    throw error;
  }
}

// Round-robin browser selection with load balancing
function getAvailableBrowser() {
  // Find browser with least active pages
  let selectedBrowser = browserPool[0];
  let minPages = selectedBrowser.activePagesCount;

  for (const browserInstance of browserPool) {
    if (
      browserInstance.activePagesCount < minPages &&
      browserInstance.activePagesCount < MAX_PAGES_PER_BROWSER
    ) {
      selectedBrowser = browserInstance;
      minPages = browserInstance.activePagesCount;
    }
  }

  if (selectedBrowser.activePagesCount >= MAX_PAGES_PER_BROWSER) {
    // All browsers are at capacity, use round-robin
    selectedBrowser = browserPool[currentBrowserIndex];
    currentBrowserIndex = (currentBrowserIndex + 1) % browserPool.length;
  }

  selectedBrowser.lastUsed = Date.now();
  return selectedBrowser;
}

// Optimized page creation with reuse
const pagePool = [];
const MAX_PAGE_POOL_SIZE = 20;

async function getOptimizedPage() {
  const startTime = Date.now();

  // Try to reuse page from pool
  if (pagePool.length > 0) {
    const page = pagePool.pop();
    try {
      // Reset page state
      await page.goto("about:blank");
      await page.setViewport({ width: 1366, height: 768 });
      Logger.perf("Page reuse", Date.now() - startTime);
      return { page, fromPool: true };
    } catch (error) {
      Logger.warn("Failed to reuse page, creating new one");
      try {
        await page.close();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Create new page
  const browserInstance = getAvailableBrowser();
  browserInstance.activePagesCount++;

  try {
    const page = await browserInstance.browser.newPage();

    // Optimize page settings
    await page.setViewport({ width: 1366, height: 768 });
    await page.setDefaultTimeout(10000);
    await page.setDefaultNavigationTimeout(15000);

    // Aggressive request filtering for better performance
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      const url = req.url();

      // Block unnecessary resources more aggressively
      if (
        [
          "image",
          "stylesheet",
          "font",
          "media",
          "websocket",
          "texttrack",
          "eventsource",
          "manifest",
        ].includes(resourceType) ||
        url.includes("analytics") ||
        url.includes("tracking") ||
        url.includes("ads") ||
        url.includes("facebook") ||
        url.includes("google-analytics")
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Disable unnecessary features
    await page.evaluateOnNewDocument(() => {
      // Disable images
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // Mock console to reduce overhead
      if (window.location.hostname !== "localhost") {
        console.log = console.warn = console.info = console.debug = () => {};
      }
    });

    Logger.perf("New page creation", Date.now() - startTime);
    return { page, browserInstance, fromPool: false };
  } catch (error) {
    browserInstance.activePagesCount--;
    throw error;
  }
}

// Optimized page cleanup
async function releasePage(page, browserInstance, reuse = true) {
  try {
    if (browserInstance) {
      browserInstance.activePagesCount--;
    }

    if (reuse && pagePool.length < MAX_PAGE_POOL_SIZE) {
      // Clear page state but keep it for reuse
      await page.evaluate(() => {
        // Clear all timers and intervals
        const maxId = setTimeout(() => {}, 0);
        for (let i = 0; i < maxId; i++) {
          clearTimeout(i);
          clearInterval(i);
        }

        // Clear DOM
        if (document.body) {
          document.body.innerHTML = "";
        }
      });

      pagePool.push(page);
    } else {
      await page.close();
    }
  } catch (error) {
    Logger.warn("Error releasing page:", error.message);
    try {
      await page.close();
    } catch (e) {
      /* ignore */
    }
  }
}

// Ultra-fast car URL extraction with minimal DOM interaction
async function getRandomCarsOptimized(numberOfCars) {
  const startTime = Date.now();
  const cacheKey = `carUrls_${numberOfCars}`;

  // Check cache first
  const cachedUrls = cache.get(cacheKey);
  if (cachedUrls) {
    Logger.perf("Car URLs cache hit", Date.now() - startTime);
    return cachedUrls;
  }

  const pageResult = await getOptimizedPage();
  const { page, browserInstance } = pageResult;

  try {
    const randomPage = Math.floor(Math.random() * 10) + 1; // Reduce range for faster response
    const url = `https://turbo.az/autos?pages=${randomPage}`;

    Logger.info(`Fetching car URLs from page ${randomPage}`);

    // Navigate with minimal waiting
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Extract URLs with minimal DOM queries
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

    // Cache for 5 minutes
    cache.set(cacheKey, carUrls, 300);

    Logger.perf("Car URLs extraction", Date.now() - startTime);
    return carUrls;
  } finally {
    await releasePage(page, browserInstance);
  }
}

// Highly optimized car info extraction
async function getCarInfoOptimized(carUrl) {
  const startTime = Date.now();
  const cacheKey = `car_${carUrl}`;

  // Check cache first
  const cachedInfo = cache.get(cacheKey);
  if (cachedInfo) {
    Logger.perf("Car info cache hit", Date.now() - startTime);
    return cachedInfo;
  }

  const pageResult = await getOptimizedPage();
  const { page, browserInstance } = pageResult;

  try {
    await page.goto(carUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Extract all data in a single evaluate call to minimize context switches
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

        const getText = (selector) => {
          const element = document.querySelector(selector);
          return element ? element.textContent.trim() : "Unknown";
        };

        const getPropertyValue = (propertyName) => {
          const element = document.querySelector(`[for='${propertyName}']`);
          return element && element.nextSibling
            ? element.nextSibling.textContent.trim()
            : "Unknown";
        };

        // Extract images more efficiently
        const imageElements = document.querySelectorAll(
          ".slick-slide:not(.slick-cloned) img"
        );
        const images = Array.from(imageElements)
          .map((img) => img.src)
          .filter((src) => src && !src.startsWith("data:"))
          .slice(0, 5); // Limit to 5 images for performance

        return {
          title: getText(".product-title").split(", ")[0] || "Unknown",
          year: getText("[for='ad_reg_year']+span a"),
          mileage: getPropertyValue("ad_mileage"),
          engine: getPropertyValue("ad_engine_volume"),
          transmission: getPropertyValue("ad_transmission"),
          images,
          price: getManatPrice(getText(".product-price__i")),
          url: location.href,
        };
      },
      USD_AZN,
      EURO_AZN
    );

    // Cache for 10 minutes
    cache.set(cacheKey, carInfo, 600);

    Logger.perf("Car info extraction", Date.now() - startTime);
    return carInfo;
  } catch (error) {
    Logger.error(`Car info extraction failed for ${carUrl}:`, error.message);
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
    await releasePage(page, browserInstance);
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
    const infoFetchStart = Date.now();
    const OPTIMAL_CONCURRENCY = Math.min(8, carUrls.length); // Increased concurrency
    const carInfoPromises = [];

    // Process in batches with higher concurrency
    for (let i = 0; i < carUrls.length; i += OPTIMAL_CONCURRENCY) {
      const batch = carUrls.slice(i, i + OPTIMAL_CONCURRENCY);
      const batchPromises = batch.map((url) => getCarInfoOptimized(url));
      carInfoPromises.push(...batchPromises);

      // Small delay between batches to prevent overwhelming
      if (i + OPTIMAL_CONCURRENCY < carUrls.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

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

    Logger.perf("Total request", Date.now() - requestStart);
    Logger.info(
      `Successfully processed ${successfulCars.length}/${
        carUrls.length
      } cars in ${Date.now() - requestStart}ms`
    );

    res.json(response);
  } catch (error) {
    Logger.error("Critical error in /get-random-cars:", error.message);

    res.status(500).json({
      error: "Internal server error",
      message: "Service temporarily unavailable",
      code: "INTERNAL_ERROR",
    });
  }
});

// Lightweight health check
app.get("/health", (req, res) => {
  const healthData = {
    status: "ok",
    timestamp: new Date().toISOString(),
    browserPool: browserPool.length,
    activeBrowsers: browserPool.filter((b) => !b.browser.disconnected).length,
    cache: {
      keys: cache.keys().length,
      hits: cache.getStats().hits,
      misses: cache.getStats().misses,
    },
    exchangeRates: { USD_AZN, EURO_AZN },
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  };

  res.json(healthData);
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
    // Close all pages in pool
    await Promise.all(
      pagePool.map((page) =>
        page
          .close()
          .catch((e) => Logger.warn("Error closing pooled page:", e.message))
      )
    );

    // Close all browsers
    await Promise.all(
      browserPool.map(({ browser }) =>
        browser
          .close()
          .catch((e) => Logger.warn("Error closing browser:", e.message))
      )
    );

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

// Background tasks
setInterval(() => {
  updateExchangeRates().catch((err) =>
    Logger.warn("Background exchange rate update failed:", err.message)
  );
}, 3600000); // Update every hour

// Browser health check and restart if needed
setInterval(() => {
  browserPool.forEach(async ({ browser }, index) => {
    try {
      if (browser.disconnected) {
        Logger.warn(`Browser ${index} disconnected, restarting...`);
        const newBrowser = await launchOptimizedBrowser();
        browserPool[index] = {
          browser: newBrowser,
          activePagesCount: 0,
          lastUsed: Date.now(),
        };
      }
    } catch (error) {
      Logger.error(`Failed to restart browser ${index}:`, error.message);
    }
  });
}, 300000); // Check every 5 minutes

// Server startup
app.listen(PORT, async () => {
  try {
    Logger.info(`🚀 Starting optimized server on port ${PORT}...`);

    // Initialize browser pool
    await initializeBrowserPool();
    Logger.info(
      `✅ Browser pool initialized with ${browserPool.length} instances`
    );

    // Initialize exchange rates
    await updateExchangeRates();
    Logger.info("✅ Exchange rates initialized");

    Logger.info(`🎯 Server ready at http://localhost:${PORT}`);
    Logger.info(`📊 Health check: http://localhost:${PORT}/health`);
    Logger.info(`🏎️  Ready to serve optimized car data!`);
  } catch (error) {
    Logger.error("❌ Server startup failed:", error.message);
    process.exit(1);
  }
});
