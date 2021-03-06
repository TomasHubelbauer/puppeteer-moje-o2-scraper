import puppeteer from 'puppeteer';
import keytar from 'keytar';
import readline from 'readline';
import fs from 'fs-extra';

// Screenshot
import GIFEncoder from 'gifencoder';
import inkjet from 'inkjet';
import terminalImage from 'terminal-image';

void async function () {
	const userName = process.argv[2] === '--' ? process.argv[3] : await ask('MojeO2.cz email:');
	let password = await keytar.getPassword('MojeO2.cz', userName);
	if (password === null) {
		console.log('There is no password stored for Moje O2.');
		password = await ask('MojeO2.cz password:');
		if (await ask('Do you want to save this password using Keytar? yes/no') === 'yes') {
			await keytar.setPassword('MojeO2.cz', userName, password);
		}
	}

	const browser = await puppeteer.launch({ headless: false, args: ['--window-size=800,600' /* Match default viewport */] });
	const page = (await browser.pages())[0];
	try {
		// Speed up browsing and clean up screenshots by blocking 3rd party networking
		await page.setRequestInterception(true);
		page.on('request', request => {
			const url = new URL(request.url());
			if (url.hostname !== 'moje.o2.cz' && url.hostname !== 'login.o2.cz' && url.hostname !== 'sso.o2.cz') {
				request.abort()
			} else {
				request.continue();
			}
		});

		await page.tracing.start({ screenshots: true });
		await page.goto('https://moje.o2.cz/web/o2/login');
		await page.focus('#username');
		await page.addStyleTag({ content: '#username { filter: blur(10px);  }' });
		await page.keyboard.type(userName);
		await page.focus('#password');
		await page.addStyleTag({ content: '#password { filter: blur(10px);  }' });
		await page.keyboard.type(password);
		await page.click('#submitButton');
		await page.waitForNavigation(); // https://moje.o2.cz/web/o2/userdashboard
		await page.click('span[data-key="onecrm.gui_billingManagement.invoices.link.statement"]');
		await page.addStyleTag({ content: '.o2-subheader__perex, .js-clickable-more, .js-lazylist b { filter: blur(10px);  }' });

		// The table is lazy-loaded
		await page.waitForSelector('.js-clickable-more');

		// Collect all links while on this page because the elements will disappear
		// once the page is navigated away from
		let hrefs = [];
		for (const element of await page.$$('.js-clickable-more')) {
			hrefs.push(await page.evaluate(e => e.href, element));
		}

		for (const href of hrefs) {
			await page.goto(href, { waitUntil: 'domcontentloaded' });
			await page.addStyleTag({ content: 'body { filter: blur(10px);  }' });
			const { name, url } = await page.evaluate(element => new Promise(async resolve => {
				const response = await fetch(element.href);
				const blob = await response.blob();
				const fileReader = new FileReader();
				fileReader.addEventListener('load', () => resolve({ name: element.href.split(/\//g).reverse()[0] + '.pdf', url: fileReader.result }));
				fileReader.addEventListener('error', resolve);
				fileReader.readAsBinaryString(blob);
			}), await page.$('a[href^="/delegate/ebillDownload"]'));

			await fs.writeFile(name, Buffer.from(url, 'binary'));
			console.log('Downloaded and saved', name);
		}
	} finally {
		console.log('Collecting and parsing the trace data.');
		const trace = JSON.parse(String(await page.tracing.stop()));
		const snapshotTraceEvents = trace.traceEvents.filter(traceEvent => traceEvent.args.snapshot);

		let gifEncoder;
		for (const traceEvent of snapshotTraceEvents) {
			const buffer = Buffer.from(traceEvent.args.snapshot, 'base64');
			const { width, height, data } = await new Promise((resolve, reject) => inkjet.decode(buffer, (error, data) => {
				if (error) {
					reject(error);
				}

				resolve(data);
			}));

			if (!gifEncoder) {
				gifEncoder = new GIFEncoder(width, height);
				gifEncoder.createReadStream().pipe(fs.createWriteStream('screenshot.gif'));
				gifEncoder.start();
				gifEncoder.setRepeat(0); // Repeat
				gifEncoder.setDelay(50);
				gifEncoder.setQuality(10); // Best?
			}

			console.log(await terminalImage.buffer(buffer));
			if (await ask('Confirm the frame is good to go to the screenshot: (y)') === 'y') {
				gifEncoder.addFrame(data);
			}
		}

		console.log('Finishing up the screenshot animation.');
		gifEncoder.finish();
		await browser.close();
	}
}()

function ask(question) {
	return new Promise(resolve => {
		const io = readline.createInterface({ input: process.stdin, output: process.stdout });
		io.question(question + '\n', answer => {
			io.close();
			resolve(answer);
		});
	});
}
