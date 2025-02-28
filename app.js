import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";

const PORT = 4000;
const app = express();
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());

let browser;

async function launchBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({ headless: "new" });
  }
}

async function getPage() {
  const page = await browser.newPage();
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

async function getRandomCars() {
  const page = await getPage();
  try {
    await page.goto(
      "https://turbo.az/autos?pages=" + (Math.floor(Math.random() * 5) + 1),
      {
        waitUntil: "domcontentloaded",
      }
    );

    return await page.evaluate(() => {
      const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
      const sampleSize = (arr, n = 1) => shuffle(arr).slice(0, n);

      return sampleSize(
        [...document.querySelectorAll(".products-i")].map(
          (elem) => elem.querySelector(".products-i__link")?.href
        ),
        10
      );
    });
  } catch (error) {
    console.error("Error fetching random cars:", error);
    return [];
  } finally {
    await page.close();
  }
}

async function getCarInfo(carUrl) {
  const page = await getPage();
  try {
    await page.goto(carUrl, { waitUntil: "domcontentloaded" });

    return await page.evaluate(() => {
      const getManatPrice = (string) => {
        const stringList = string.split(" ");
        const currency = stringList[stringList.length - 1];
        const value = stringList
          .slice(0, stringList.length - 1)
          .reduce((res, elem) => res + elem);
        if (currency === "AZN") {
          return +value;
        } else if (currency === "USD") {
          return value * 1.7;
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
            .querySelector(".product-properties__i-name[for='ad_transmission']")
            ?.nextSibling?.textContent.trim() || "Unknown",
        images: [
          ...document.querySelectorAll(".slick-slide:not(.slick-cloned) img"),
        ].map((elem) => elem.src),
        price:
          getManatPrice(
            document.querySelector(".product-price__i")?.textContent
          ) || "Unknown",
      };
    });
  } catch (error) {
    console.error("Error fetching car info:", error);
    return { error: "Failed to fetch car details" };
  } finally {
    await page.close();
  }
}

app.get("/get-random-cars", async (req, res) => {
  // const cachedData = cache.get("randomCars");
  // if (cachedData) {
  //   return res.json(cachedData);
  // }

  try {
    let cars = await getRandomCars();
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
  console.log(
    `[SERVER] ExpressJS is listening to port http://localhost:${PORT}`
  );
});

process.on("exit", async () => {
  if (browser) await browser.close();
});

// const getManatPrice = (string) => {
//   const stringList = string.split(" ");
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
