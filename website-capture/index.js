const chromium = require('chrome-aws-lambda')
const sharp = require('sharp')
const path = require('path')

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

// CONSTANTS
const DELAY_MIN = 0
const DELAY_MAX = 300000

const sleep = (time) => new Promise(resolve => {
  setTimeout(resolve, time)
})

const waitPreview = (triggerMode, page, delay) => new Promise(async (resolve) => {
  let resolved = false
  if (triggerMode === "DELAY") {
    await sleep(delay)
    resolve()
  }
  else if (triggerMode === "FN_TRIGGER") {
    Promise.race([
      // add event listener and wait for event to fire before returning
      page.evaluate(function() {
        return new Promise(function(resolve, reject) {
          window.addEventListener("fxhash-preview", function() {
            resolve() // resolves when the event fires
          })
        })
      }),
      sleep(DELAY_MAX)
    ]).then(resolve)
  }
}) 

const ERRORS = [
  "UNKNOWN",
  "HTTP_ERROR",
  "MISSING_PARAMETERS",
  "INVALID_TRIGGER_PARAMETERS",
  "INVALID_PARAMETERS",
  "UNSUPPORTED_URL",
  "CANVAS_CAPTURE_FAILED",
  "TIMEOUT"
]

const TRIGGER_MODES = [
  "DELAY",
  "FN_TRIGGER"
]

function isTriggerValid(triggerMode, delay) {
  if (!TRIGGER_MODES.includes(triggerMode)) {
    return false
  }
  if (triggerMode === "DELAY") {
    // delay must be defined if trigger mode is delay
    return typeof delay !== undefined && !isNaN(delay) && delay >= DELAY_MIN && delay <= DELAY_MAX
  }
  else if (triggerMode === "FN_TRIGGER") {
    // fn trigger doesn't need any param
    return true
  }
}

/**
 * expects:
 *  - capture settings:
 *    - mode
 *    - canvasSelector (if mode canvas)
 *    - delay (if mode canvas|viewport)
 *    - resX (if mode viewport)
 *    - resY (if mode viewport)
 * process:
 *  - assert inputs validity
 *  - spawn chromium instance + navigate to the page
 *  - depending on the mode provided, extract capture from the page
 * outputs:
 *  - image content
 */
exports.capture = async (req, res) => {
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
    let { url, resX, resY, delay, mode, triggerMode, canvasSelector } = req.body

    // default parameter for triggerMode
    if (typeof triggerMode === "undefined") {
      triggerMode = "DELAY"
    }

    // check if general parameters are correct
    if (!url || !mode) {
      throw "MISSING_PARAMETERS"
    }
    if (!isUrlValid(url)) {
      throw "UNSUPPORTED_URL"
    }
    if (!["CANVAS", "VIEWPORT", "CUSTOM".includes(mode)]) {
      throw "MISSING_PARAMETERS"
    }

    // check if trigger paremeters are correct
    if (!isTriggerValid(triggerMode, delay)) {
      throw "INVALID_TRIGGER_PARAMETERS"
    }
    
    // check parameters correct based on mode
    if (mode === "VIEWPORT") {
      if (!resX || !resY) {
        throw "MISSING_PARAMETERS"
      }
      resX = Math.round(resX)
      resY = Math.round(resY)
      if (isNaN(resX) || isNaN(resY) || resX < 256 || resX > 2048 || resY < 256 || resY > 2048) {
        throw "INVALID_PARAMETERS"
      }
    }
    else if (mode === "CANVAS") {
      if (!canvasSelector) {
        throw "INVALID_PARAMETERS"
      }
    }

    // register the smiley font
    await chromium.font(path.resolve(__dirname, 'fonts', 'NotoColorEmoji.ttf'))

    // start chromium instance
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    })

    // browse to the page
    const viewportSettings = {
      deviceScaleFactor: 1,
    }
    if (mode === "VIEWPORT") {
      viewportSettings.width = resX
      viewportSettings.height = resY
    }
    else {
      viewportSettings.width = 800
      viewportSettings.height = 800
    }
    let page = await browser.newPage()
    await page.setViewport(viewportSettings)

    // try to reach the page
    let response
    try {
      response = await page.goto(url, {
        timeout: 300000
      })
    }
    catch(err) {
      if (err && err.name && err.name === "TimeoutError") {
        throw "TIMEOUT"
      }
      else {
        throw null
      }
    }

    if (response.status() !== 200) {
      throw "HTTP_ERROR"
    }

    // based on the capture mode, trigger different operations
    if (mode === "VIEWPORT") {
      await waitPreview(triggerMode, page, delay)
      // we simply take a capture of the viewport
      const capture = await page.screenshot()
      result = capture
    }
    else if (mode === "CANVAS") {
      try {
        await waitPreview(triggerMode, page, delay)
        // get the base64 image from the CANVAS targetted
        const base64 = await page.$eval(canvasSelector, (el) => {
          if (!el || el.tagName !== "CANVAS") return null
          return el.toDataURL()
        })
        if (!base64) throw null
        const pureBase64 = base64.replace(/^data:image\/png;base64,/, "")
        result = Buffer.from(pureBase64, "base64")
      }
      catch(err) {
        throw "CANVAS_CAPTURE_FAILED"
      }
    }
	}
	catch (error) {
    return res.status(500).send(ERRORS.includes(error) ? error : "UNKNOWN")
	}
  finally {
    if (browser !== null) {
      browser.close()
    }
  }

  // if the image is too big, we need to compress it
  if (result.byteLength > 10*1024*1024) {
    const compressed = await sharp(result)
      .resize(1024, 1024, { fit: "inside" })
      .jpeg({ quality: 100 })
      .toBuffer()

    res.set("Content-Type", "image/jpeg")
    return res.status(200).send(compressed)
  }

  // let message = req.query.message || req.body.message || 'Hello World 2!'
  res.set("Content-Type", "image/png")
  return res.status(200).send(result)
}