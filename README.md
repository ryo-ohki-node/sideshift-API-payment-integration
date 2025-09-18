# sideshift-API-payment-integration package

This Node.js package enables cryptocurrency payments in your shop by integrating with the [Sideshift API](https://sideshift.ai/). This integration uses the [sideshift-api-nodejs](https://github.com/ryo-ohki-node/sideshift-api-nodejs) module. It supports real-time payment processing, polling for transaction confirmations, 237+ cryptocurrencies and multi-currency support including USD, EUR, JPY, etc.


## Components
- `cryptoProcessor`: Handles the creation and management of crypto payments via Sideshift API.
- `PaymentPoller`: Polls the sideshift API for payment confirmation and triggers success/failure callbacks.


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
SHOP_SETTING.locale = "en-EN"; // Used for the currencie symbole
SHOP_SETTING.currency = "USD"; // Supported currencies: USD, EUR, JPY... (ISO 4217 code standard)
SHOP_SETTING.USD_REFERENCE_COIN = "USDT-bsc"; // Must be a coin-network from the coinList
```

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



## Wallet Configuration
Important: The current version requires two different wallets since the Sideshift API doesn't support same-coin shifts (e.g., BTC to BTC).

### Main Wallet
```
const main_wallet = {
    coin: "USDT",
    network: "bsc",
    address: "Your_Wallet_Address",
    isWalletMemo: [false, ""] // Set to [true, "YourMemoHere"] if wallet requires memo
}
```

### Secondary Wallet
```
const secondary_wallet = {
    coin: "BNB",
    network: "bsc",
    address: "Your_Wallet_Address",
    isWalletMemo: [false, ""]
}
```

⚠️ Important Notes
1. Wallets can be set on different networks (we only use 'bsc' for simplicity in this example, with 2 different coins, this is the easiest setting)
2. You cannot set the same coin-network twice
    - ❌ Invalid: USDT-ethereum and USDT-ethereum
    - ✅ Valid: USDT-ethereum and USDT-bsc


## Installation 

### Package
The package only require fs and sideshift API module to works
Use this file from the repo: [sideshift-api-nodejs](https://github.com/ryo-ohki-node/sideshift-api-nodejs/sideshiftAPI.js)
```bash
npm install fs
```

### Demo server
Simple sample setting of how to use this Package on server and client side. 

```bash
npm install  https express pug fs
// you need to set you cert.pem and key.pem for the https server before launching
node demoshop.js
```

📝 Note: It will download and store the coin icon at first start.


## Usage
See '/selection', '/create-quote' and '/create-payment' route on the demo server.

### Test input coin to set destination wallet
```
const inputCoin = ['BNB-bsc', false]; // ['COIN-network', "Memo_here" || false]
const outputChoise = shiftGateway.getDestinationWallet(inputCoin); 
```

### Convert FIAT amount to crypto
```
let amount = await shiftGateway.getAmountToShift(total, outputCoin-outputNetwork, inputCoin[0]);
```

### Get shift pair information
```
const getPairData = await shiftGateway.sideshift.getPair(payWithCoin, outputChoise.coin+"-"+outputChoise.network);
```

### Create invoice shift 
```
const shift = await shiftGateway.createFixedShift(coin, network, totalAmountFIAT, userIP);
```


