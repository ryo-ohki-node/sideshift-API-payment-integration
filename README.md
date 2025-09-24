# sideshift-API-payment-integration package

This Node.js package enables cryptocurrency payments in your Node.js project by integrating with the [Sideshift API](https://sideshift.ai/) using the [sideshift-api-nodejs](https://github.com/ryo-ohki-node/sideshift-api-nodejs) module, allowing you to integrate cryptocurrency payment processing in any Node.js project with just a few tweaks. It supports real-time payment processing, polling for transaction confirmations, 237+ cryptocurrencies and multi-currency support including USD, EUR, JPY, etc.


## Components
- `cryptoProcessor`: Handles the creation and management of crypto payments via Sideshift API.
- `PaymentPoller`: Polls the sideshift API for payment confirmation and triggers success/failure callbacks.


## Installation 

### Package
The package only requires the fs and sideshift API modules to work.
Use this file from the repo: [sideshift-api-nodejs](https://github.com/ryo-ohki-node/sideshift-api-nodejs/sideshiftAPI.js)
```bash
npm install fs
```

### Demo server
Simple sample settings of how to use this package on server and client sides.

```bash
npm install  https express pug fs
// you need to set you cert.pem and key.pem for the https server before launching
node demoshop.js
```

📝 Note: It will download and store the coin icon on the first start.


## Configuration

### API Credentials
```
const SIDESHIFT_ID = "Your_sideshift_ID"; 
const SIDESHIFT_SECRET = "Your_shideshift_secret";
const SIDESHIFT_CONFIG = {
	secret: SIDESHIFT_SECRET,
	id: SIDESHIFT_ID,
	commissionRate: "0.5",
	verbose: true
}
```

### Payment Settings
```
SHOP_SETTING.locale = "en-EN"; // Used for the currencie symbol
SHOP_SETTING.currency = "USD"; // Supported currencies: USD, EUR, JPY... (ISO 4217 code standard)
SHOP_SETTING.USD_REFERENCE_COIN = "USDT-bsc"; // Must be a coin-network from the coinList
```

### Wallet Configuration
Important: The current version requires two different wallets since the Sideshift API doesn't support same-coin-network shifts (e.g., BTC-bitcoin to BTC-bitcoin).

```
const MAIN_WALLET = {
	coin: "USDT",
	network: "bsc",
	address: "Your wallet address",
	isMemo: [false, ""] // Set to [false, ""] or if your wallet need a Memo set to [true, "YourMemoHere"]
}

const SECONDARY_WALLET = {
	coin: "BNB",
	network: "bsc",
	address: "Your wallet address",
	isMemo: [false, ""]
}

const MAIN_COIN = `${MAIN_WALLET.coin}-${MAIN_WALLET.network}`;
const SECONDARY_COIN = `${SECONDARY_WALLET.coin}-${SECONDARY_WALLET.network}`;

const WALLETS = {
    [MAIN_COIN]: MAIN_WALLET,
    [SECONDARY_COIN]: SECONDARY_WALLET
};
```

⚠️ Important Notes
1. Wallets can be set on different networks (we only use 'bsc' for simplicity in this example, with 2 different coins, this is the easiest setting)
2. You cannot set the same coin-network twice
    - ❌ Invalid: USDT-ethereum and USDT-ethereum
    - ✅ Valid: USDT-ethereum and USDT-bsc


### Load the crypto payment processor
```
const cryptoProcessor = require('./ShiftProcessor.js')
const shiftGateway = new cryptoProcessor({
  WALLETS,
  MAIN_COIN,
  SECONDARY_COIN,
  SIDESHIFT_CONFIG,
  SHOP_SETTING
});
```

### Load the payment poller system
```
const PaymentPoller = require('./CryptoPaymentPoller.js');
const cryptoPoller = new PaymentPoller({
  shiftGateway,
  intervalTimeout: 120000, // ms
  resetCryptoPayment,
  confirmCryptoPayment
});
```


## Usage
See '/selection', '/create-quote' and '/create-payment' route on the demo server.

### Test input coin to set destination wallet
```
const inputCoin = ['BNB-bsc', false]; // ['COIN-network', "Memo_here" || false]
const outputChoise = shiftGateway.getDestinationWallet(inputCoin); 
```

### Convert FIAT amount to crypto
Parameters 
- amount FIAT currency (e.g., 100.54)
- from (e.g., BTC-bitcoin)
- to (e.g., ETH-ethereum)
```
let amount = await shiftGateway.getAmountToShift(amount, from, to);
```

### Get shift pair information
Parameters 
- from (e.g., BTC-bitcoin)
- to (e.g., ETH-ethereum)
```
const getPairData = await shiftGateway.sideshift.getPair(from, to);
```

### Create invoice shift 
Parameters 
- coin (e.g., BTC)
- network (e.g., bitcoin)
- amount cryptocurrency (e.g., 0.05)
- userIp (e.g., 123.123.123.123)
```
const shift = await shiftGateway.createFixedShift(depositCoin, depositNetwork, amount, userIp);
```
