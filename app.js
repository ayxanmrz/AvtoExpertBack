import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const PORT = 4000;
const app = express();
const cache = new NodeCache({ stdTTL: 300 });

let EURO_AZN = 1.8; // Default fallback values
let USD_AZN = 1.7;
let browser;
let browserLaunchAttempts = 0;
const MAX_BROWSER_LAUNCH_ATTEMPTS = 3;
const BROWSER_RETRY_DELAY = 5000; // 5 seconds

// Enhanced logging utility
class Logger {
  static info(message, data = null) {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data || "");
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

app.use(cors());
app.use(
  cors({
    origin: [process.env.SOCKET_API, process.env.CLIENT_ORIGIN],
  })
);

// Enhanced browser launch with retry logic and multiple fallback paths
async function launchBrowser() {
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    null, // Let Puppeteer find its own browser
  ].filter((path) => path !== undefined);

  if (browser && !browser.disconnected) {
    Logger.info("Browser already running");
    return browser;
  }

  for (let attempt = 1; attempt <= MAX_BROWSER_LAUNCH_ATTEMPTS; attempt++) {
    Logger.info(
      `Browser launch attempt ${attempt}/${MAX_BROWSER_LAUNCH_ATTEMPTS}`
    );

    for (const executablePath of chromiumPaths) {
      try {
        Logger.info(`Trying to launch browser with path: ${executablePath}`);

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
          ],
          timeout: 30000, // 30 second timeout
        };

        // Only set executablePath if it's not null (let Puppeteer auto-detect if null)
        if (executablePath) {
          launchOptions.executablePath = executablePath;
        }

        browser = await puppeteer.launch(launchOptions);

        Logger.info(
          `Browser launched successfully with path: ${executablePath}`
        );
        browserLaunchAttempts = 0; // Reset counter on success

        // Test browser functionality
        const testPage = await browser.newPage();
        await testPage.goto("data:text/html,<h1>Test</h1>", {
          waitUntil: "domcontentloaded",
        });
        await testPage.close();
        Logger.info("Browser functionality test passed");

        return browser;
      } catch (error) {
        Logger.error(
          `Failed to launch browser with path ${executablePath}:`,
          error.message
        );
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            Logger.error(
              "Error closing browser after failed launch:",
              closeError.message
            );
          }
          browser = null;
        }
      }
    }

    if (attempt < MAX_BROWSER_LAUNCH_ATTEMPTS) {
      Logger.info(`Waiting ${BROWSER_RETRY_DELAY}ms before next attempt...`);
      await new Promise((resolve) => setTimeout(resolve, BROWSER_RETRY_DELAY));
    }
  }

  browserLaunchAttempts++;
  const errorMsg = `Failed to launch browser after ${MAX_BROWSER_LAUNCH_ATTEMPTS} attempts with all available paths`;
  Logger.error(errorMsg);
  throw new BrowserLaunchError(errorMsg, null);
}

// Enhanced page creation with error handling
async function getPage() {
  try {
    if (!browser || browser.disconnected) {
      Logger.warn("Browser not available, attempting to launch...");
      await launchBrowser();
    }

    const page = await browser.newPage();

    // Set timeouts
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // Request interception with error handling
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      try {
        if (["image", "stylesheet", "font"].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      } catch (error) {
        Logger.error("Request interception error:", error.message);
      }
    });

    // Error event handlers
    page.on("error", (error) => {
      Logger.error("Page error:", error.message);
    });

    page.on("pageerror", (error) => {
      Logger.error("Page script error:", error.message);
    });

    return page;
  } catch (error) {
    Logger.error("Failed to create page:", error.message);
    throw error;
  }
}

// Enhanced random cars fetching with comprehensive error handling
async function getRandomCars(numberOfCars) {
  let page;
  try {
    page = await getPage();
    const randomPage = Math.floor(Math.random() * 20) + 1;
    const url = `https://turbo.az/autos?pages=${randomPage}`;

    Logger.info(`Fetching random cars from page ${randomPage}`);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for content to load
    await page.waitForSelector(".products-i", { timeout: 10000 });

    const carUrls = await page.evaluate((numberOfCars) => {
      const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
      const sampleSize = (arr, n = 1) => shuffle(arr).slice(0, n);

      const carDatas = [...document.querySelectorAll(".products-i")]
        .map((elem) => elem.querySelector(".products-i__link")?.href)
        .filter(Boolean); // Remove null/undefined values

      return sampleSize(carDatas, Math.min(carDatas.length, numberOfCars));
    }, numberOfCars);

    Logger.info(`Found ${carUrls.length} car URLs`);
    return carUrls;
  } catch (error) {
    Logger.error("Error fetching random cars:", error.message);
    throw new PageProcessingError(
      "Failed to fetch random cars",
      "turbo.az",
      error
    );
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        Logger.error("Error closing page:", closeError.message);
      }
    }
  }
}

// Enhanced car info fetching with retry logic
async function getCarInfo(carUrl, retryCount = 0) {
  const MAX_RETRIES = 2;
  let page;

  try {
    page = await getPage();
    Logger.info(`Fetching car info from: ${carUrl}`);

    await page.goto(carUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for essential content
    await page.waitForSelector(".product-title", { timeout: 10000 });

    const carInfo = await page.evaluate(
      (USD_AZN, EURO_AZN) => {
        const getManatPrice = (string) => {
          try {
            if (!string) return null;
            const stringList = string.split(" ");
            const currency = stringList[stringList.length - 1];
            const value = stringList
              .slice(0, stringList.length - 1)
              .reduce((res, elem) => res + elem.replace(",", ""), "");

            const numValue = parseFloat(value);
            if (isNaN(numValue)) return null;

            if (currency === "AZN") {
              return numValue;
            } else if (currency === "USD") {
              return Math.round(numValue * (USD_AZN || 1.7));
            } else if (currency === "EUR") {
              return Math.round(numValue * (EURO_AZN || 1.8));
            }
            return null;
          } catch (error) {
            console.error("Price parsing error:", error);
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
              .filter((src) => src && !src.includes("data:image")),
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

    Logger.info(`Successfully fetched car info: ${carInfo.title}`);
    return carInfo;
  } catch (error) {
    Logger.error(
      `Error fetching car info (attempt ${retryCount + 1}):`,
      error.message
    );

    if (retryCount < MAX_RETRIES) {
      Logger.info(`Retrying car info fetch for ${carUrl}...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
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
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        Logger.error("Error closing page:", closeError.message);
      }
    }
  }
}

// Enhanced currency fetching with fallbacks
async function getEuroConverts() {
  const apis = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json",
    "https://api.exchangerate-api.com/v4/latest/EUR",
  ];

  for (const apiUrl of apis) {
    try {
      Logger.info(`Fetching EUR/AZN rate from: ${apiUrl}`);
      const response = await axios.get(apiUrl, { timeout: 10000 });

      if (apiUrl.includes("fawazahmed0")) {
        EURO_AZN = response.data.eur.azn;
      } else {
        EURO_AZN = response.data.rates.AZN;
      }

      Logger.info(`EURO_AZN rate updated: ${EURO_AZN}`);
      return;
    } catch (error) {
      Logger.error(`Error fetching EUR rate from ${apiUrl}:`, error.message);
    }
  }

  Logger.warn(`Using fallback EUR/AZN rate: ${EURO_AZN}`);
}

async function getUsdConverts() {
  const apis = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://api.exchangerate-api.com/v4/latest/USD",
  ];

  for (const apiUrl of apis) {
    try {
      Logger.info(`Fetching USD/AZN rate from: ${apiUrl}`);
      const response = await axios.get(apiUrl, { timeout: 10000 });

      if (apiUrl.includes("fawazahmed0")) {
        USD_AZN = response.data.usd.azn;
      } else {
        USD_AZN = response.data.rates.AZN;
      }

      Logger.info(`USD_AZN rate updated: ${USD_AZN}`);
      return;
    } catch (error) {
      Logger.error(`Error fetching USD rate from ${apiUrl}:`, error.message);
    }
  }

  Logger.warn(`Using fallback USD/AZN rate: ${USD_AZN}`);
}

// Enhanced API endpoint with comprehensive error handling
app.get("/get-random-cars", async (req, res) => {
  try {
    const numberOfCars = Math.min(parseInt(req.query.number) || 20, 50); // Limit max cars
    Logger.info(`Processing request for ${numberOfCars} random cars`);

    const cars = await getRandomCars(numberOfCars);

    if (cars.length === 0) {
      Logger.warn("No cars found");
      return res.status(404).json({
        error: "No cars found",
        message: "Unable to fetch car listings from the source",
      });
    }

    // Process cars with controlled concurrency
    const BATCH_SIZE = 5;
    const carInfos = [];

    for (let i = 0; i < cars.length; i += BATCH_SIZE) {
      const batch = cars.slice(i, i + BATCH_SIZE);
      Logger.info(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
          cars.length / BATCH_SIZE
        )}`
      );

      const batchResults = await Promise.allSettled(
        batch.map((car) => getCarInfo(car))
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
          });
        }
      });

      // Small delay between batches to avoid overwhelming the server
      if (i + BATCH_SIZE < cars.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const successfulCars = carInfos.filter((car) => !car.error);
    Logger.info(
      `Successfully processed ${successfulCars.length}/${cars.length} cars`
    );

    // Cache successful results
    if (successfulCars.length > 0) {
      cache.set("randomCars", carInfos);
    }

    res.json({
      cars: carInfos,
      stats: {
        requested: numberOfCars,
        found: cars.length,
        processed: carInfos.length,
        successful: successfulCars.length,
        failed: carInfos.length - successfulCars.length,
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

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const browserStatus =
      browser && !browser.disconnected ? "running" : "stopped";

    res.json({
      status: "ok",
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
    if (browser) {
      await browser.close();
      Logger.info("Browser closed successfully");
    }
  } catch (error) {
    Logger.error("Error during shutdown:", error.message);
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  Logger.info("SIGINT received, shutting down gracefully...");
  try {
    if (browser) {
      await browser.close();
      Logger.info("Browser closed successfully");
    }
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

// Server startup with enhanced error handling
app.listen(PORT, async () => {
  try {
    Logger.info(`Server starting on port ${PORT}...`);

    // Initialize browser
    await launchBrowser();
    Logger.info("Browser initialized successfully");

    // Initialize exchange rates
    await Promise.allSettled([getEuroConverts(), getUsdConverts()]);
    Logger.info("Exchange rates initialized");

    Logger.info(`[SERVER] ExpressJS is listening on http://localhost:${PORT}`);
    Logger.info("Health check available at: /health");
  } catch (error) {
    Logger.error("Server startup error:", error.message);
    if (error instanceof BrowserLaunchError) {
      Logger.error(
        "⚠️  Browser launch failed. Server will continue but /get-random-cars endpoint may not work properly."
      );
      Logger.error(
        "Please check your Docker setup and ensure Chromium is properly installed."
      );
    }
  }
});
