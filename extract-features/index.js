const chromium = require('chrome-aws-lambda')


const SUPPORTED_URLS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.fxhash.xyz/ipfs/",
  "https://gateway.fxhash2.xyz/ipfs/",
  "https://gateway.fxhash-dev.xyz/ipfs/",
  "https://gateway.fxhash-dev2.xyz/ipfs/",
]

function isUrlValid(url) {
  for (const supported of SUPPORTED_URLS) {
    if (url.startsWith(supported)) {
      return true
    }
  }
  return false
}

function processRawTokenFeatures(rawFeatures) {
  const features = []

  // first check if features are an object
  if (typeof rawFeatures !== "object" || Array.isArray(rawFeatures) || !rawFeatures) {
    throw null
  }

  // go through each property and process it
  for (const name in rawFeatures) {
    // chack if propery is accepted type
    if (!(typeof rawFeatures[name] === "boolean" || typeof rawFeatures[name] === "string" || typeof rawFeatures[name] === "number")) {
      continue
    }
    // all good, the feature can be added safely
    features.push({
      name,
      value: rawFeatures[name]
    })
  }

  return features
}

function sleep(time, ret) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(ret)
    }, time)
  })
}


/**
 * expects:
 *  - url to token
 * process:
 *  - spawn chromium instance + navigate to the page
 *  - find window.$fxhashFeatures (can fail)
 *  - turn raw features into "TokenFeatures" (can fail)
 * outputs:
 *  - array of TokenFeature
 *  - if fail: []
 */
exports.features = async (req, res) => {
  let browser = null
  let result = null

  try {
    // if we have an OPTIONS request, only return the headers
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', 'Content-Type')

    //respond to CORS preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(204).send('')
    }

    // get the url to capture
    let { url } = req.body

    // check if general parameters are correct
    if (!isUrlValid(url)) {
      throw "UNSUPPORTED_URL"
    }

    // start chromium instance
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
      ignoreHTTPSErrors: true,
    })

    let page = await browser.newPage()
    await page.setViewport({
      width: 32,
      height: 32
    })
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    })

    try {
      await page.waitForSelector("body", {
        timeout: 10000
      })
    }
    catch {
      // // if the waitFor selector doesn't work (known issue), try that
      // try {
      //   // const isLoaded = await page.evaluate(() =>
      //   //   Boolean(document.querySelector("body"))
      //   // )
      //   // if the page content is unreachable, then features will never be accessible
      //   // if (!isLoaded) {
      //   //   throw null
      //   // }
      // }
      // catch {
      //   // if the page content is unreachable, then features will never be accessible
      //   res.set("Content-Type", "application/json")
      //   return res.status(200).send([]) 
      // }
    }


    // find $fxhashFeatures in the window object
    let rawFeatures = null
    try {
      const extractedFeatures = await Promise.race([
        page.evaluate(
          () => JSON.stringify(window.$fxhashFeatures)
        ),
        sleep(10000, null)
      ])
      rawFeatures = (extractedFeatures && JSON.parse(extractedFeatures)) || null
      // res.set("Content-Type", "application/json")
      // return res.status(400).send({ features: rawFeatures })
    }
    catch {
      throw "PAGE_EVALUATE_FAILED"
    }

    // turn raw features into features
    try {
      const processed = processRawTokenFeatures(rawFeatures)
      result = processed
    }
    catch { }
  }
  catch (error) {
    // todo: remove for prod
    throw error
    res.set("Content-Type", "application/json")
    return res.status(400).send({ error: error })
  }
  finally {
    if (browser !== null) {
      browser.close()
    }
  }

  // let message = req.query.message || req.body.message || 'Hello World 2!'
  res.set("Content-Type", "application/json")
  return res.status(200).send(result || [])
}