class PaymentPoller {
    constructor({ shiftGateway, intervalTimeout = 120000, resetCryptoPayment, confirmCryptoPayment }) {
        if (!shiftGateway) throw new Error('Missing parameter "shiftGateway". PaymentPoller need sideshift API access to run')
        this.shiftMapping = new Map();

        // Set initial Polling control
        this.isPolling = false;
        this.pollTimer = null;

        // Store active polling queue
        this.pollingQueue = new Set();

        // Set polling interval in ms, default to 2 minutes
        this.delay = Number(intervalTimeout);

        // setting sideshift API 
        this.shiftGateway = shiftGateway;

        // Use sideshift Verbose setting
        this.verbose = shiftGateway.verbose;

        this.maxRetries = 3;

        // Quick demo way to update costumer data
        this.confirmCryptoPayment = confirmCryptoPayment;
        this.resetCryptoPayment = resetCryptoPayment;
    }

    // Add payment to tracking
    addPayment(shiftId, orderId, destWallet, amount) {
        if (!shiftId || !orderId || !destWallet || !amount) {
            throw new Error('Invalid parameters passed to addPayment');
        }
        if (this.verbose) console.log(`Adding payment ${shiftId} to polling`);

        // Store in your existing mapping structure
        this.shiftMapping.set(shiftId, {
            status: 'waiting',
            orderId: orderId,
            amount: amount,
            wallet: destWallet,
            timestamp: new Date(),
            lastChecked: null,
            retries: 0
        });

        // Add to polling queue
        this.pollingQueue.add(shiftId);

        // Start polling if not already running
        if (!this.isPolling) {
            this.startPolling();
        }
    }


    // Start polling - event-driven approach
    startPolling() {
        if (this.verbose) console.log('Starting payment polling');
        this.isPolling = true;

        // Clear any existing timer to prevent multiple simultaneous polls
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        // Start the polling cycle
        this.pollOnce();
    }

    // Single polling execution - event-driven
    async pollOnce() {
        if (this.pollingQueue.size === 0) {
            if (this.verbose) console.log('No payments to poll, stopping polling');
            this.isPolling = false;
            return;
        }

        if (this.verbose) console.log(`Polling ${this.pollingQueue.size} payments...`);

        const activeShifts = Array.from(this.pollingQueue).filter(id => {
            const data = this.shiftMapping.get(id);
            return data && !['settled', 'expired'].includes(data.status);
        });

        for (const shiftId of activeShifts) {
            try {
                // Get current status from API
                const data = await this.shiftGateway.sideshift.getShift(shiftId);
                const newStatus = data.status;

                if (this.verbose) console.log(`Payment ${shiftId} status: ${newStatus}`);

                // Update your mapping with new status
                if (this.shiftMapping.has(shiftId)) {
                    const paymentData = this.shiftMapping.get(shiftId);

                    // Only update if status changed
                    if (paymentData.status !== newStatus) {
                        if (this.verbose) console.log(`Status changed for ${shiftId}: ${paymentData.status} -> ${newStatus}`);

                        // Update local mapping
                        paymentData.status = newStatus;
                        paymentData.lastChecked = new Date();

                        // Process completed payments
                        if (newStatus === 'settled') {
                            await this.handleCompletedPayment(data, paymentData, shiftId);
                            this.pollingQueue.delete(shiftId); // Remove from polling
                            if (this.verbose) console.log(`Removed ${shiftId} from polling queue`);
                        } else if (newStatus === 'expired') {
                            await this.handleFailedPayment(data, paymentData, shiftId);
                            this.pollingQueue.delete(shiftId); // Remove from polling
                            if (this.verbose) console.log(`Removed failed ${shiftId} from polling queue`);
                        }
                    }

                } else {
                    // If shiftId not in mapping
                    if (this.verbose) console.log(`Unknown ${shiftId} inside polling queue`);
                }

            } catch (error) {
                if (this.verbose) console.error(`Error checking ${shiftId}:`, error);

                // Increment retry count
                if (!this.shiftMapping.has(shiftId)) {
                    this.shiftMapping.set(shiftId, { status: 'unknown', lastChecked: new Date(), retries: 0 });
                }

                const paymentData = this.shiftMapping.get(shiftId);
                paymentData.retries += 1;

                if (this.verbose) console.log(`Retry count for ${shiftId}: ${paymentData.retries}`);

                // Stop retrying after max retries
                if (paymentData.retries >= this.maxRetries) {
                    if (this.verbose) console.warn(`Max retries (${this.maxRetries}) reached for ${shiftId}, removing from queue`);
                    this.pollingQueue.delete(shiftId);
                    await this.handleRetryExceeded(shiftId, error);
                }
            }
        }

        // Schedule the next polling cycle only if there are still payments to check
        if (this.pollingQueue.size > 0) {
            this.pollTimer = setTimeout(() => {
                this.pollOnce();
            }, this.delay);
        } else {
            if (this.verbose) console.log('All payments processed, stopping polling');
            // this.isPolling = false;
            this.stopPolling();
        }
    }


    // Stop polling manually
    stopPolling() {
        if (this.verbose) console.log('Stopping payment polling');
        this.isPolling = false;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    // Method to manually trigger a poll (optional - for testing/debugging)
    triggerPoll() {
        if (this.verbose) console.log('Manually triggering poll');
        this.pollOnce();
    }

    // Stop specific shift polling with individual timer cleanup
    async stopPollingForShift(shiftId, reason = 'manual') {
        if (this.verbose) console.log(`Stopping polling for shift ${shiftId} - ${reason}`);
        
        // Remove from polling queue
        this.pollingQueue.delete(shiftId);
        
        // Optionally update status in shiftMapping
        const paymentData = this.shiftMapping.get(shiftId);
        if (paymentData) {
            this.shiftMapping.set(shiftId, {
                ...paymentData,
                status: 'stopped',
                stoppedReason: reason,
                stoppedAt: new Date()
            });
        }
        
        // If no more active shifts, stop main timer
        if (this.pollingQueue.size === 0 && this.pollTimer) {
            this.stopPolling();
        }
    }

    // Optional: Method to check if polling is active
    isPollingActive() {
        return this.isPolling;
    }

    // Optional: Method to get number of pending payments
    getPendingPaymentCount() {
        return this.pollingQueue.size;
    }

    // Handle Retry Exceeded
    async handleRetryExceeded(shiftId, error) {
        try {
            // Your processing logic here
        } catch (err) {
            if (this.verbose) console.error(`Error handleRetryExceeded ${shiftId} ${error}:`, err);
        }
    }



    // Handle completed payments
    async handleCompletedPayment(shiftData, paymentData, shiftId) {
        try {
            // Your processing logic here
            if (this.verbose) console.log(`Processing completed payment ${shiftId}`);
            const orderId = paymentData.orderId;
            if (paymentData.amount === shiftData.settleAmount && paymentData.wallet === shiftData.settleAddress) {
                await this.updateOrderStatus(orderId, 'completed', shiftId);
                if (this.verbose) console.log(`Successfully processed completed payment ${shiftId}`);
            } else {
                throw new Error(`Error processing completed payment ${shiftId}:`)
            }

        } catch (error) {
            if (this.verbose) console.error(error);
        }
    }

    // Handle failed payments
    async handleFailedPayment(shiftData, paymentData, shiftId) {
        try {
            // Your processing logic here
            if (this.verbose) console.log(`Processing failed payment ${shiftId}`);
            const orderId = paymentData.orderId;
            await this.updateOrderStatus(orderId, 'failed', shiftId);
            if (this.verbose) console.log(`Successfully processed failed payment ${shiftId}`);
        } catch (error) {
            if (this.verbose) console.error(`Error processing failed payment ${shiftId}:`, error);
        }
    }

    // Update your database with payment status
    async updateOrderStatus(orderId, status, shiftId) {
        // Your processing logic here
        if (status === "completed") {
            this.confirmCryptoPayment(orderId, shiftId); // demo way - do not use for production
            await this.sendPaymentConfirmation(orderId, shiftId);
        } else if (status === "failed") {
            await this.sendPaymentFailureNotification(orderId, shiftId);
            this.resetCryptoPayment(orderId, shiftId); // demo way - do not use for production
        } else {
            if (this.verbose) console.error(`Error updating order ${orderId} to status: ${status} - Shift ID: ${shiftId}`);
        }
        if (this.verbose) console.log(`Updated order ${orderId} to status: ${status} - Shift ID: ${shiftId}`);
    }

    // Send confirmation to customer
    async sendPaymentConfirmation(orderId, shiftId) {
        // Your notification logic here
        if (this.verbose) console.log(`Sent confirmation for order ${orderId}, shift ${shiftId}`);
    }

    // Send failure notification
    async sendPaymentFailureNotification(orderId, shiftId) {
        // Your notification logic here
        if (this.verbose) console.log(`Sent failure notification for order ${orderId}, shift ${shiftId}`);
    }

}

module.exports = PaymentPoller;
