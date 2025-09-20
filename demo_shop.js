// Sideshift API payment integration Node.js - Demo shop
require('dotenv').config({ quiet: true }); //  debug: true 

const express = require('express');
const https = require('https');
const fs = require('fs');

// Create Express app
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'pug');
app.set('views', __dirname+'/views');
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.redirect('selection');
});

// Start HTTPS server
const options = {
  key: fs.readFileSync(__dirname+'/key.pem'),
  cert: fs.readFileSync(__dirname+'/cert.pem')
};

// Path to store downloaded icons
const ICON_PATH = './public/icons';


const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
    windowMs: 3 * 60 * 1000,
    max: 100, 
    message: 'Too many payment requests, please try again later'
});

const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: 'Too many payment requests, please try again later'
});


// Demo function to Reset Crypto payment
function resetCryptoPayment(invoiceId, shiftId){
    if (shopOrderObj[invoiceId]) {
		shopOrderObj[invoiceId].paymentOtpion = "";
		shopOrderObj[invoiceId].paymentStatus = "canceled";
		shopOrderObj[invoiceId].total_crypto = "";
		shopOrderObj[invoiceId].payWith = "";
		shopOrderObj[invoiceId].isMemo = "";
		shopOrderObj[invoiceId].failedPayment.push({type: "crypto", id: shiftId});
		shopOrderObj[invoiceId].status = "waiting";
	}
}

// Demo function to Confirm Crypto payment
function confirmCryptoPayment(invoiceId, shiftId){
	if (shopOrderObj[invoiceId]) {
		shopOrderObj[invoiceId].paymentID = shiftId;
		shopOrderObj[invoiceId].status = "confirmed";
	}
}


// Shop configuration
const SHOP_SETTING = {};
SHOP_SETTING.locale = "en-EN";
SHOP_SETTING.currency = "USD"; // USD EUR CNY INR JPY ... use ISO4217 currency codes
SHOP_SETTING.USD_REFERENCE_COIN = "USDT-bsc"; // Must be a 'coin-network' from the sideshift API

const SHIFT_PAYMENT_STATUS = {
    waiting: "waiting",
	pending: "pending",
	processing: "processing",
	settling: "settling",
    expired: "expired",
    settled: "settled"
};


// Wallet configuration - Do not change the object key structure
const MAIN_WALLET = {
	coin: "USDT",
	network: "bsc",
	address: process.env.WALLET_ADDRESS, // Your wallet address
	isMemo: [false, ""] // Set to [false, ""] or if your wallet need a Memo set to [true, "YourMemoHere"]
}

const SECONDARY_WALLET = {
	coin: "BNB",
	network: "bsc",
	address: process.env.WALLET_ADDRESS,
	isMemo: [false, ""]
}

const MAIN_COIN = `${MAIN_WALLET.coin}-${MAIN_WALLET.network}`;
const SECONDARY_COIN = `${SECONDARY_WALLET.coin}-${SECONDARY_WALLET.network}`;

const WALLETS = {
    [MAIN_COIN]: MAIN_WALLET,
    [SECONDARY_COIN]: SECONDARY_WALLET
};

const SIDESHIFT_CONFIG = {
	secret: process.env.SIDESHIFT_SECRET, // "Your_shideshift_secret";
	id: process.env.SIDESHIFT_ID, //"Your_shideshift_ID"; 
	commissionRate: "0.5",
	verbose: true
}


// Use sideshift verbose setting
const verbose_mode = SIDESHIFT_CONFIG.verbose;

// Load the crypto payment processor
const cryptoPaymentProcessor = require('./ShiftProcessor.js')
const shiftProcessor = new cryptoPaymentProcessor({WALLETS, MAIN_COIN, SECONDARY_COIN, SIDESHIFT_CONFIG, SHOP_SETTING});

// Load the payment poller system
const PaymentPoller = require('./CryptoPaymentPoller.js');
const cryptoPoller = new PaymentPoller({shiftProcessor, intervalTimeout: 120000, resetCryptoPayment, confirmCryptoPayment}); // import sideshiftAPI and set interval delay in ms

// Set basic variables
let availableCoins = null;
let shopOrderObj = {}


// Payment polling system
async function checkOrderStatus(shift, invoiceId, destWallet, amount) {
  try {
    // your logic here
    cryptoPoller.addPayment(shift, invoiceId, destWallet, amount);
    
    return true;
  } catch (error) {
    console.error('Payment creation failed:', error);
    // throw error;
  }
}


// Website routes
app.get("/selection", rateLimiter, function(req,res){
	const coinsList = availableCoins ? availableCoins.sort() : null;
	res.render('select-payment-method', { coinsListDeposit: coinsList, currency: SHOP_SETTING.currency });
});

app.post("/create-quote", paymentLimiter, async function(req,res){
    try {
        const total = req.body.total;
        if (!total) throw new Error("Missing total amount");
        if (isNaN(Number(total)) || Number(total) <= 0) {
            return res.status(400).send("Invalid total amount");
        }
		const payWith = JSON.parse(req.body.pay_with);
		const payWithCoin = shiftProcessor.sanitizeStringInput(payWith[0]);
        if (!payWith || !payWithCoin) throw new Error("Missing input coin");
		
        // Test input coin to set destination wallet
		const outputChoise = shiftProcessor.getDestinationWallet(payWithCoin);

        // Convert FIAT amout into crypto
        let amount = await shiftProcessor.getAmountToShift(total, payWith[0], outputChoise.coin+"-"+outputChoise.network);

		// check if coin-network exist on sideshift coin list
		const isValidCoin = isCoinValid(payWith[0]);;// availableCoins.some(c => c[0] === payWith[0]);
		if (!isValidCoin) return res.status(400).send("Invalid coin/network");

		const getPairData = await shiftProcessor.sideshift.getPair(payWithCoin, outputChoise.coin+"-"+outputChoise.network);

		const orderId = shiftProcessor.sanitizeStringInput(req.body.shopOrderID);

        // Set basic demo costumer object
		shopOrderObj[orderId] = {};
		shopOrderObj[orderId].id = orderId;
		shopOrderObj[orderId].total = total;
		shopOrderObj[orderId].paymentOtpion = "crypto";
		shopOrderObj[orderId].paymentStatus = "waiting";
		shopOrderObj[orderId].failedPayment = [];
		shopOrderObj[orderId].total_crypto = amount;
		shopOrderObj[orderId].payWith = payWithCoin;
		shopOrderObj[orderId].isMemo = String(payWith[1]);
		shopOrderObj[orderId].status = "created";

		res.render('crypto', { ratio: getPairData, invoice: shopOrderObj[orderId], SHOP_SETTING })
    } catch (err) {
        if (verbose_mode) console.error("Error - crypto-select:", err);
        res.status(500).send("Internal Server Error");
    }
});

app.post("/create-payment", paymentLimiter, async function(req, res) {
	try {
        const id = shiftProcessor.sanitizeStringInput(req.body.id);
        const coin = shiftProcessor.sanitizeStringInput(req.body.coin);
        const network = shiftProcessor.sanitizeStringInput(req.body.network);
        const total = req.body.total;

		if (!id || !coin || !network || !total) {
            return res.status(400).send("Missing required parameters");
        }
		if (!shopOrderObj[id]) return res.status(400).send("Invalid invoice ID");
        
        const totalAmountFIAT = Number(total);
        if (isNaN(totalAmountFIAT) || totalAmountFIAT <= 0 || totalAmountFIAT > 1000000) {
            return res.status(400).send("Invalid total amount");
        }

		// check if coin-network exist on sideshift coin list
		const isValidCoin = isCoinValid(`${coin}-${network}`); // availableCoins.some(c => c[0] === `${coin}-${network}`);
		if (!isValidCoin) return res.status(400).send("Invalid coin/network");

        // Create shift
        const shift = await shiftProcessor.createFixedShift(coin, network, totalAmountFIAT, shiftProcessor.extractIPInfo(req.ip).address);
		// Activate Polling system
        checkOrderStatus(shift, id, shift.settleAddress, shift.settleAmount);

        res.redirect(`/payment-status/${shift.id}/${id}`);
    } catch (err) {
        if (verbose_mode) console.error("Error in create-payment:", err);
        res.status(500).send("Internal Server Error");
    }
});


const handleCryptoShift = async (req, res, next) => {
    try {
        const invoiceId = shiftProcessor.sanitizeStringInput(String(req.params.id_invoice));
        if (!invoiceId) throw new Error("Missing invoice ID");
        if (!shopOrderObj[invoiceId]) throw new Error("Invalid invoice ID");

        const shiftId = shiftProcessor.sanitizeStringInput(String(req.params.id_shift));
        if (!shiftId) throw new Error("Missing shift ID");

        const shiftData = cryptoPoller.getPollingShiftData(shiftId);
        let shift;
        
        if (shiftData) {
            // Use existing polling data
            shift = { ...shiftData.shift };
            if (this.verbose) console.log(`Using cached polling data for ${shiftId}`);
        } else {
            // Fallback to API call if not in polling system
            shift = await shiftProcessor.sideshift.getShift(shiftId);
            if (this.verbose) console.log(`Fetched fresh data for ${shiftId} from API`);
        }
            
        req.shift = shift;
        req.invoice = shopOrderObj[invoiceId];
        next();
    } catch (err) {
        if (verbose_mode) console.error("Error - handleCryptoShift:", err);

        if (err.message.includes('Missing')) {
            res.status(400).send("Bad Request: " + err.message);
        } else {
            res.status(500).send("Error: " + err.message);
        }
    }
};

app.get("/payment-status/:id_shift/:id_invoice", rateLimiter, handleCryptoShift, (req, res) => {
    const { shift, invoice } = req;
    if (!shift || !invoice) {
        return res.status(400).send("Invalid payment data");
    }

    switch(shift.status) {
        case SHIFT_PAYMENT_STATUS.settled:
            return res.redirect(`/success/${shift.id}/${invoice.id}`);
        case SHIFT_PAYMENT_STATUS.expired:
            return res.redirect(`/cancel/${shift.id}/${invoice.id}`);
        default:
            return res.render('crypto', {
                shift,
                invoice,
                SHOP_SETTING
            });
    }
});
app.get("/success/:id_shift/:id_invoice", rateLimiter, handleCryptoShift, async (req, res) => {
    try {
        if (req.shift.status !== SHIFT_PAYMENT_STATUS.settled) {
            if(verbose_mode) console.log("Shift not settled yet", req.shift.id, req.invoice.id);
            res.redirect("/payment-status/"+req.shift.id+"/"+req.invoice.id);
        } else {
            const successData = {
                shift: req.shift,
                order: shopOrderObj[req.invoice.id]
            };
            res.render('cencel-success')({success: successData, SHOP_SETTING});
        }

    } catch (err) {
        if (verbose_mode) console.error("Error in success route:", err);
        res.status(500).send("Error: " + err.message);
    }
});

app.get("/cancel/:id_shift/:id_invoice", rateLimiter, handleCryptoShift, async (req, res) => {
    try {
		if (req.shift.status !== SHIFT_PAYMENT_STATUS.expired) {
            if(verbose_mode) console.log("Shift not expired yet", req.shift.id, req.invoice.id);
            res.redirect("/payment-status/"+req.shift.id+"/"+req.invoice.id);
        } else {
    		res.status(400).send(`Canceled payment ${req.shift.id}, your order ${req.invoice.id} is not confirmed, try again`);
        }

    } catch (err) {
        if (verbose_mode) console.error("Error in cancel route:", err);
        res.status(500).send("Error: " + err.message);
    }

});


// app.post("/cancel-shift/:id_shift/:id_invoice", rateLimiter, handleCryptoShift, async (req, res) => {
//     try {
//         if (req.shift.status !== SHIFT_PAYMENT_STATUS.settled && req.shift.status !== SHIFT_PAYMENT_STATUS.expired) {
//             await cryptoPoller.stopPollingForShift(req.shift.id);
//             res.redirect(`/cancel/${shift.id}/${invoice.id}`);
//         } else{
//             res.redirect("/payment-status/"+req.shift.id+"/"+req.invoice.id)
//         }
//     } catch (err) {
//         if (verbose_mode) console.error("Error in cancel-shift route:", err);
//         res.status(500).send("Error: " + err.message);
//     }
// });


function isCoinValid(coin){
    return availableCoins.some(c => c[0] === coin);
}


// For production store coins list in DB so no need to reload each server start
shiftProcessor.updateCoinsList(ICON_PATH).then((response) => {
    console.log('Initial coins list loaded');
	availableCoins = response.availableCoins;

    // Check if configuration coins are supported by sideshift
    const isValidCoin_1 = isCoinValid(MAIN_COIN);
    const isValidCoin_2 = isCoinValid(SECONDARY_COIN);

    if (!isValidCoin_1 || !isValidCoin_2) {
        console.error("Invalid configuration coin", MAIN_COIN, SECONDARY_COIN)
        process.exit(1);
    }

    https.createServer(options, app).listen(PORT, () => {
        console.log(`HTTPS Server running at https://localhost:${PORT}/`);
    });
    
    setInterval(async () => {
        const result = await shiftProcessor.updateCoinsList(ICON_PATH);
        // Update global variables if needed
        availableCoins = result.availableCoins;
    }, 12 * 60 * 60 * 1000);
}).catch(err => {
    console.error('Failed to load initial coins list:', err);
    process.exit(1);
});
