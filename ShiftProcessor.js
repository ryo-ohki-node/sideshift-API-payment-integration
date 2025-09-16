
class ShiftProcessor {
    constructor({WALLETS, MAIN_COIN, SECONDARY_COIN, SIDESHIFT_CONFIG, SHOP_SETTING}) {
        // Initialize Sideshift API
        try {
            const SideshiftAPI = require('../Sideshift_API_module/sideshift_module.js');
            this.sideshift = new SideshiftAPI({
                secret: SIDESHIFT_CONFIG.secret,
                id: SIDESHIFT_CONFIG.id,
                commisssionRate: SIDESHIFT_CONFIG.commisssionRate,
                verbose: SIDESHIFT_CONFIG.verbose
            });
              } catch (error) {
            console.error('Error initializing Sideshift API:', error);
            const err = 'Error initializing Sideshift API:'+error;
            throw err;
        }
        try {
            const fs = require('fs');
        } catch (error) {
            console.error('Missing library: fs', error);
            const err = 'Missing library: fs ' + error;
            throw err;
        }

        // use same verbose config 
        this.verbose = SIDESHIFT_CONFIG.verbose;
        
        // set variables, shop locale data, coins list and wallets
        this.availableCoins = null;
        this.lastCoinList = [];

        this.WALLETS = WALLETS;
        this.MAIN_COIN = MAIN_COIN;
        this.SECONDARY_COIN = SECONDARY_COIN;
        this.SHOP_SETTING = SHOP_SETTING;

        // Base URL for USD exhange rate
        this.EXCHANGE_RATE_API_URL = "https://api.exchangerate-api.com/v4/latest/" + this.SHOP_SETTING.devise;
    }



    getDestinationWallet(inputCoin) {
        if (inputCoin === this.MAIN_COIN) {
            return this.WALLETS[this.SECONDARY_COIN];
        }
        return this.WALLETS[this.MAIN_COIN];
    }

    async getUSDRate() {
        try {
            const getRates = await fetch(this.EXCHANGE_RATE_API_URL, {
                headers: { "Content-Type": "application/json" },
                method: "GET"
            });

            if (!getRates.ok) {
                throw new Error(`HTTP error! status: ${getRates.status}`);
            }

            const ratesObj = await getRates.json();
            return Number(ratesObj.rates.USD);
        } catch (error) {
            console.error('Error in getUSDRate:', error);
            throw error;
        }
    }

    async getAmountToShift(amountToShift, isStableCoin, outputCoin, outputNetwork) {
        let amount;
        const usdRate = await this.getUSDRate();
        amountToShift = Number(amountToShift) * usdRate;

        if (isStableCoin === true) {
            amount = amountToShift;
        } else {
            let ratio = await this.sideshift.getPair(this.SHOP_SETTING.USD_REFERENCE_COIN, outputCoin + "-" + outputNetwork);
            amount = Number(amountToShift) * Number(ratio.rate);
        }
        return Number(amount);
    }

    async createFixedShift(coin_A, network_A, amount_FIAT) {
        const output = this.getDestinationWallet(coin_A + "-" + network_A);
        const amountCrypto = await this.getAmountToShift(amount_FIAT, output.isStable, output.coin, output.network);

        let quoteData = await this.sideshift.requestQuote({
            depositCoin: coin_A,
            depositNetwork: network_A,
            settleCoin: output.coin,
            settleNetwork: output.network,
            depositAmount: null,
            settleAmount: amountCrypto
        });

        let shiftData;
        if (!quoteData.error) {
            let settleMemo = null;
            if (output.isMemo[0]) settleMemo = String(output.isMemo[1]);
            shiftData = await this.sideshift.createFixedShift({
                settleAddress: output.address,
                quoteId: quoteData.id,
                settleMemo: settleMemo
            });
        }

        if(Number(amountCrypto) !== Number(shiftData.settleAmount)) throw new Error(`createFixedShift error! Wrong amount: ${amountCrypto} != ${shiftData.settleAmount}`);

        return shiftData;
    }


    sanitizeStringInput(input) {
        if (!input || typeof input !== 'string') {
            return '';
        }

        let sanitized = input.replace(/[^a-zA-Z0-9\-\.]/g, '');
        if (sanitized.length === 0) {
            return '';
        }

        sanitized = sanitized.substring(0, 50);
        return sanitized;
    }


    // Update Coins list and Icons
    hasNewCoins(current, previous) {
        const currentSet = new Set(current.map(item => item[0]));
        const previousSet = new Set(previous.map(item => item[0]));

        for (const coin of currentSet) {
            if (!previousSet.has(coin)) {
                return true;
            }
        }
        return false;
    }

    async updateCoinsList(destination) {
        try {
            if (this.verbose) console.log('updateCoinsList function executed at:', new Date());

            const coinList = await this.sideshift.getCoins();
            const allCoins = coinList.flatMap(element => {
                const networks = element.networks.length ? element.networks : [element.mainnet];
                const hasNetworksWithMemo = element.networksWithMemo && element.networksWithMemo.length > 0;

                return networks.map(net => [
                    `${element.coin}-${net}`,
                    hasNetworksWithMemo && element.networksWithMemo.includes(net)
                ]);
            });

            if (this.hasNewCoins(allCoins, this.lastCoinList)) {
                if (this.verbose) console.log('New coins detected. Downloading icons...');
                await this.downloadCoinIcons(allCoins, destination);
            }

            this.lastCoinList = allCoins;
            this.availableCoins = allCoins;

            if (this.verbose) console.log('Coins list updated successfully. Total coins:', allCoins.length);
            return { availableCoins: allCoins, lastCoinList: allCoins };
        } catch (err) {
            throw err;
        }
    }

    async downloadCoinIcons(coinsList, dest) {
        try {
            const downloadDir = dest;

            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true });
            }

            if (this.verbose) console.log(`Starting image downloads, checking ${coinsList.length} coins...`);

            const existingFiles = new Set();
            const coinNetworks = coinsList.map(item => item[0]);

            if (fs.existsSync(downloadDir)) {
                const files = fs.readdirSync(downloadDir);
                for (const file of files) {
                    if (file.endsWith('.svg')) {
                        existingFiles.add(file.replace('.svg', ''));
                    }
                }
            }

            let count = 0;
            const totalCoins = coinNetworks.length;

            for (let i = 0; i < totalCoins; i++) {
                const coinNetwork = this.sanitizeStringInput(coinNetworks[i]);
                if (!coinNetwork) throw new Error('Invalid coin-network name');

                const filePath = path.join(downloadDir, `${coinNetwork}.svg`);

                if (existingFiles.has(coinNetwork)) {
                    if (this.verbose) console.log(`✓ Already exists: ${coinNetwork}.svg`);
                    continue;
                }

                try {
                    if (this.verbose) console.log(`Downloading ${i + 1}/${totalCoins}: ${coinNetwork}`);

                    const blob = await this.sideshift.getCoinIcon(coinNetwork);
                    const buffer = Buffer.from(await blob.arrayBuffer());
                    fs.writeFileSync(filePath, buffer);

                    if (verbose) console.log(`✓ Saved: ${coinNetwork}.svg`);
                    count++;
                } catch (error) {
                    console.error(`✗ Failed to download ${coinNetwork}:`, error.message);
                }

                if (i < totalCoins - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            if (this.verbose) console.log('Download of ' + count + ' missing icon(s) completed!');
        } catch (error) {
            console.error('Error in downloadCoinIcons:', error.message);
        }
    }
}



module.exports = ShiftProcessor;
