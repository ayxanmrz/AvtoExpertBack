import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { executablePath as getExecutablePath } from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

puppeteer.use(StealthPlugin());

const PORT = 4000;
const app = express();
const cache = new NodeCache({ stdTTL: 300 });

let EURO_AZN;
let USD_AZN;

app.use(
  cors({
    origin: [process.env.SOCKET_API, process.env.CLIENT_ORIGIN],
  })
);

let browser;

async function launchBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: false, // use true if "new" causes issues
      executablePath:
        process.env.NODE_ENV === "production"
          ? process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome"
          : getExecutablePath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
}

async function getPage() {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.setJavaScriptEnabled(true);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

async function getRandomCars(numberOfCars) {
  const page = await getPage();
  try {
    const pageNumber = Math.floor(Math.random() * 20) + 1;
    const url = `https://turbo.az/autos?page=${pageNumber}`;

    console.log("[INFO] Navigating to:", url);
    await page.goto(url, {
      waitUntil: "networkidle2", // More reliable than domcontentloaded
      timeout: 60000, // optional
    });

    const html = await page.content();
    console.log(html);

    await page.waitForSelector(".products-i", { timeout: 10000 });

    return await page.evaluate((numberOfCars) => {
      const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
      const sampleSize = (arr, n = 1) => shuffle(arr).slice(0, n);

      const carDatas = [...document.querySelectorAll(".products-i")].map(
        (elem) => elem.querySelector(".products-i__link")?.href
      );

      return sampleSize(carDatas, Math.min(carDatas.length, numberOfCars));
    }, numberOfCars);
  } catch (error) {
    console.error("[ERROR] Failed on getRandomCars:", error);
    return [];
  } finally {
    await page.close();
  }
}

async function getCarInfo(carUrl) {
  const page = await getPage();
  try {
    await page.goto(carUrl, { waitUntil: "domcontentloaded" });

    return await page.evaluate(
      (USD_AZN, EURO_AZN) => {
        const getManatPrice = (string) => {
          const stringList = string.split(" ");
          const currency = stringList[stringList.length - 1];
          const value = stringList
            .slice(0, stringList.length - 1)
            .reduce((res, elem) => res + elem);
          if (currency === "AZN") {
            return +value;
          } else if (currency === "USD") {
            return Math.round(value * (USD_AZN || 1.7));
          } else if (currency === "EUR") {
            return Math.round(value * (EURO_AZN || 1.8));
          } else {
            return null;
          }
        };

        return {
          title:
            document
              .querySelector(".product-title")
              ?.textContent.split(", ")[0] || "Unknown",
          year:
            document.querySelector(
              ".product-properties__i-name[for='ad_reg_year']+span a"
            )?.textContent || "Unknown",
          mileage:
            document
              .querySelector(".product-properties__i-name[for='ad_mileage']")
              ?.nextSibling?.textContent.trim() || "Unknown",
          engine:
            document
              .querySelector(
                ".product-properties__i-name[for='ad_engine_volume']"
              )
              ?.nextSibling?.textContent.trim() || "Unknown",
          transmission:
            document
              .querySelector(
                ".product-properties__i-name[for='ad_transmission']"
              )
              ?.nextSibling?.textContent.trim() || "Unknown",
          images: [
            ...document.querySelectorAll(".slick-slide:not(.slick-cloned) img"),
          ].map((elem) => elem.src),
          price:
            getManatPrice(
              document.querySelector(".product-price__i")?.textContent
            ) || "Unknown",
        };
      },
      USD_AZN,
      EURO_AZN
    );
  } catch (error) {
    console.error("Error fetching car info:", error);
    return { error: "Failed to fetch car details" };
  } finally {
    await page.close();
  }
}

async function getEuroConverts() {
  try {
    const response = await axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json"
    );
    EURO_AZN = response.data.eur.azn;
    console.log("EURO_AZN:", EURO_AZN);
  } catch (error) {
    console.error("Error fetching the data:", error);
  }
}

async function getUsdConverts() {
  try {
    const response = await axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
    );
    USD_AZN = response.data.usd.azn;
    console.log("USD_AZN:", USD_AZN);
  } catch (error) {
    console.error("Error fetching the data:", error);
  }
}

app.get("/get-random-cars", async (req, res) => {
  // const cachedData = cache.get("randomCars");
  // if (cachedData) {
  //   return res.json(cachedData);
  // }

  try {
    let numberOfCars = req.query.number || 20;
    let cars = await getRandomCars(numberOfCars);
    let carInfos = await Promise.all(cars.map(getCarInfo));

    cache.set("randomCars", carInfos);
    res.json(carInfos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error fetching suggestions" });
  }
});

app.listen(PORT, async () => {
  await launchBrowser();
  await getEuroConverts();
  await getUsdConverts();
  console.log(
    `[SERVER] ExpressJS is listening to port http://localhost:${PORT}`
  );
});

process.on("exit", async () => {
  if (browser) await browser.close();
});

// const getManatPrice = (string) => {
//   const stringList = string.spl it(" ");
//   const currency = stringList[stringList - 1];
//   const value = stringList
//     .slice(0, stringList.length - 1)
//     .reduce((res, elem) => res + elem);
//   console.log(currency);
//   console.log(value);
//   if (currency === "AZN") {
//     return +value;
//   } else if (currency === "USD") {
//     return value * 1.7;
//   } else {
//     return null;
//   }
// };

// console.log(getManatPrice("18 000 USD"));
