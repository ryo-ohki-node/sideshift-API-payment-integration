class PaymentPoller {
    constructor({ shiftProcessor, intervalTimeout = 30000, resetCryptoPayment, confirmCryptoPayment }) {
        if (!shiftProcessor) throw new Error('Missing parameter "shiftProcessor". PaymentPoller need sideshift API access to run')
        this.shiftMapping = new Map();

        // Set initial Polling control
        this.isPolling = false;
        this.pollTimer = null;

        // Store active polling queue
        this.pollingQueue = new Set();

        // Set polling interval in ms, default to 2 minutes
        this.delay = Number(intervalTimeout);

        // setting sideshift API 
        this.shiftProcessor = shiftProcessor;

        // Use sideshift Verbose setting
        this.verbose = shiftProcessor.verbose;

        this.maxRetries = 3;

        // Quick demo way to update costumer data
        this.confirmCryptoPayment = confirmCryptoPayment;
        this.resetCryptoPayment = resetCryptoPayment;
    }

    // Add payment to tracking
    addPayment(shift, orderId, destWallet, amount) {
        if (!shift.id || !orderId || !destWallet || !amount) {
            throw new Error('Invalid parameters passed to addPayment');
        }
        if (this.verbose) console.log(`Adding payment ${shift.id} to polling`);

        // Store in your existing mapping structure
        this.shiftMapping.set(shift.id, {
            status: 'waiting',
            orderId: orderId,
            amount: amount,
            wallet: destWallet,
            shift: shift,
            timestamp: new Date(),
            lastChecked: null,
            retries: 0
        });

        // Add to polling queue
        this.pollingQueue.add(shift.id);

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

        if (activeShifts.length === 0) {
            if (this.verbose) console.log('No active payments to poll, stopping polling');
            this.stopPolling();
            return;
        }

        try {
            let bulkData;

            // Use single call for one shift, bulk for multiple shifts
            if (activeShifts.length === 1) {
                const shiftId = activeShifts[0];
                const data = await this.shiftProcessor.sideshift.getShift(shiftId);
                bulkData = [ data ]; // Wrap in array for consistent processing
            } else {
                bulkData = await this.shiftProcessor.sideshift.getBulkShifts(activeShifts);
            }

            // Map shiftId -> data for easier access
            const shiftMap = new Map(bulkData.map(shift => [shift.id, shift]));

            for (const shiftId of activeShifts) {
                const data = shiftMap.get(shiftId);
               
                if (!data) {
                    if (this.verbose) console.warn(`No data returned for shift ${shiftId}`);
                    continue;
                }

                const newStatus = data.status;

                if (this.verbose) console.log(`Payment ${shiftId} status: ${newStatus}`);

                if (this.shiftMapping.has(shiftId)) {
                    const paymentData = this.shiftMapping.get(shiftId);

                    // Only update if status changed
                    if (paymentData.status !== newStatus) {
                        if (this.verbose) console.log(`Status changed for ${shiftId}: ${paymentData.status} -> ${newStatus}`);

                        // Update local mapping
                        paymentData.shift = data;
                        paymentData.status = newStatus;
                        paymentData.lastChecked = new Date();

                        // Process completed payments
                        if (newStatus === 'settled') {
                            await this.handleCompletedPayment(data, paymentData);
                            this.pollingQueue.delete(shiftId); // Remove from polling
                            if (this.verbose) console.log(`Removed ${shiftId} from polling queue`);
                        } else if (newStatus === 'expired') {
                            await this.handleFailedPayment(data, paymentData);
                            this.pollingQueue.delete(shiftId); // Remove from polling
                            if (this.verbose) console.log(`Removed failed ${shiftId} from polling queue`);
                        }
                    }
                } else {
                    if (this.verbose) console.log(`Unknown ${shiftId} inside polling queue`);
                }
            }

        } catch (error) {
            if (this.verbose) console.error('Error during polling:', error);

            // Retry logic per shift
            for (const shiftId of activeShifts) {
                if (!this.shiftMapping.has(shiftId)) {
                    this.shiftMapping.set(shiftId, { status: 'unknown', lastChecked: new Date(), retries: 0 });
                }

                const paymentData = this.shiftMapping.get(shiftId);
                paymentData.retries += 1;

                if (this.verbose) console.log(`Retry count for ${shiftId}: ${paymentData.retries}`);

                if (paymentData.retries >= this.maxRetries) {
                    if (this.verbose)
                        console.warn(`Max retries (${this.maxRetries}) reached for ${shiftId}, removing from queue`);
                    this.pollingQueue.delete(shiftId);
                    await this.handleRetryExceeded(shiftId, error);
                }
            }
        }

        // Schedule next polling cycle only if there are still payments to check
        if (this.pollingQueue.size > 0) {
            this.pollTimer = setTimeout(() => {
                this.pollOnce();
            }, this.delay);
        } else {
            if (this.verbose) console.log('All payments processed, stopping polling');
            this.stopPolling();
        }
    }

    // Get polling data
    getPollingShiftData(shiftId) {
        // Check if shift exists in mapping
        if (!this.shiftMapping.has(shiftId)) {
            return null;
        }

        const data = this.shiftMapping.get(shiftId);

        // Validate that the shift is still in the polling queue
        const isInQueue = this.pollingQueue.has(shiftId);

        if (!isInQueue) {
            return null;
        }

        // Return a shallow copy of the data
        return { ...data };
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
    async handleCompletedPayment(shift, paymentData) {
        try {
            const shiftId = shift.id;
            // Your processing logic here
            if (this.verbose) console.log(`Processing completed payment ${shiftId}`);
            const orderId = paymentData.orderId;
            if (paymentData.amount === shift.settleAmount && paymentData.wallet === shift.settleAddress) {
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
    async handleFailedPayment(shift, paymentData) {
        try {
            const shiftId = shift.id;
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
