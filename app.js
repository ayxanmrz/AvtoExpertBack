import puppeteer from "puppeteer";

async function getCars() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.goto("https://turbo.az/autos?pages=" + [1, 2, 3, 4, 5].random(), {
    waitUntil: "networkidle2",
  });

  const searchResultSelector = ".products-i";
  await page.waitForSelector(searchResultSelector);

  const titles = await page.evaluate(() => {
    return [...document.querySelectorAll(".products-i")].map(
      (elem) => elem.querySelector(".products-i__name").textContent
    );
  });

  console.log(titles);

  await browser.close();
}

async function getCarInfo(carUrl) {
  console.log("Started");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.setRequestInterception(true);

  page.on("request", (request) => {
    if (
      ["image", "stylesheet", "font"].indexOf(request.resourceType()) !== -1
    ) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.goto(carUrl, { waitUntil: "domcontentloaded" });

  console.log("Go to Page");
  const searchResultSelector = ".product-title";
  await page.waitForSelector(searchResultSelector);
  console.log("Waited");

  // title, year, mileage, engine, transmission

  const carObject = await page.evaluate(() => {
    return {
      title: document
        .querySelector(".product-title")
        .textContent.split(", ")[0],
      year: document.querySelector(
        ".product-properties__i-name[for='ad_reg_year']+span a"
      ).textContent,
      mileage: document.querySelector(
        ".product-properties__i-name[for='ad_mileage']"
      ).nextSibling.textContent,
      engine: document.querySelector(
        ".product-properties__i-name[for='ad_engine_volume']"
      ).nextSibling.textContent,
      transmission: document.querySelector(
        ".product-properties__i-name[for='ad_transmission']"
      ).nextSibling.textContent,
      images: [
        ...document.querySelectorAll(".slick-slide:not(.slick-cloned) img"),
      ].map((elem) => elem.src),
    };
  });
  console.log("Querry Selected");

  console.log(carObject);

  await browser.close();
}

async function getRandomCar() {
  console.log("Started");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.setRequestInterception(true);

  page.on("request", (request) => {
    if (
      ["image", "stylesheet", "font"].indexOf(request.resourceType()) !== -1
    ) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.goto(
    "https://turbo.az/autos?pages=" +
      [1, 2, 3, 4, 5][Math.floor(Math.random() * 5)],
    { waitUntil: "domcontentloaded" }
  );
  console.log("Go to Page");
  const searchResultSelector = ".products-i";
  await page.waitForSelector(searchResultSelector);
  console.log("Waited");
  const titles = await page.evaluate(() => {
    const shuffle = ([...arr]) => {
      let m = arr.length;
      while (m) {
        const i = Math.floor(Math.random() * m--);
        [arr[m], arr[i]] = [arr[i], arr[m]];
      }
      return arr;
    };

    const sampleSize = ([...arr], n = 1) => shuffle(arr).slice(0, n);

    return sampleSize(
      [...document.querySelectorAll(".products-i")].map(
        (elem) => elem.querySelector(".products-i__link").href
      ),

      10
    );
  });
  console.log("Querry Selected");

  //   titles.forEach((elem) => getCarInfo(elem));

  await browser.close();
}

// getRandomCar();
getCarInfo("https://turbo.az/autos/9142097-zeekr-001");
