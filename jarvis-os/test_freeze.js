import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  
  await page.goto('http://localhost:5173');
  
  // Wait for the app to load
  await new Promise(r => setTimeout(r, 2000));
  
  // We need to bypass the file upload requirement to test the optimizer?
  // Actually, we can just execute `window.handleOptimize` if it was global, but it's not.
  // Let's create a file input and upload a mock string.
  
  // Actually, we can click the button first to see if it even responds.
  // The button has text "GRID SEARCH OPTIMIZER"
  const [button] = await page.$x("//button[contains(., 'GRID SEARCH OPTIMIZER')]");
  if (button) {
    console.log("Found button, clicking...");
    await button.click();
    await new Promise(r => setTimeout(r, 1000));
  } else {
    console.log("Button not found");
  }

  await browser.close();
})();
