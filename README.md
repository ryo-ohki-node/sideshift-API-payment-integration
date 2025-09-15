# sideshift-API-payment-gateway
Enable cryptocurrency payments in your shop. This integration use the sideshift-API-nodejs module.

## API Credentials
```
const SIDESHIFT_ID = "Your_shideshift_ID"; 
const SIDESHIFT_SECRET = "Your_shideshift_secret";
```

## Payment Settings
```
SHOP_SETTING.locale = "en-EN";
SHOP_SETTING.devise = "USD"; // Supported currencies: USD, EUR, JPY... (ISO standard)
SHOP_SETTING.USD_REFERENCE_COIN = "USDT-bsc"; // Must be a coin-network from the coinList
```

## Wallet Configuration
Important: The current version requires two different wallets since the shift API doesn't support same-coin shifts (e.g., BTC to BTC).

## Main Wallet
```
const main_wallet = {
    coin: "USDT",
    network: "bsc",
    address: "Your_Wallet_Address",
    isWalletStableCoin: true,
    isWalletMemo: [false, ""] // Set to [true, "YourMemoHere"] if wallet requires memo
}
```
## Secondary Wallet
```
const secondary_wallet = {
    coin: "BNB",
    network: "bsc",
    address: "Your_Wallet_Address",
    isWalletStableCoin: false,
    isWalletMemo: [false, ""]
}
```

⚠️ Important:
Set isWalletStableCoin correctly - this affects how payment amounts are calculated in crypto. 

Wallets can be set on different network (we only use one for simplicity, like in this example BSC with 2 differents coins). Those two coins must be different (USDT and BNB for this example). You cannot set same coin-network twice.





